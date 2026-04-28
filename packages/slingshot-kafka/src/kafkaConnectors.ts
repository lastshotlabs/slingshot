import { randomUUID } from 'node:crypto';
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
  SlingshotEventBus,
  ValidationMode,
} from '@lastshotlabs/slingshot-core';
import { JSON_SERIALIZER, validatePluginConfig } from '@lastshotlabs/slingshot-core';
import { getKafkaAdapterIntrospectionOrNull } from './kafkaAdapter';
import {
  COMPRESSION_CODEC,
  backoffMs,
  compressionSchema,
  saslSchema,
  sslSchema,
} from './kafkaShared';

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
  topic: z.string().optional(),
  topicPattern: z.string().optional(),
  handler: z.custom<InboundMessageHandler>(value => typeof value === 'function'),
  groupId: z.string(),
  fromBeginning: z.boolean().optional(),
  errorStrategy: z.enum(['dlq', 'skip', 'pause']).optional(),
  dlqTopic: z.string().optional(),
  maxRetries: z.number().int().min(0).optional(),
  sessionTimeout: z.number().int().min(6000).optional(),
  heartbeatInterval: z.number().int().min(1000).optional(),
  validationMode: z.enum(['strict', 'warn', 'off']).optional(),
  concurrency: z.number().int().min(1).optional(),
  schema: z.custom<ZodType>(value => !!value && typeof value === 'object').optional(),
  autoCreateDLQ: z.boolean().optional(),
  transform: z.custom<InboundTransform>(value => typeof value === 'function').optional(),
  serializer: z
    .custom<EventSerializer>(
      value =>
        !!value &&
        typeof value === 'object' &&
        'serialize' in value &&
        'deserialize' in value &&
        'contentType' in value,
    )
    .optional(),
});

const outboundConnectorSchema = z.object({
  event: z.string(),
  topic: z.string(),
  durable: z.boolean().optional(),
  name: z.string().optional(),
  filter: z.custom<OutboundFilter>(value => typeof value === 'function').optional(),
  transform: z.custom<OutboundTransform>(value => typeof value === 'function').optional(),
  serializer: z
    .custom<EventSerializer>(
      value =>
        !!value &&
        typeof value === 'object' &&
        'serialize' in value &&
        'deserialize' in value &&
        'contentType' in value,
    )
    .optional(),
  headers: z.custom<OutboundHeaderEnricher>(value => typeof value === 'function').optional(),
  schema: z.custom<ZodType>(value => !!value && typeof value === 'object').optional(),
  validationMode: z.enum(['strict', 'warn', 'off']).optional(),
  partitionKey: z
    .union([
      z.string(),
      z.custom<OutboundPartitionKeyExtractor>(value => typeof value === 'function'),
    ])
    .optional(),
  messageId: z
    .union([z.string(), z.custom<OutboundMessageIdExtractor>(value => typeof value === 'function')])
    .optional(),
  compression: compressionSchema.optional(),
  autoCreateTopic: z.boolean().optional(),
  partitions: z.number().int().min(1).optional(),
  replicationFactor: z.number().int().min(1).optional(),
});

/**
 * Zod schema for the programmatic Kafka connector bridge configuration.
 */
