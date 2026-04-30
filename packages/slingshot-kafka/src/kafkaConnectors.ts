import { createHash, randomUUID } from 'node:crypto';
import { type Admin, type Consumer, Kafka, type KafkaMessage, type Producer } from 'kafkajs';
import { type ZodType, z } from 'zod';
import type {
  EventEnvelope,
  EventSchemaRegistry,
  EventSerializer,
  KafkaConnectorDropStats,
  KafkaConnectorHandle,
  KafkaConnectorHealth,
  KafkaInboundConnectorHealth,
  KafkaOutboundConnectorHealth,
  Logger,
  MetricsEmitter,
  SlingshotEventBus,
  ValidationMode,
} from '@lastshotlabs/slingshot-core';
import {
  JSON_SERIALIZER,
  createConsoleLogger,
  createNoopMetricsEmitter,
  sanitizeHeaderValue,
  sanitizeLogValue,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import {
  KafkaConnectorError,
  KafkaConnectorMessageIdError,
  KafkaConnectorStateError,
  KafkaConnectorValidationError,
  KafkaDuplicateConnectorError,
} from './errors';
import { getKafkaAdapterIntrospectionOrNull } from './kafkaAdapter';
import {
  COMPRESSION_CODEC,
  backoffMs,
  compressionSchema,
  saslSchema,
  sslSchema,
} from './kafkaShared';

const logger: Logger = createConsoleLogger({ base: { component: 'slingshot-kafka-connectors' } });

/**
 * Broker metadata attached to one inbound Kafka message after normalization.
 */
export interface InboundMessageMetadata {
  /** Topic the message was consumed from. */
  topic: string;
  /** Consumer group processing the message. */
  groupId: string;
  /** Kafka partition number. */
  partition: number;
  /** Kafka offset of the consumed record. */
  offset: string;
  /** Record key converted to a string when present. */
  key: string | null;
  /** Message headers converted to string values. */
  headers: Record<string, string>;
  /** Message payload size in bytes. */
  sizeBytes: number;
}

/**
 * Callback invoked for a normalized inbound Kafka message.
 */
export type InboundMessageHandler = (
  payload: unknown,
  metadata: InboundMessageMetadata,
) => void | Promise<void>;

/**
 * Optional transform applied before an inbound message reaches its handler.
 */
export type InboundTransform = (
  payload: unknown,
  metadata: InboundMessageMetadata,
) => unknown | Promise<unknown>;

/**
 * Envelope shape exposed to outbound connector hooks.
 *
 * Payload is intentionally `unknown` because connector transforms may project it
 * away from the original event schema before serialization.
 */
export type OutboundEnvelope = Readonly<{
  key: EventEnvelope['key'];
  payload: unknown;
  meta: EventEnvelope['meta'];
}>;

/** Predicate that decides whether an outbound event should be published. */
export type OutboundFilter = (envelope: OutboundEnvelope) => boolean | Promise<boolean>;
/** Transform applied to an outbound event payload before serialization. */
export type OutboundTransform = (envelope: OutboundEnvelope) => unknown | Promise<unknown>;
/** Hook that can add or replace Kafka headers for outbound publishes. */
export type OutboundHeaderEnricher = (
  defaults: Record<string, string>,
  envelope: OutboundEnvelope,
) => Record<string, string>;
/** Resolve a stable message identifier for dedupe or trace correlation. */
export type OutboundMessageIdExtractor = (envelope: OutboundEnvelope) => string | null;
/** Resolve the Kafka partition key for an outbound publish. */
export type OutboundPartitionKeyExtractor = (envelope: OutboundEnvelope) => string | null;

/**
 * Pluggable consumer-side dedup store keyed by `slingshot.message-id` header.
 *
 * Implementations may live in Redis, Memcached, or any TTL-aware store. The
 * connector calls `has()` before invoking the inbound handler and `set()` after
 * successful processing. A default in-memory LRU is used when none is provided.
 */
export interface MessageDedupStore {
  /** Resolve `true` if the message id has already been processed. */
  has(id: string): Promise<boolean>;
  /** Mark the message id as processed for at least the given TTL. */
  set(id: string, ttlMs: number): Promise<void>;
}

/**
 * Optional observability hooks for the connector bridge.
 */
export interface ConnectorObservabilityHooks {
  /** Called after an inbound handler succeeds. */
  onInboundSuccess?(
    topic: string,
    groupId: string,
    durationMs: number,
    metadata: InboundMessageMetadata,
  ): void;
  /** Called when inbound decode, validation, or handler processing fails. */
  onInboundError?(topic: string, groupId: string, error: unknown): void;
  /** Called after a failed inbound message is published to a DLQ. */
  onInboundDLQ?(topic: string, dlqTopic: string, metadata: InboundMessageMetadata): void;
  /** Called after an outbound event is published successfully. */
  onOutboundSuccess?(event: string, topic: string, durationMs: number): void;
  /** Called when outbound publication fails. */
  onOutboundError?(event: string, topic: string, error: unknown): void;
  /** Called when an outbound event is intentionally suppressed. */
  onOutboundSuppressed?(
    event: string,
    topic: string,
    reason: 'filter' | 'transform-null' | 'validation' | 'not-exposed',
  ): void;
  /**
   * Called when an outbound message is dropped because the pending buffer
   * is full or its retry budget was exhausted. Use this to emit metrics
   * so silent overflow is observable.
   */
  onOutboundDrop?(
    event: string,
    topic: string,
    reason: 'pending-buffer-full' | 'pending-attempts-exhausted',
    error: unknown,
  ): void;
}

const inboundConnectorSchema = z.object({
  topic: z.string().optional().describe('Exact Kafka topic name to consume from'),
  topicPattern: z
    .string()
    .optional()
    .describe('Regex pattern matching one or more Kafka topics to consume from'),
  handler: z
    .custom<InboundMessageHandler>(value => typeof value === 'function')
    .describe('Callback invoked for each normalized inbound Kafka message'),
  groupId: z.string().describe('Kafka consumer group ID for this inbound connector'),
  fromBeginning: z
    .boolean()
    .optional()
    .describe('Whether to start reading from the earliest available offset for a new group'),
  deduplicate: z
    .boolean()
    .optional()
    .describe(
      'Whether this inbound connector applies message-id based deduplication. Defaults to true when global dedup is enabled.',
    ),
  errorStrategy: z
    .enum(['dlq', 'skip', 'pause'])
    .optional()
    .describe(
      'How to handle handler errors: dlq routes to a dead-letter topic, skip commits and continues, pause stops the consumer',
    ),
  dlqTopic: z
    .string()
    .optional()
    .describe('Custom dead-letter topic name; defaults to ${topic}.dlq when errorStrategy is dlq'),
  maxRetries: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Maximum handler retry attempts before applying the error strategy'),
  sessionTimeout: z
    .number()
    .int()
    .min(6000)
    .optional()
    .describe('Consumer session timeout in milliseconds for this connector'),
  heartbeatInterval: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe('Heartbeat interval in milliseconds for this connector consumer'),
  validationMode: z
    .enum(['strict', 'warn', 'off'])
    .optional()
    .describe('Payload validation mode for inbound messages against the provided schema'),
  concurrency: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Number of messages processed concurrently within this consumer'),
  schema: z
    .custom<ZodType>(value => !!value && typeof value === 'object')
    .optional()
    .describe('Zod schema used to validate inbound message payloads'),
  autoCreateDLQ: z
    .boolean()
    .optional()
    .describe('Whether to automatically create the dead-letter topic if it does not exist'),
  transform: z
    .custom<InboundTransform>(value => typeof value === 'function')
    .optional()
    .describe('Transform applied to inbound message payloads before reaching the handler'),
  serializer: z
    .custom<EventSerializer>(
      value =>
        !!value &&
        typeof value === 'object' &&
        'serialize' in value &&
        'deserialize' in value &&
        'contentType' in value,
    )
    .optional()
    .describe('Custom serializer for deserializing inbound message payloads'),
});

const outboundConnectorSchema = z.object({
  event: z.string().describe('Slingshot event name that triggers this outbound publish'),
  topic: z.string().describe('Kafka topic to publish the event to'),
  durable: z
    .boolean()
    .optional()
    .describe('Whether to use a durable event bus subscription for this connector'),
  name: z
    .string()
    .optional()
    .describe('Unique name for this outbound connector, used in metrics and logs'),
  filter: z
    .custom<OutboundFilter>(value => typeof value === 'function')
    .optional()
    .describe('Predicate that decides whether an outbound event should be published'),
  transform: z
    .custom<OutboundTransform>(value => typeof value === 'function')
    .optional()
    .describe('Transform applied to the outbound event payload before serialization'),
  serializer: z
    .custom<EventSerializer>(
      value =>
        !!value &&
        typeof value === 'object' &&
        'serialize' in value &&
        'deserialize' in value &&
        'contentType' in value,
    )
    .optional()
    .describe('Custom serializer for encoding outbound message payloads'),
  headers: z
    .custom<OutboundHeaderEnricher>(value => typeof value === 'function')
    .optional()
    .describe('Hook that can add or replace Kafka headers for outbound publishes'),
  schema: z
    .custom<ZodType>(value => !!value && typeof value === 'object')
    .optional()
    .describe('Zod schema used to validate outbound event payloads before publishing'),
  validationMode: z
    .enum(['strict', 'warn', 'off'])
    .optional()
    .describe('Payload validation mode for outbound messages against the provided schema'),
  partitionKey: z
    .union([
      z.string(),
      z.custom<OutboundPartitionKeyExtractor>(value => typeof value === 'function'),
    ])
    .optional()
    .describe('Static string or function resolving the Kafka partition key for outbound messages'),
  messageId: z
    .union([z.string(), z.custom<OutboundMessageIdExtractor>(value => typeof value === 'function')])
    .optional()
    .describe(
      'Static string or function resolving a stable message identifier for dedup or trace correlation',
    ),
  compression: compressionSchema
    .optional()
    .describe('Compression codec applied to outbound messages'),
  autoCreateTopic: z
    .boolean()
    .optional()
    .describe('Whether to automatically create the target topic if it does not exist'),
  partitions: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Number of partitions when auto-creating the target topic'),
  replicationFactor: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Replication factor when auto-creating the target topic'),
});

/**
 * Zod schema for the programmatic Kafka connector bridge configuration.
 */
export const kafkaConnectorsSchema = z.object({
  brokers: z
    .array(z.string())
    .min(1)
    .describe('List of Kafka broker addresses for the connector bridge'),
  clientId: z
    .string()
    .optional()
    .describe('Kafka client identifier for this connector bridge instance'),
  sasl: saslSchema
    .optional()
    .describe('SASL authentication configuration for the connector Kafka connection'),
  ssl: sslSchema.optional().describe('TLS/SSL configuration for the connector Kafka connection'),
  serializer: z
    .custom<EventSerializer>(
      value =>
        !!value &&
        typeof value === 'object' &&
        'serialize' in value &&
        'deserialize' in value &&
        'contentType' in value,
    )
    .optional()
    .describe('Default serializer used for all connectors unless overridden per connector'),
  compression: compressionSchema
    .optional()
    .describe('Default compression codec applied to produced messages across all connectors'),
  validationMode: z
    .enum(['strict', 'warn', 'off'])
    .optional()
    .describe('Default payload validation mode applied to all connectors unless overridden'),
  duplicatePublishPolicy: z
    .enum(['off', 'warn', 'error'])
    .optional()
    .describe(
      'Policy when multiple outbound connectors publish the same event: off allows it, warn logs, error throws',
    ),
  inbound: z
    .array(inboundConnectorSchema)
    .optional()
    .describe('Array of inbound connector definitions consuming from Kafka topics'),
  outbound: z
    .array(outboundConnectorSchema)
    .optional()
    .describe(
      'Array of outbound connector definitions publishing Slingshot events to Kafka topics',
    ),
  hooks: z
    .custom<ConnectorObservabilityHooks>(value => !!value && typeof value === 'object')
    .optional()
    .describe('Observability hooks for monitoring inbound and outbound connector activity'),
  schemaRegistry: z
    .custom<EventSchemaRegistry>(
      value => !!value && typeof value === 'object' && 'validate' in value,
    )
    .optional()
    .describe(
      'Pluggable schema registry for validating message payloads against registered schemas',
    ),
  maxPendingBuffer: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Maximum number of outbound messages held in the in-memory pending buffer before dropping',
    ),
  maxProduceAttempts: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Maximum number of produce attempts before a buffered outbound message is dropped'),
  drainIntervalMs: z
    .number()
    .int()
    .min(500)
    .optional()
    .describe('Interval in milliseconds between pending buffer drain attempts'),
  /**
   * Optional consumer-side dedup store for inbound messages keyed by their
   * `slingshot.message-id` header. When omitted, an in-memory LRU is used
   * (max 10000 keys, 1h TTL). Use a shared external store across replicas
   * to dedup at the consumer-group level.
   */
  dedupStore: z
    .custom<MessageDedupStore>(
      value => !!value && typeof value === 'object' && 'has' in value && 'set' in value,
      'dedupStore must implement { has(id), set(id, ttlMs) }',
    )
    .optional()
    .describe(
      'Consumer-side dedup store for inbound messages keyed by slingshot.message-id header; defaults to in-memory LRU',
    ),
  /** Override the default inbound dedup TTL (1h). Set to 0 to disable dedup. */
  dedupTtlMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Override the default inbound dedup TTL (1h); set to 0 to disable dedup'),
  /**
   * Strategy when an outbound envelope lacks a configured `messageId`
   * extractor / field AND `envelope.meta.eventId` is empty.
   *
   * - `'fingerprint'` (default): SHA-256 of the serialized payload, hex
   *   prefixed with `sha256:`. Stable across retries, dedupable.
   * - `'random'`: legacy `randomUUID()`. Logs a warning so operators see
   *   that dedup is effectively off for that event.
   * - `'reject'`: throws — useful when callers require strict provenance
   *   and would rather fail produce than emit a non-deduplicable id.
   */
  onIdMissing: z
    .enum(['fingerprint', 'random', 'reject'])
    .optional()
    .describe(
      'How to derive a message id when the outbound envelope lacks one: fingerprint hashes the payload, random uses UUID, reject throws',
    ),
});

