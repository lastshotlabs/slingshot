import { randomUUID } from 'node:crypto';
import { type Admin, type Consumer, Kafka, type KafkaMessage, type Producer } from 'kafkajs';
import { type ZodType, z } from 'zod';
import type {
  EventEnvelope,
  EventSchemaRegistry,
  EventSerializer,
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

  async function produceToDlq(
    config: InboundConnectorConfig,
    metadata: InboundMessageMetadata,
    rawMessage: KafkaMessage,
    error: unknown,
  ): Promise<void> {
    const dlqTopic = config.dlqTopic ?? `${metadata.topic}.dlq`;
    const ensuredProducer = await ensureProducer();
    if (config.autoCreateDLQ) {
      await ensureTopics([{ topic: dlqTopic }]);
    }
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
            'slingshot.error': error instanceof Error ? error.message : String(error),
          },
        },
      ],
    });
    hooks?.onInboundDLQ?.(metadata.topic, dlqTopic, metadata);
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
          hooks?.onOutboundError?.(entry.event, entry.topic, err);
          console.error(
            `[KafkaConnector:outbound] permanently dropping message for topic "${entry.topic}"`,
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
        console.error(
          `[KafkaConnector:outbound] pending buffer full; dropping message for topic "${config.topic}"`,
          err,
        );
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

        for (const config of opts.inbound ?? []) {
          const consumer = kafka.consumer({
            groupId: config.groupId,
            sessionTimeout: config.sessionTimeout ?? 30_000,
            heartbeatInterval: config.heartbeatInterval ?? 3_000,
          });
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
          runtime.health.status = 'active';

          await consumer.run({
            autoCommit: false,
            partitionsConsumedConcurrently: config.concurrency ?? 1,
            eachMessage: async ({ topic, partition, message, heartbeat, pause }) => {
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
                await safeCommitInboundOffset(consumer, topic, partition, message);
                return;
              }

              try {
                const serializer = resolveSerializer(config.serializer, opts.serializer);
                let payload = serializer.deserialize(topic, message.value);
                if (config.transform) {
                  payload = await Promise.resolve(config.transform(payload, metadata));
                  if (payload == null) {
                    await safeCommitInboundOffset(consumer, topic, partition, message);
                    return;
                  }
                }

                payload = validatePayload(
                  config.topic ?? topic,
                  payload,
                  config.validationMode ?? validationMode,
                  config.schema,
                  opts.schemaRegistry,
                );

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
                    await safeCommitInboundOffset(consumer, topic, partition, message);
                    return;
                  } catch (err) {
                    if (attempt >= maxAttempts) {
                      runtime.health.status = config.errorStrategy === 'pause' ? 'paused' : 'error';
                      runtime.health.error = err instanceof Error ? err.message : String(err);
                      hooks?.onInboundError?.(topic, config.groupId, err);
                      const strategy = config.errorStrategy ?? 'dlq';
                      if (strategy === 'pause') {
                        pause();
                        return;
                      }
                      if (strategy === 'dlq') {
                        try {
                          await produceToDlq(config, metadata, message, err);
                          runtime.health.messagesDLQ += 1;
                        } catch (dlqErr) {
                          console.error(
                            '[KafkaConnectors] failed to publish inbound DLQ message:',
                            dlqErr,
                          );
                        }
                      }
                      await safeCommitInboundOffset(consumer, topic, partition, message);
                      return;
                    }
                    await waitWithHeartbeat(heartbeat, backoffMs(attempt));
                  }
                }
              } catch (err) {
                hooks?.onInboundError?.(topic, config.groupId, err);
                await safeCommitInboundOffset(consumer, topic, partition, message);
              }
            },
          });
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
      return {
        started,
        inbound: inboundRuntimes.map(runtime => ({ ...runtime.health })),
        outbound: outboundRuntimes.map(runtime => ({ ...runtime.health })),
        pendingBufferSize: pendingBuffer.length,
      };
    },

    pendingBufferSize(): number {
      return pendingBuffer.length;
    },
  };
}