export const kafkaConnectorsSchema = z.object({
  brokers: z.array(z.string()).min(1),
  clientId: z.string().optional(),
  sasl: saslSchema.optional(),
  ssl: sslSchema.optional(),
  serializer: z
    .custom<EventSerializer>(
      value =>
        !!value &&
        typeof value === 'object' &&
        'serialize' in value &&
        'deserialize' in value &&
        'contentType' in value,
    )
    .optional(),
  compression: compressionSchema.optional(),
  validationMode: z.enum(['strict', 'warn', 'off']).optional(),
  duplicatePublishPolicy: z.enum(['off', 'warn', 'error']).optional(),
  inbound: z.array(inboundConnectorSchema).optional(),
  outbound: z.array(outboundConnectorSchema).optional(),
  hooks: z
    .custom<ConnectorObservabilityHooks>(value => !!value && typeof value === 'object')
    .optional(),
  schemaRegistry: z
    .custom<EventSchemaRegistry>(
      value => !!value && typeof value === 'object' && 'validate' in value,
    )
    .optional(),
  maxPendingBuffer: z.number().int().min(0).optional(),
  maxProduceAttempts: z.number().int().min(1).optional(),
  drainIntervalMs: z.number().int().min(500).optional(),
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
    .optional(),
  /** Override the default inbound dedup TTL (1h). Set to 0 to disable dedup. */
  dedupTtlMs: z.number().int().min(0).optional(),
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
    throw new Error(message, { cause: result.error });
  }
  console.warn(message);
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
  return envelope.meta.eventId || randomUUID();
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
  const headers: Record<string, string> = {
    'slingshot.event': envelope.key,
    'slingshot.event-id': envelope.meta.eventId,
    'slingshot.owner-plugin': envelope.meta.ownerPlugin,
    'slingshot.exposure': envelope.meta.exposure.join(','),
    'slingshot.content-type': serializerContentType,
    'slingshot.message-id': messageId,
  };
  if (envelope.meta.scope?.tenantId) {
    headers['slingshot.tenant-id'] = envelope.meta.scope.tenantId;
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
export function createKafkaConnectors(rawOpts: KafkaConnectorsConfig): KafkaConnectorHandle {
  const opts = validatePluginConfig('slingshot-kafka-connectors', rawOpts, kafkaConnectorsSchema);

  opts.inbound?.forEach((conn, i) => {
    const hasTopic = !!conn.topic;
    const hasPattern = !!conn.topicPattern;
    if (hasTopic === hasPattern) {
      throw new Error(
        `[slingshot-kafka-connectors] inbound[${i}]: exactly one of "topic" or "topicPattern" is required`,
      );
    }
    const session = conn.sessionTimeout ?? 30_000;
    const heartbeat = conn.heartbeatInterval ?? 3_000;
    if (heartbeat >= session) {
      throw new Error(
        `[slingshot-kafka-connectors] inbound[${i}]: heartbeatInterval must be less than sessionTimeout`,
      );
    }
    if (conn.topicPattern) {
      new RegExp(conn.topicPattern);
    }
    if (conn.dlqTopic && (conn.errorStrategy ?? 'dlq') !== 'dlq') {
      throw new Error(
        `[slingshot-kafka-connectors] inbound[${i}]: dlqTopic requires errorStrategy "dlq"`,
      );
    }
    if (conn.autoCreateDLQ && (conn.errorStrategy ?? 'dlq') !== 'dlq') {
      throw new Error(
        `[slingshot-kafka-connectors] inbound[${i}]: autoCreateDLQ is only meaningful when errorStrategy is "dlq"`,
      );
    }
  });

  opts.outbound?.forEach((conn, i) => {
    if (conn.durable && !conn.name) {
      throw new Error(
        `[slingshot-kafka-connectors] outbound[${i}]: durable: true requires a "name"`,
      );
    }
  });

  const inboundKeys = new Set<string>();
  for (const conn of opts.inbound ?? []) {
    const key = `${conn.topic ?? `pattern:${conn.topicPattern}`}:${conn.groupId}`;
    if (inboundKeys.has(key)) {
      throw new Error(`[slingshot-kafka-connectors] duplicate inbound connector: ${key}`);
    }
    inboundKeys.add(key);
  }

  const outboundKeys = new Set<string>();
  for (const conn of opts.outbound ?? []) {
    const key = `${conn.event}:${conn.topic}`;
    if (outboundKeys.has(key)) {
      throw new Error(`[slingshot-kafka-connectors] duplicate outbound connector: ${key}`);
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
  let started = false;
  let stopped = false;
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
    console.warn(
      '[KafkaConnectors] SASL configured without SSL. Credentials will travel in plaintext.',
    );
  }
  if (opts.ssl && opts.ssl !== true && opts.ssl.rejectUnauthorized === false) {
    console.warn(
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
        throw new Error(message);
      }
      console.warn(message);
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
    const ensuredProducer = await ensureProducer();
    if (config.autoCreateDLQ) {
      await ensureTopics([{ topic: dlqTopic }]);
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    await ensuredProducer.send({
      topic: dlqTopic,
      messages: [
        {
          key: metadata.key ?? undefined,
          value: rawMessage.value ? Buffer.from(rawMessage.value) : null,
          headers: {
            'slingshot.original-topic': metadata.topic,
            'slingshot.original-partition': String(metadata.partition),
            'slingshot.original-offset': metadata.offset,
            'slingshot.error': errorMessage,
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
      console.error(
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
          console.error(
            `[KafkaConnector:outbound] permanently dropping message for topic "${entry.topic}" ` +
              `after ${entry.attempts} attempts:`,
            err,
          );
        }
      }
    }

    pendingBuffer.push(...retry);
    for (const runtime of outboundRuntimes) {
      runtime.health.pendingCount = pendingCountByTopic.get(runtime.config.topic) ?? 0;
    }
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
      const messageId = resolveMessageId(config, envelope, transformed);
      const key = resolvePartitionKey(config, envelope, transformed);
      const serialized = serializer.serialize(config.event, outboundEnvelope);

      let messageHeaders = buildOutboundHeaders(
        outboundEnvelope,
        serializer.contentType,
        messageId,
      );
      if (config.headers) {
        messageHeaders = config.headers(messageHeaders, outboundEnvelope);
      }
      messageHeaders = {
        ...messageHeaders,
        'slingshot.event': outboundEnvelope.key,
        'slingshot.event-id': outboundEnvelope.meta.eventId,
        'slingshot.owner-plugin': outboundEnvelope.meta.ownerPlugin,
        'slingshot.exposure': outboundEnvelope.meta.exposure.join(','),
        'slingshot.content-type': serializer.contentType,
        'slingshot.message-id': messageId,
      };
      if (outboundEnvelope.meta.scope?.tenantId) {
        messageHeaders['slingshot.tenant-id'] = outboundEnvelope.meta.scope.tenantId;
      }
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
      hooks?.onOutboundSuccess?.(config.event, config.topic, Date.now() - startMs);
    } catch (err) {
      hooks?.onOutboundError?.(config.event, config.topic, err);
      runtime.health.status = 'error';
      runtime.health.error = err instanceof Error ? err.message : String(err);

      if (!pendingEntry) {
        return;
      }
      if (pendingBuffer.length >= maxPendingBuffer) {
        recordDrop('pending-buffer-full');
        console.error(
          `[KafkaConnector:outbound] pending buffer full; dropping message for topic "${config.topic}" ` +
            `(buffer=${pendingBuffer.length}/${maxPendingBuffer}, totalDrops=${dropTotal})`,
          err,
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
      console.error(
        `[KafkaConnectors] failed to commit offset for topic "${topic}" partition ${partition} offset ${offset}:`,
        err,
      );
    }
  }

  async function stopConnector(): Promise<void> {
    if (stopped) return;
    stopped = true;
    started = false;

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
  }

  async function cleanupAfterStartFailure(): Promise<void> {
    started = false;

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
      if (started) {
        throw new Error('[KafkaConnectors] start() called more than once.');
      }
      if (stopped) {
        throw new Error('[KafkaConnectors] start() called after stop().');
      }

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
          console.warn(
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
                console.info(
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
                      console.info(
                        `[KafkaConnectors] flushed ${toCommit.length} pending offset(s) ` +
                          `before rebalance for group="${config.groupId}"`,
                      );
                    } catch (err) {
                      console.error(
                        `[KafkaConnectors] failed to flush offsets during rebalance for "${config.groupId}":`,
                        err,
                      );
                    }
                  }
                }
              });
              hasGroupJoinHook = true;
              consumerOn.call(consumer, consumerEvents.GROUP_JOIN, () => {
                rebalancingConsumers.delete(consumerKey);
                runtime.health.status = 'active';
                console.info(
                  `[KafkaConnectors] group join group="${config.groupId}" ` +
                    `topic="${runtime.health.topic}"`,
                );
              });
            } catch (instErr) {
              console.warn(
                `[KafkaConnectors] failed to register rebalance listeners for "${config.groupId}":`,
                instErr,
              );
            }
          }

          await consumer.run({
            autoCommit: false,
            partitionsConsumedConcurrently: config.concurrency ?? 1,
            eachMessage: async ({ topic, partition, message, heartbeat, pause }) => {
              // Track in-flight so a rebalance can quiesce before flushing offsets.
              let resolveTracker: (() => void) | null = null;
              const tracker = new Promise<void>(resolve => {
                resolveTracker = resolve;
              });
              const inflightSet = inFlightByConsumer.get(consumerKey) ?? new Set<Promise<void>>();
              inflightSet.add(tracker);
              inFlightByConsumer.set(consumerKey, inflightSet);
              const finish = () => {
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
                if (dedupEnabled && messageId) {
                  let alreadySeen = false;
                  try {
                    alreadySeen = await dedupStore.has(messageId);
                  } catch (dedupErr) {
                    console.warn(
                      '[KafkaConnectors] dedupStore.has() threw; treating as miss:',
                      dedupErr,
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
                  console.warn('[KafkaConnectors] deserialization failed; routing to DLQ', {
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
                    console.warn('[KafkaConnectors] transform failed; routing to DLQ', {
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
                  console.warn('[KafkaConnectors] validation failed; routing to DLQ', {
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
                    if (dedupEnabled && messageId) {
                      try {
                        await dedupStore.set(messageId, dedupTtlMs);
                      } catch (dedupErr) {
                        console.warn(
                          '[KafkaConnectors] dedupStore.set() threw; continuing:',
                          dedupErr,
                        );
                      }
                    }
                    await trackedCommit(topic, partition, message);
                    return;
                  } catch (err) {
                    if (attempt >= maxAttempts) {
                      console.warn('[KafkaConnectors] handler exhausted retries', {
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
              console.error('[KafkaConnectors] failed to drain pending outbound buffer:', err);
            });
          }, opts.drainIntervalMs ?? 2_000);
        }

        started = true;
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
        started,
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