/**
 * Top-level configuration accepted by {@link createKafkaConnectors}.
 */
export type KafkaConnectorsConfig = z.infer<typeof kafkaConnectorsSchema>;
/**
 * One inbound Kafka topic or topic-pattern consumer definition.
 */
export type InboundConnectorConfig = z.infer<typeof inboundConnectorSchema>;
/**
 * One outbound Slingshot-event to Kafka-topic publish definition.
 */
export type OutboundConnectorConfig = z.infer<typeof outboundConnectorSchema>;
/**
 * Policy applied when an outbound connector duplicates the Kafka adapter topic mapping.
 */
export type DuplicatePublishPolicy = NonNullable<KafkaConnectorsConfig['duplicatePublishPolicy']>;

interface PendingProduceEntry {
  topic: string;
  event: string;
  messageId: string;
  serialized: Uint8Array;
  key: string | null;
  headers: Record<string, string>;
  attempts: number;
  compression?: OutboundConnectorConfig['compression'];
}

interface InboundRuntime {
  consumer: Consumer;
  config: InboundConnectorConfig;
  health: MutableKafkaInboundConnectorHealth;
}

interface OutboundRuntime {
  config: OutboundConnectorConfig;
  listener: (envelope: EventEnvelope) => void;
  health: MutableKafkaOutboundConnectorHealth;
}

type MutableKafkaInboundConnectorHealth = {
  -readonly [K in keyof KafkaInboundConnectorHealth]: KafkaInboundConnectorHealth[K];
};

type MutableKafkaOutboundConnectorHealth = {
  -readonly [K in keyof KafkaOutboundConnectorHealth]: KafkaOutboundConnectorHealth[K];
};

function headersToStrings(headers: KafkaMessage['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    result[key] = Buffer.isBuffer(value) ? value.toString() : String(value);
  }
  return result;
}

function resolveSerializer(
  perConnector: EventSerializer | undefined,
  topLevel: EventSerializer | undefined,
): EventSerializer {
  return perConnector ?? topLevel ?? JSON_SERIALIZER;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join(', ');
}

function errToString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function validatePayload(
  event: string,
  payload: unknown,
  mode: ValidationMode,
  schema: ZodType | undefined,
  registry: EventSchemaRegistry | undefined,
): unknown {
  const effectiveSchema = schema ?? registry?.get(event);
  if (!effectiveSchema || mode === 'off') return payload;

  const result = effectiveSchema.safeParse(payload);
  if (result.success) return result.data;

  const message = `[KafkaConnectors] validation failed for "${event}": ${formatZodIssues(result.error)}`;
  if (mode === 'strict') {
    throw new KafkaConnectorValidationError(message, result.error);
  }
  logger.warn(message);
  return payload;
}

function resolvePartitionKey(
  config: OutboundConnectorConfig,
  envelope: OutboundEnvelope,
  payload: unknown,
): string | null {
  if (!config.partitionKey) return null;
  if (typeof config.partitionKey === 'function') {
    return config.partitionKey(envelope);
  }
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[config.partitionKey];
  return value == null ? null : String(value);
}

function resolveMessageId(
  config: OutboundConnectorConfig,
  envelope: OutboundEnvelope,
  payload: unknown,
  serializedBody: Uint8Array | undefined,
  onIdMissing: 'fingerprint' | 'random' | 'reject',
): string {
  if (typeof config.messageId === 'function') {
    const resolved = config.messageId(envelope);
    if (resolved) return String(resolved);
  } else if (typeof config.messageId === 'string' && payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)[config.messageId];
    if (value != null && String(value).trim() !== '') {
      return String(value);
    }
  }
  if (envelope.meta.eventId) return envelope.meta.eventId;
  // P-KAFKA-10: fallback strategy. Random UUIDs are never dedup'd by the
  // consumer-side store because every produce produces a fresh id, so the
  // default switches to a stable SHA-256 fingerprint of the payload bytes.
  if (onIdMissing === 'reject') {
    throw new KafkaConnectorMessageIdError(envelope.key);
  }
  if (onIdMissing === 'random') {
    logger.warn(
      `[KafkaConnectors] outbound event "${envelope.key}" falling back to randomUUID() — consumer-side dedup is effectively disabled for this message. Configure messageId or set onIdMissing='fingerprint'.`,
    );
    return randomUUID();
  }
  // 'fingerprint' (default).
  if (serializedBody && serializedBody.byteLength > 0) {
    return `sha256:${createHash('sha256').update(serializedBody).digest('hex')}`;
  }
  // No serialized bytes available (e.g. transform produced null) — fall
  // back to UUID rather than fingerprinting an empty string.
  return randomUUID();
}

function createOutboundEnvelope(envelope: OutboundEnvelope, payload: unknown): OutboundEnvelope {
  return Object.freeze({
    key: envelope.key,
    payload,
    meta: envelope.meta,
  });
}

function buildOutboundHeaders(
  envelope: OutboundEnvelope,
  serializerContentType: string,
  messageId: string,
): Record<string, string> {
  // Defense-in-depth: every value here is framework-derived (event-key
  // template literal, UUID, plugin name, tenantId from a resolved scope),
  // but a misconfigured event registration or a buggy upstream resolver
  // could still leak CR/LF into one of these fields. Sanitize so the
  // resulting Kafka headers cannot smuggle header-splitting bytes into
  // downstream HTTP-bridged consumers; rejection surfaces as a thrown
  // HeaderInjectionError caught by the surrounding produce path.
  const headers: Record<string, string> = {
    'slingshot.event': sanitizeHeaderValue(String(envelope.key), 'slingshot.event'),
    'slingshot.event-id': sanitizeHeaderValue(envelope.meta.eventId, 'slingshot.event-id'),
    'slingshot.owner-plugin': sanitizeHeaderValue(
      envelope.meta.ownerPlugin,
      'slingshot.owner-plugin',
    ),
    'slingshot.exposure': sanitizeHeaderValue(
      envelope.meta.exposure.join(','),
      'slingshot.exposure',
    ),
    'slingshot.content-type': sanitizeHeaderValue(serializerContentType, 'slingshot.content-type'),
    'slingshot.message-id': sanitizeHeaderValue(messageId, 'slingshot.message-id'),
  };
  if (envelope.meta.scope?.tenantId) {
    headers['slingshot.tenant-id'] = sanitizeHeaderValue(
      envelope.meta.scope.tenantId,
      'slingshot.tenant-id',
    );
  }
  return headers;
}

async function waitWithHeartbeat(heartbeat: () => Promise<void>, delayMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < delayMs) {
    const remaining = delayMs - (Date.now() - started);
    await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 1_000)));
    await heartbeat();
  }
}

const DEFAULT_DEDUP_MAX_KEYS = 10_000;
const DEFAULT_DEDUP_TTL_MS = 60 * 60 * 1_000;

/**
 * Build a default in-memory LRU `MessageDedupStore` with TTL eviction.
 *
 * Each `set()` records a timestamp and the access order is refreshed by `has()`
 * lookups. Stale entries past their TTL are treated as misses; cold entries are
 * evicted when the cache exceeds `maxKeys`.
 */
export function createInMemoryDedupStore(options: { maxKeys?: number } = {}): MessageDedupStore {
  const maxKeys = options.maxKeys ?? DEFAULT_DEDUP_MAX_KEYS;
  // Map iteration preserves insertion order — re-set on access for LRU.
  const entries = new Map<string, { expiresAt: number }>();

  return {
    async has(id: string): Promise<boolean> {
      const record = entries.get(id);
      if (!record) return false;
      if (record.expiresAt > 0 && record.expiresAt < Date.now()) {
        entries.delete(id);
        return false;
      }
      // Refresh recency.
      entries.delete(id);
      entries.set(id, record);
      return true;
    },
    async set(id: string, ttlMs: number): Promise<void> {
      const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
      entries.delete(id);
      entries.set(id, { expiresAt });
      while (entries.size > maxKeys) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

/**
 * Create a programmatic bridge between the Slingshot event bus and Kafka topics.
 *
 * Inbound connectors consume Kafka messages into handlers. Outbound connectors
 * subscribe to Slingshot events and publish them to Kafka with buffering and
 * duplicate-produce safeguards.
 */
export function createKafkaConnectors(
  rawOpts: KafkaConnectorsConfig & {
    /**
     * Optional metrics sink. When provided, the connector records publish /
     * consume / dlq counters and durations alongside the existing
     * observability hooks. Defaults to a no-op emitter.
     */
    metrics?: MetricsEmitter;
  },
): KafkaConnectorHandle {
  const { metrics: metricsOpt, ...connectorOpts } = rawOpts;
  const metrics: MetricsEmitter = metricsOpt ?? createNoopMetricsEmitter();
  const opts = validatePluginConfig(
    'slingshot-kafka-connectors',
    connectorOpts,
    kafkaConnectorsSchema,
  );

  opts.inbound?.forEach((conn, i) => {
    const hasTopic = !!conn.topic;
    const hasPattern = !!conn.topicPattern;
    if (hasTopic === hasPattern) {
      throw new KafkaConnectorError(
        `[slingshot-kafka-connectors] inbound[${i}]: exactly one of "topic" or "topicPattern" is required`,
      );
    }
    const session = conn.sessionTimeout ?? 30_000;
    const heartbeat = conn.heartbeatInterval ?? 3_000;
    if (heartbeat >= session) {
      throw new KafkaConnectorError(
        `[slingshot-kafka-connectors] inbound[${i}]: heartbeatInterval must be less than sessionTimeout`,
      );
    }
    if (conn.topicPattern) {
      new RegExp(conn.topicPattern);
    }
    if (conn.dlqTopic && (conn.errorStrategy ?? 'dlq') !== 'dlq') {
      throw new KafkaConnectorError(
        `[slingshot-kafka-connectors] inbound[${i}]: dlqTopic requires errorStrategy "dlq"`,
      );
    }
    if (conn.autoCreateDLQ && (conn.errorStrategy ?? 'dlq') !== 'dlq') {
      throw new KafkaConnectorError(
        `[slingshot-kafka-connectors] inbound[${i}]: autoCreateDLQ is only meaningful when errorStrategy is "dlq"`,
      );
    }
  });

  opts.outbound?.forEach((conn, i) => {
    if (conn.durable && !conn.name) {
      throw new KafkaConnectorError(
        `[slingshot-kafka-connectors] outbound[${i}]: durable: true requires a "name"`,
      );
    }
  });

  const inboundKeys = new Set<string>();
  for (const conn of opts.inbound ?? []) {
    const key = `${conn.topic ?? `pattern:${conn.topicPattern}`}:${conn.groupId}`;
    if (inboundKeys.has(key)) {
      throw new KafkaDuplicateConnectorError(`inbound: ${key}`);
    }
    inboundKeys.add(key);
  }

  const outboundKeys = new Set<string>();
  for (const conn of opts.outbound ?? []) {
    const key = `${conn.event}:${conn.topic}`;
    if (outboundKeys.has(key)) {
      throw new KafkaDuplicateConnectorError(`outbound: ${key}`);
    }
    outboundKeys.add(key);
  }

  const kafka = new Kafka({
    clientId: opts.clientId ?? 'slingshot-kafka-connectors',
    brokers: opts.brokers,
    ...(opts.sasl ? { sasl: opts.sasl } : {}),
    ...(opts.ssl != null ? { ssl: opts.ssl } : {}),
  });

  const maxPendingBuffer = opts.maxPendingBuffer ?? 1_000;
  const maxProduceAttempts = opts.maxProduceAttempts ?? 5;
  const validationMode = opts.validationMode ?? 'strict';
  const duplicatePublishPolicy = opts.duplicatePublishPolicy ?? 'warn';
  const hooks = opts.hooks;

  let producer: Producer | null = null;
  let admin: Admin | null = null;
  /**
   * P-KAFKA-15: explicit lifecycle state machine.
   *
   * Transitions:
   *   idle      -> starting -> running -> stopping -> stopped
   *   starting  -> stopped (on start() rejection)
   *
   * `start()` rejects unless state is `idle` or `stopped` so a second
   * `start()` before `stop()` cannot leave duplicate listeners. `stop()`
   * rejects unless state is `running` so callers see a clear error rather
   * than silently no-op'ing on a never-started instance.
   */
  type ConnectorState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';
  let state: ConnectorState = 'idle';
  let boundBus: SlingshotEventBus | null = null;
  let drainTimer: ReturnType<typeof setInterval> | null = null;

  const inboundRuntimes: InboundRuntime[] = [];
  const outboundRuntimes: OutboundRuntime[] = [];
  const pendingBuffer: PendingProduceEntry[] = [];
  const pendingCountByTopic = new Map<string, number>();
  /** entryKey -> Map<topic|partition, nextOffset> pending commit on rebalance. */
  const pendingCommitOffsetsByConsumer = new Map<number, Map<string, string>>();
  /** entryKey -> Set of in-flight handler promises, awaited during rebalance. */
  const inFlightByConsumer = new Map<number, Set<Promise<void>>>();
  /** Track which consumers are mid-rebalance (best-effort). */
  const rebalancingConsumers = new Set<number>();

  const dedupStore: MessageDedupStore = opts.dedupStore ?? createInMemoryDedupStore();
  const dedupTtlMs = opts.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS;
  const dedupEnabled = dedupTtlMs > 0;

  let dropTotal = 0;
  let dropBufferFull = 0;
  let dropAttemptsExhausted = 0;
  let inboundDeduped = 0;
  let lastDropAt: number | null = null;
  function recordDrop(reason: 'pending-buffer-full' | 'pending-attempts-exhausted'): void {
    dropTotal += 1;
    lastDropAt = Date.now();
    if (reason === 'pending-buffer-full') dropBufferFull += 1;
    else dropAttemptsExhausted += 1;
  }

  if (opts.sasl && !opts.ssl) {
    logger.warn(
      '[KafkaConnectors] SASL configured without SSL. Credentials will travel in plaintext.',
    );
  }
  if (opts.ssl && opts.ssl !== true && opts.ssl.rejectUnauthorized === false) {
    logger.warn(
      '[KafkaConnectors] ssl.rejectUnauthorized=false disables broker certificate verification. ' +
        'Use only for local development or controlled test environments.',
    );
  }

  async function ensureProducer(): Promise<Producer> {
    if (producer) return producer;
    const nextProducer = kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: true,
      maxInFlightRequests: 5,
    });
    try {
      await nextProducer.connect();
      producer = nextProducer;
      return nextProducer;
    } catch (err) {
      producer = null;
      throw err;
    }
  }

  async function ensureAdmin(): Promise<Admin> {
    if (admin) return admin;
    const nextAdmin = kafka.admin();
    try {
      await nextAdmin.connect();
      admin = nextAdmin;
      return nextAdmin;
    } catch (err) {
      admin = null;
      throw err;
    }
  }

  async function ensureTopics(
    topics: Array<{ topic: string; numPartitions?: number; replicationFactor?: number }>,
  ): Promise<void> {
    if (topics.length === 0) return;
    const ensuredAdmin = await ensureAdmin();
    // KafkaJS resolves `false` when a topic already exists; other failures should surface.
    await ensuredAdmin.createTopics({ topics });
  }

  function enforceDuplicatePublishPolicy(bus: SlingshotEventBus): void {
    if (duplicatePublishPolicy === 'off') return;
    const introspection = getKafkaAdapterIntrospectionOrNull(bus);
    if (!introspection) return;

    for (const conn of opts.outbound ?? []) {
      const adapterTopic = introspection.topicNameForEvent(conn.event);
      if (adapterTopic !== conn.topic) continue;
      const message =
        `[slingshot-kafka-connectors] outbound connector for event "${conn.event}" targets ` +
        `topic "${conn.topic}", which is also produced by the internal Kafka event bus adapter.`;
      if (duplicatePublishPolicy === 'error') {
        throw new KafkaConnectorError(message);
      }
      logger.warn(message);
    }
  }

  /**
   * Phases an inbound message can fail at, propagated to DLQ headers and the
   * payload envelope so downstream consumers can distinguish corrupt messages
   * (deserialize / validate failures — never retried) from handler logic bugs.
   */
  type InboundErrorType = 'deserialize' | 'validate' | 'handler';

  async function produceToDlq(
    config: InboundConnectorConfig,
    metadata: InboundMessageMetadata,
    rawMessage: KafkaMessage,
    error: unknown,
    errorType: InboundErrorType,
  ): Promise<void> {
    const dlqTopic = config.dlqTopic ?? `${metadata.topic}.dlq`;
    metrics.counter('kafka.dlq.count', 1, { topic: metadata.topic, errorType });
    const ensuredProducer = await ensureProducer();
    if (config.autoCreateDLQ) {
      await ensureTopics([{ topic: dlqTopic }]);
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    // The error message frequently embeds upstream payload fragments and
    // can therefore carry CR/LF if the upstream code threw with
    // user-controlled text. Strip control characters so a downstream
    // HTTP-bridged consumer cannot have its headers split. Use
    // sanitizeLogValue (escapes rather than throws) so DLQ persistence
    // never fails due to a hostile error message.
    await ensuredProducer.send({
      topic: dlqTopic,
      messages: [
        {
          key: metadata.key ?? undefined,
          value: rawMessage.value ? Buffer.from(rawMessage.value) : null,
          headers: {
            'slingshot.original-topic': sanitizeLogValue(metadata.topic),
            'slingshot.original-partition': String(metadata.partition),
            'slingshot.original-offset': sanitizeLogValue(metadata.offset),
            'slingshot.error': sanitizeLogValue(errorMessage),
            'slingshot.error-type': errorType,
            'x-slingshot-dlq-reason': errorType,
          },
        },
      ],
    });
    hooks?.onInboundDLQ?.(metadata.topic, dlqTopic, metadata);
  }

  /**
   * Try to publish a message to the DLQ and only commit the offset on success.
   *
   * If the DLQ produce fails we deliberately do NOT commit — the broker will
   * redeliver the message on the next poll, which is the only way an operator
   * can recover from a persistent DLQ outage. To avoid an infinite loop on a
   * permanently broken DLQ the caller's `errorStrategy === 'skip'` already
   * commits without going through this function.
   */
  async function dlqAndCommitOrSkip(
    config: InboundConnectorConfig,
    runtime: InboundRuntime,
    metadata: InboundMessageMetadata,
    rawMessage: KafkaMessage,
    error: unknown,
    errorType: 'deserialize' | 'validate' | 'handler',
    topic: string,
    partition: number,
    trackedCommit: (tt: string, p: number, m: KafkaMessage) => Promise<void>,
  ): Promise<void> {
    const strategy = config.errorStrategy ?? 'dlq';
    if (strategy !== 'dlq') {
      // 'skip' commits unconditionally; 'pause' is handled by the caller.
      await trackedCommit(topic, partition, rawMessage);
      return;
    }
    try {
      await produceToDlq(config, metadata, rawMessage, error, errorType);
      runtime.health.messagesDLQ += 1;
      await trackedCommit(topic, partition, rawMessage);
    } catch (dlqErr) {
      // Do NOT commit. Broker will redeliver and we'll retry the DLQ produce
      // on the next poll. If the DLQ outage is persistent the consumer will
      // continue to redeliver; operators should observe via health() and
      // the `onInboundError` hook, then either fix the DLQ or temporarily
      // switch to errorStrategy: 'skip'.
      logger.error(
        '[KafkaConnectors] failed to publish to DLQ; leaving offset uncommitted for redelivery',
        {
          topic,
          groupId: config.groupId,
          partition,
          offset: rawMessage.offset,
          errorType,
          dlqError: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
        },
      );
    }
  }

  async function drainPendingBuffer(): Promise<void> {
    if (!producer || pendingBuffer.length === 0) return;

    const entries = pendingBuffer.splice(0, pendingBuffer.length);
    pendingCountByTopic.clear();
    const retry: PendingProduceEntry[] = [];

    for (const entry of entries) {
      try {
        await producer.send({
          topic: entry.topic,
          compression: entry.compression
            ? COMPRESSION_CODEC[entry.compression]
            : opts.compression
              ? COMPRESSION_CODEC[opts.compression]
              : undefined,
          messages: [
            {
              key: entry.key ?? undefined,
              value: Buffer.from(entry.serialized),
              headers: entry.headers,
            },
          ],
        });
        hooks?.onOutboundSuccess?.(entry.event, entry.topic, 0);
      } catch (err) {
        entry.attempts += 1;
        if (entry.attempts < maxProduceAttempts) {
          retry.push(entry);
          pendingCountByTopic.set(entry.topic, (pendingCountByTopic.get(entry.topic) ?? 0) + 1);
        } else {
          recordDrop('pending-attempts-exhausted');
          hooks?.onOutboundError?.(entry.event, entry.topic, err);
          hooks?.onOutboundDrop?.(entry.event, entry.topic, 'pending-attempts-exhausted', err);
          logger.error(
            `[KafkaConnector:outbound] permanently dropping message for topic "${entry.topic}" ` +
              `after ${entry.attempts} attempts:`,
            { err: errToString(err) },
          );
        }
      }
    }

    pendingBuffer.push(...retry);
    for (const runtime of outboundRuntimes) {
      runtime.health.pendingCount = pendingCountByTopic.get(runtime.config.topic) ?? 0;
    }
    metrics.gauge('kafka.pending.size', pendingBuffer.length);
  }

  async function produceOutbound(
    config: OutboundConnectorConfig,
    envelope: EventEnvelope,
    runtime: OutboundRuntime,
  ): Promise<void> {
    const startMs = Date.now();
    let pendingEntry: Omit<PendingProduceEntry, 'attempts'> | null = null;
    try {
      if (!envelope.meta.exposure.includes('connector')) {
        hooks?.onOutboundSuppressed?.(config.event, config.topic, 'not-exposed');
        return;
      }

      if (config.filter) {
        const keep = await Promise.resolve(config.filter(envelope));
        if (!keep) {
          hooks?.onOutboundSuppressed?.(config.event, config.topic, 'filter');
          return;
        }
      }

      let transformed: unknown = envelope.payload;
      if (config.transform) {
        transformed = await Promise.resolve(config.transform(envelope));
        if (transformed == null) {
          hooks?.onOutboundSuppressed?.(config.event, config.topic, 'transform-null');
          return;
        }
      }

      const effectiveValidationMode = config.validationMode ?? validationMode;
      try {
        transformed = validatePayload(
          config.event,
          transformed,
          effectiveValidationMode,
          config.schema,
          opts.schemaRegistry,
        );
      } catch (err) {
        hooks?.onOutboundSuppressed?.(config.event, config.topic, 'validation');
        throw err;
      }

      const outboundEnvelope = createOutboundEnvelope(envelope, transformed);
      const serializer = resolveSerializer(config.serializer, opts.serializer);
      const key = resolvePartitionKey(config, envelope, transformed);
      const serialized = serializer.serialize(config.event, outboundEnvelope);
      const messageId = resolveMessageId(
        config,
        envelope,
        transformed,
        serialized,
        opts.onIdMissing ?? 'fingerprint',
      );

      let messageHeaders = buildOutboundHeaders(
        outboundEnvelope,
        serializer.contentType,
        messageId,
      );
      if (config.headers) {
        const enriched = config.headers(messageHeaders, outboundEnvelope);
        // The enricher is user-supplied — re-sanitize its return value so
        // a buggy or hostile callback cannot inject CR/LF/NUL into header
        // values and smuggle header-splitting bytes into downstream
        // HTTP-bridged consumers.
        messageHeaders = Object.fromEntries(
          Object.entries(enriched).map(([k, v]) => [k, sanitizeHeaderValue(v, k)]),
        );
      }
      // Re-apply the framework-controlled headers last so a user-supplied
      // enricher cannot override identity/provenance fields. All values
      // are sanitized inside buildOutboundHeaders; the explicit overrides
      // mirror those guarantees.
      messageHeaders = {
        ...messageHeaders,
        ...buildOutboundHeaders(outboundEnvelope, serializer.contentType, messageId),
      };
      pendingEntry = {
        topic: config.topic,
        event: config.event,
        messageId,
        serialized,
        key,
        headers: messageHeaders,
        compression: config.compression,
      };

      const ensuredProducer = await ensureProducer();
      await ensuredProducer.send({
        topic: config.topic,
        compression: config.compression
          ? COMPRESSION_CODEC[config.compression]
          : opts.compression
            ? COMPRESSION_CODEC[opts.compression]
            : undefined,
        messages: [
          {
            key: key ?? undefined,
            value: Buffer.from(serialized),
            headers: messageHeaders,
          },
        ],
      });

      runtime.health.messagesProduced += 1;
      runtime.health.status = 'active';
      runtime.health.error = undefined;
      metrics.counter('kafka.publish.count', 1, { topic: config.topic, result: 'success' });
      metrics.timing('kafka.publish.duration', Date.now() - startMs, { topic: config.topic });
      hooks?.onOutboundSuccess?.(config.event, config.topic, Date.now() - startMs);
    } catch (err) {
      metrics.counter('kafka.publish.count', 1, { topic: config.topic, result: 'failure' });
      hooks?.onOutboundError?.(config.event, config.topic, err);
      runtime.health.status = 'error';
      runtime.health.error = err instanceof Error ? err.message : String(err);

      if (!pendingEntry) {
        return;
      }
      if (pendingBuffer.length >= maxPendingBuffer) {
        recordDrop('pending-buffer-full');
        logger.error(
          `[KafkaConnector:outbound] pending buffer full; dropping message for topic "${config.topic}" ` +
            `(buffer=${pendingBuffer.length}/${maxPendingBuffer}, totalDrops=${dropTotal})`,
          { err: errToString(err) },
        );
        hooks?.onOutboundDrop?.(config.event, config.topic, 'pending-buffer-full', err);
        return;
      }

      pendingBuffer.push({
        ...pendingEntry,
        attempts: 1,
      });
      const count = (pendingCountByTopic.get(config.topic) ?? 0) + 1;
      pendingCountByTopic.set(config.topic, count);
      runtime.health.pendingCount = count;
      metrics.gauge('kafka.pending.size', pendingBuffer.length);
    }
  }

  /**
   * Commit the next offset for a processed message, logging on failure.
   *
   * Commit failure means at-least-once redelivery on restart — never crash the consumer.
   */
  async function safeCommitInboundOffset(
    consumer: Consumer,
    topic: string,
    partition: number,
    message: KafkaMessage,
  ): Promise<void> {
    const offset = (BigInt(message.offset) + 1n).toString();
    try {
      await consumer.commitOffsets([{ topic, partition, offset }]);
    } catch (err) {
      logger.error(
        `[KafkaConnectors] failed to commit offset for topic "${topic}" partition ${partition} offset ${offset}:`,
        { err: errToString(err) },
      );
    }
  }

  async function stopConnector(): Promise<void> {
    // P-KAFKA-15: only valid from `running`. From `stopped`/`stopping` we
    // no-op (idempotent stop). From `idle`/`starting` we throw so the
    // caller sees a real signal rather than racing teardown with start.
    if (state === 'stopped' || state === 'stopping') return;
    if (state !== 'running') {
      throw new KafkaConnectorStateError('stop', state);
    }
    state = 'stopping';

    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }

    await drainPendingBuffer();

    if (boundBus) {
      for (const runtime of outboundRuntimes) {
        try {
          boundBus.offEnvelope(runtime.config.event, runtime.listener);
        } catch {
          // Durable listeners are cleaned up by the underlying bus shutdown.
        }
        runtime.health.status = 'stopped';
      }
    }

    for (const runtime of inboundRuntimes) {
      runtime.health.status = 'stopped';
      await runtime.consumer.disconnect().catch(() => {});
    }

    pendingCommitOffsetsByConsumer.clear();
    inFlightByConsumer.clear();
    rebalancingConsumers.clear();

    if (producer) {
      await producer.disconnect().catch(() => {});
      producer = null;
    }
    if (admin) {
      await admin.disconnect().catch(() => {});
      admin = null;
    }
    state = 'stopped';
  }

  async function cleanupAfterStartFailure(): Promise<void> {
    state = 'stopped';

    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }

    if (boundBus) {
      for (const runtime of outboundRuntimes) {
        try {
          boundBus.offEnvelope(runtime.config.event, runtime.listener);
        } catch {
          // Best-effort cleanup after a failed start.
        }
      }
    }

    for (const runtime of inboundRuntimes) {
      await runtime.consumer.disconnect().catch(() => {});
    }

    if (producer) {
      await producer.disconnect().catch(() => {});
      producer = null;
    }
    if (admin) {
      await admin.disconnect().catch(() => {});
      admin = null;
    }

    inboundRuntimes.length = 0;
    outboundRuntimes.length = 0;
    pendingBuffer.length = 0;
    pendingCountByTopic.clear();
    pendingCommitOffsetsByConsumer.clear();
    inFlightByConsumer.clear();
    rebalancingConsumers.clear();
    boundBus = null;
  }

  return {
    name: 'slingshot-kafka-connectors',

    async start(bus: SlingshotEventBus): Promise<void> {
      // P-KAFKA-15: only valid from `idle`/`stopped`. `starting`/`running`
      // means a previous start is still in flight or already won — without
      // this guard a second start() leaves duplicate listeners attached to
      // the bus and duplicate consumers attached to broker.
      if (state === 'starting' || state === 'running') {
        throw new KafkaConnectorStateError('start', state);
      }
      if (state === 'stopping') {
        throw new KafkaConnectorStateError('start', 'stopping');
      }
      state = 'starting';

      enforceDuplicatePublishPolicy(bus);
      boundBus = bus;
      try {
        const outboundAutoCreate = (opts.outbound ?? [])
          .filter(conn => conn.autoCreateTopic)
          .map(conn => ({
            topic: conn.topic,
            numPartitions: conn.partitions ?? 3,
            replicationFactor: conn.replicationFactor ?? 1,
          }));
        if (outboundAutoCreate.some(topic => topic.replicationFactor === 1)) {
          logger.warn(
            '[KafkaConnectors] outbound autoCreateTopic with replicationFactor=1 is convenient for local development ' +
              'but is not a production-safe default. Prefer pre-provisioned topics or replicationFactor >= 3.',
          );
        }
        await ensureTopics(outboundAutoCreate);

        let inboundConsumerIndex = 0;
        for (const config of opts.inbound ?? []) {
          const consumer = kafka.consumer({
            groupId: config.groupId,
            sessionTimeout: config.sessionTimeout ?? 30_000,
            heartbeatInterval: config.heartbeatInterval ?? 3_000,
          });
          const consumerKey = inboundConsumerIndex;
          inboundConsumerIndex += 1;
          const runtime: InboundRuntime = {
            consumer,
            config,
            health: {
              topic: config.topic ?? config.topicPattern ?? 'unknown',
              groupId: config.groupId,
              status: 'connecting',
              messagesProcessed: 0,
              messagesDLQ: 0,
            },
          };
          inboundRuntimes.push(runtime);
          await consumer.connect();
          await consumer.subscribe({
            topic: config.topic ?? new RegExp(config.topicPattern!),
            fromBeginning: config.fromBeginning ?? false,
          });

          // Wire rebalance lifecycle hooks: on REBALANCING, wait for in-flight
          // handlers and flush pending offsets so the next assignment doesn't
          // replay finished messages. On GROUP_JOIN, clear the rebalance flag.
          // kafkajs's Consumer type omits the `events` map and `on` from its
          // public types in some versions; feature-detect the shape we use.
          type ConsumerWithEvents = {
            events?: Record<string, string>;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- kafkajs's `on` is a heavily overloaded signature; we feature-detect existence and call dynamically.
            on?: (event: string, listener: (...args: any[]) => void) => void;
          };
          const consumerWithEvents = consumer as unknown as ConsumerWithEvents;
          const consumerEvents = consumerWithEvents.events;
          const consumerOn = consumerWithEvents.on;
          let hasGroupJoinHook = false;
          if (consumerEvents && typeof consumerOn === 'function') {
            try {
              consumerOn.call(consumer, consumerEvents.REBALANCING, async () => {
                rebalancingConsumers.add(consumerKey);
                logger.info(
                  `[KafkaConnectors] rebalancing inbound topic="${runtime.health.topic}" ` +
                    `group="${config.groupId}"`,
                );
                const inflight = inFlightByConsumer.get(consumerKey);
                if (inflight && inflight.size > 0) {
                  await Promise.allSettled([...inflight]);
                }
                const partitionMap = pendingCommitOffsetsByConsumer.get(consumerKey);
                if (partitionMap && partitionMap.size > 0) {
                  const toCommit: Array<{ topic: string; partition: number; offset: string }> = [];
                  for (const [tp, offset] of partitionMap.entries()) {
                    const [tt, partitionStr] = tp.split('|');
                    if (!tt || partitionStr === undefined) continue;
                    toCommit.push({ topic: tt, partition: Number(partitionStr), offset });
                  }
                  if (toCommit.length > 0) {
                    try {
                      await consumer.commitOffsets(toCommit);
                      partitionMap.clear();
                      logger.info(
                        `[KafkaConnectors] flushed ${toCommit.length} pending offset(s) ` +
                          `before rebalance for group="${config.groupId}"`,
                      );
                    } catch (err) {
                      logger.error(
                        `[KafkaConnectors] failed to flush offsets during rebalance for "${config.groupId}":`,
                        { err: errToString(err) },
                      );
                    }
                  }
                }
              });
              hasGroupJoinHook = true;
              consumerOn.call(consumer, consumerEvents.GROUP_JOIN, () => {
                rebalancingConsumers.delete(consumerKey);
                runtime.health.status = 'active';
                logger.info(
                  `[KafkaConnectors] group join group="${config.groupId}" ` +
                    `topic="${runtime.health.topic}"`,
                );
              });
            } catch (instErr) {
              logger.warn(
                `[KafkaConnectors] failed to register rebalance listeners for "${config.groupId}":`,
                { err: errToString(instErr) },
              );
            }
          }

          await consumer.run({
            autoCommit: false,
            partitionsConsumedConcurrently: config.concurrency ?? 1,
            eachMessage: async ({ topic, partition, message, heartbeat, pause }) => {
              // Track in-flight so a rebalance can quiesce before flushing offsets.
              const consumeStart = performance.now();
              metrics.counter('kafka.consume.count', 1, { topic });
              let timingRecorded = false;
              const recordTiming = (): void => {
                if (timingRecorded) return;
                timingRecorded = true;
                metrics.timing('kafka.consume.duration', performance.now() - consumeStart, {
                  topic,
                });
              };
              let resolveTracker: (() => void) | null = null;
              const tracker = new Promise<void>(resolve => {
                resolveTracker = resolve;
              });
              const inflightSet = inFlightByConsumer.get(consumerKey) ?? new Set<Promise<void>>();
              inflightSet.add(tracker);
              inFlightByConsumer.set(consumerKey, inflightSet);
              const finish = () => {
                recordTiming();
                inflightSet.delete(tracker);
                resolveTracker?.();
              };

              const trackedCommit = async (
                tt: string,
                p: number,
                m: KafkaMessage,
              ): Promise<void> => {
                const offset = (BigInt(m.offset) + 1n).toString();
                const partitionMap =
                  pendingCommitOffsetsByConsumer.get(consumerKey) ?? new Map<string, string>();
                partitionMap.set(`${tt}|${p}`, offset);
                pendingCommitOffsetsByConsumer.set(consumerKey, partitionMap);
                await safeCommitInboundOffset(consumer, tt, p, m);
                pendingCommitOffsetsByConsumer.get(consumerKey)?.delete(`${tt}|${p}`);
              };

              try {
                const metadata: InboundMessageMetadata = {
                  topic,
                  groupId: config.groupId,
                  partition,
                  offset: message.offset,
                  key: message.key?.toString() ?? null,
                  headers: headersToStrings(message.headers),
                  sizeBytes: message.value?.byteLength ?? 0,
                };

                if (!message.value) {
                  await trackedCommit(topic, partition, message);
                  return;
                }

                // Consumer-side dedup: if the producer attached a stable
                // `slingshot.message-id`, skip the handler for repeats.
                const messageId = metadata.headers['slingshot.message-id'];
                const connectorDedupEnabled = config.deduplicate ?? true;
                if (dedupEnabled && connectorDedupEnabled && messageId) {
                  let alreadySeen = false;
                  try {
                    alreadySeen = await dedupStore.has(messageId);
                  } catch (dedupErr) {
                    logger.warn(
                      '[KafkaConnectors] dedupStore.has() threw; treating as miss:',
                      { err: errToString(dedupErr) },
                    );
                  }
                  if (alreadySeen) {
                    inboundDeduped += 1;
                    await trackedCommit(topic, partition, message);
                    return;
                  }
                }

                // Per-phase tracking so we only commit the offset when we have
                // either fully processed the message OR successfully forwarded
                // it to the DLQ. If the DLQ produce fails we leave the offset
                // uncommitted so the broker can redeliver.
                let payload: unknown;
                const serializer = resolveSerializer(config.serializer, opts.serializer);

                // Phase 1: deserialize (corrupt-message — never retry, DLQ immediately)
                try {
                  payload = serializer.deserialize(topic, message.value);
                } catch (deserErr) {
                  logger.warn('[KafkaConnectors] deserialization failed; routing to DLQ', {
                    topic,
                    groupId: config.groupId,
                    partition,
                    offset: message.offset,
                    errorType: 'deserialize',
                    error: deserErr instanceof Error ? deserErr.message : String(deserErr),
                  });
                  hooks?.onInboundError?.(topic, config.groupId, deserErr);
                  runtime.health.status = 'error';
                  runtime.health.error =
                    deserErr instanceof Error ? deserErr.message : String(deserErr);
                  await dlqAndCommitOrSkip(
                    config,
                    runtime,
                    metadata,
                    message,
                    deserErr,
                    'deserialize',
                    topic,
                    partition,
                    trackedCommit,
                  );
                  return;
                }

                if (config.transform) {
                  try {
                    payload = await Promise.resolve(config.transform(payload, metadata));
                  } catch (transformErr) {
                    // Transform errors are treated like validation failures:
                    // the message is structurally undeliverable to the handler.
                    logger.warn('[KafkaConnectors] transform failed; routing to DLQ', {
                      topic,
                      groupId: config.groupId,
                      partition,
                      offset: message.offset,
                      errorType: 'validate',
                      error:
                        transformErr instanceof Error ? transformErr.message : String(transformErr),
                    });
                    hooks?.onInboundError?.(topic, config.groupId, transformErr);
                    runtime.health.status = 'error';
                    runtime.health.error =
                      transformErr instanceof Error ? transformErr.message : String(transformErr);
                    await dlqAndCommitOrSkip(
                      config,
                      runtime,
                      metadata,
                      message,
                      transformErr,
                      'validate',
                      topic,
                      partition,
                      trackedCommit,
                    );
                    return;
                  }
                  if (payload == null) {
                    await trackedCommit(topic, partition, message);
                    return;
                  }
                }

                // Phase 2: validate (also corrupt-message — never retry, DLQ immediately).
                // Wrapped with a heartbeat call before/after so a slow Zod
                // schema cannot cause the broker session to time out.
                try {
                  await heartbeat();
                  payload = validatePayload(
                    config.topic ?? topic,
                    payload,
                    config.validationMode ?? validationMode,
                    config.schema,
                    opts.schemaRegistry,
                  );
                  await heartbeat();
                } catch (validateErr) {
                  logger.warn('[KafkaConnectors] validation failed; routing to DLQ', {
                    topic,
                    groupId: config.groupId,
                    partition,
                    offset: message.offset,
                    errorType: 'validate',
                    error: validateErr instanceof Error ? validateErr.message : String(validateErr),
                  });
                  hooks?.onInboundError?.(topic, config.groupId, validateErr);
                  runtime.health.status = 'error';
                  runtime.health.error =
                    validateErr instanceof Error ? validateErr.message : String(validateErr);
                  await dlqAndCommitOrSkip(
                    config,
                    runtime,
                    metadata,
                    message,
                    validateErr,
                    'validate',
                    topic,
                    partition,
                    trackedCommit,
                  );
                  return;
                }

                // Phase 3: handler — retry up to maxAttempts before DLQ.
                const maxAttempts = Math.max(1, config.maxRetries ?? 3);
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                  try {
                    const startedAt = Date.now();
                    await Promise.resolve(config.handler(payload, metadata));
                    runtime.health.messagesProcessed += 1;
                    hooks?.onInboundSuccess?.(
                      topic,
                      config.groupId,
                      Date.now() - startedAt,
                      metadata,
                    );
                    // Mark as processed for dedup AFTER success so retries
                    // are not skipped on a transient handler failure.
                    if (dedupEnabled && connectorDedupEnabled && messageId) {
                      try {
                        await dedupStore.set(messageId, dedupTtlMs);
                      } catch (dedupErr) {
                        logger.warn(
                          '[KafkaConnectors] dedupStore.set() threw; continuing:',
                          { err: errToString(dedupErr) },
                        );
                      }
                    }
                    await trackedCommit(topic, partition, message);
                    return;
                  } catch (err) {
                    if (attempt >= maxAttempts) {
                      logger.warn('[KafkaConnectors] handler exhausted retries', {
                        topic,
                        groupId: config.groupId,
                        partition,
                        offset: message.offset,
                        errorType: 'handler',
                        attempts: attempt,
                        error: err instanceof Error ? err.message : String(err),
                      });
                      runtime.health.status = config.errorStrategy === 'pause' ? 'paused' : 'error';
                      runtime.health.error = err instanceof Error ? err.message : String(err);
                      hooks?.onInboundError?.(topic, config.groupId, err);
                      const strategy = config.errorStrategy ?? 'dlq';
                      if (strategy === 'pause') {
                        pause();
                        // Do NOT commit — we want redelivery once the consumer
                        // is resumed by the operator.
                        return;
                      }
                      if (strategy === 'dlq') {
                        await dlqAndCommitOrSkip(
                          config,
                          runtime,
                          metadata,
                          message,
                          err,
                          'handler',
                          topic,
                          partition,
                          trackedCommit,
                        );
                        return;
                      }
                      // strategy === 'skip': commit and move on.
                      await trackedCommit(topic, partition, message);
                      return;
                    }
                    await waitWithHeartbeat(heartbeat, backoffMs(attempt));
                  }
                }
              } finally {
                finish();
              }
            },
          });
          if (!hasGroupJoinHook) {
            runtime.health.status = 'active';
          }
        }

        for (const config of opts.outbound ?? []) {
          const runtime: OutboundRuntime = {
            config,
            listener: () => {},
            health: {
              event: config.event,
              topic: config.topic,
              status: 'active',
              messagesProduced: 0,
              pendingCount: 0,
            },
          };
          const listener = (envelope: EventEnvelope) => {
            void produceOutbound(config, envelope, runtime);
          };
          runtime.listener = listener;
          outboundRuntimes.push(runtime);
          if (config.durable) {
            bus.onEnvelope(config.event, listener, { durable: true, name: config.name! });
          } else {
            bus.onEnvelope(config.event, listener);
          }
        }

        if (opts.outbound?.length) {
          await ensureProducer();
          drainTimer = setInterval(() => {
            void drainPendingBuffer().catch(err => {
              logger.error('[KafkaConnectors] failed to drain pending outbound buffer:', err);
            });
          }, opts.drainIntervalMs ?? 2_000);
        }

        state = 'running';
      } catch (err) {
        await cleanupAfterStartFailure();
        throw err;
      }
    },

    stop: stopConnector,

    health(): KafkaConnectorHealth {
      const droppedMessages: KafkaConnectorDropStats = {
        totalDrops: dropTotal,
        bufferFull: dropBufferFull,
        attemptsExhausted: dropAttemptsExhausted,
        inboundDeduped,
        lastDropAt,
      };
      return {
        started: state === 'running',
        inbound: inboundRuntimes.map(runtime => ({ ...runtime.health })),
        outbound: outboundRuntimes.map(runtime => ({ ...runtime.health })),
        pendingBufferSize: pendingBuffer.length,
        droppedMessages,
      };
    },

    pendingBufferSize(): number {
      return pendingBuffer.length;
    },
  };
}
