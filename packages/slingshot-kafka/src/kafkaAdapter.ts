import {
  type Admin,
  type Consumer,
  type EachMessagePayload,
  Kafka,
  type KafkaMessage,
  type Producer,
} from 'kafkajs';
import { z } from 'zod';
import type {
  EventBusSerializationOptions,
  EventEnvelope,
  HealthReport,
  HealthState,
  Logger,
  MetricsEmitter,
  SlingshotEventBus,
  SlingshotEventMap,
  SubscriptionOpts,
} from '@lastshotlabs/slingshot-core';
import {
  JSON_SERIALIZER,
  TimeoutError,
  createConsoleLogger,
  createNoopMetricsEmitter,
  createRawEventEnvelope,
  isEventEnvelope,
  sanitizeHeaderValue,
  validateEventPayload,
  validatePluginConfig,
  withTimeout,
} from '@lastshotlabs/slingshot-core';
import {
  KafkaAdapterConfigError,
  KafkaDuplicateDurableSubscriptionError,
  KafkaDurableSubscriptionNameRequiredError,
  KafkaDurableSubscriptionOffError,
} from './errors';
import {
  COMPRESSION_CODEC,
  backoffMs,
  compressionSchema,
  saslSchema,
  sslSchema,
} from './kafkaShared';
import { toGroupId, toTopicName } from './kafkaTopicNaming';

/**
 * Reasons the adapter may drop or skip an event. Surfaced through `onDrop` so
 * SREs can wire metrics and alerts without log scraping.
 */
export type KafkaAdapterDropReason =
  | 'serialize-failed'
  | 'pending-buffer-full'
  | 'pending-attempts-exhausted'
  | 'deserialize-failed'
  | 'null-message-value'
  | 'shutdown-with-pending'
  /** producer.send() exceeded `producerTimeoutMs` and was buffered for retry. */
  | 'producer-timeout'
  /**
   * DLQ produce for an exhausted handler message failed and `onDlqFailure`
   * is set to `'redeliver'` — the offset is left uncommitted so the broker
   * redelivers the original message.
   */
  | 'dlq-production-failed'
  /** custom deserializer exceeded `deserializeTimeoutMs`. */
  | 'deserialize-timeout'
  /** Handler exceeded `handlerTimeoutMs` during a rebalance quiesce. */
  | 'handler-timeout';

/**
 * Telemetry signal emitted when the adapter drops or skips a message.
 */
export interface KafkaAdapterDropEvent {
  readonly reason: KafkaAdapterDropReason;
  readonly event: string;
  readonly topic: string;
  /** Present when an underlying error caused the drop. */
  readonly error?: unknown;
  /** Present for inbound message drops (deserialize / null value). */
  readonly partition?: number;
  readonly offset?: string;
}

/**
 * Behavior when the consumer encounters an undecodable message (deserialization
 * failure or null value). `dlq` (default) routes raw bytes to
 * `${topic}.deser-dlq` so operators can replay after fixing the schema.
 * `skip` commits the offset and continues, mirroring legacy behavior.
 */
export type KafkaAdapterDeserErrorPolicy = 'dlq' | 'skip';

/**
 * Zod schema for the programmatic Kafka event-bus adapter configuration.
 */
export const kafkaAdapterOptionsSchema = z.object({
  brokers: z
    .array(z.string())
    .min(1, 'At least one broker address is required')
    .describe('List of Kafka broker addresses to connect to'),
  clientId: z.string().optional().describe('Kafka client identifier for this adapter instance'),
  topicPrefix: z
    .string()
    .optional()
    .describe('Prefix prepended to all topic names produced or consumed by this adapter'),
  groupPrefix: z
    .string()
    .optional()
    .describe('Prefix prepended to all consumer group IDs created by this adapter'),
  sasl: saslSchema
    .optional()
    .describe('SASL authentication configuration for the Kafka connection'),
  ssl: sslSchema.optional().describe('TLS/SSL configuration for the Kafka connection'),
  maxRetries: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Maximum number of retries for failed produce or consume operations'),
  autoCreateTopics: z
    .boolean()
    .optional()
    .describe('Whether to automatically create topics that do not yet exist on the broker'),
  defaultPartitions: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Default number of partitions when auto-creating topics'),
  replicationFactor: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Replication factor used when auto-creating topics'),
  connectionTimeout: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe('Milliseconds to wait for the initial broker connection before timing out'),
  requestTimeout: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe('Milliseconds to wait for a broker request response before timing out'),
  sessionTimeout: z
    .number()
    .int()
    .min(6000)
    .optional()
    .describe('Consumer session timeout in milliseconds; triggers a rebalance if exceeded'),
  heartbeatInterval: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe('Interval in milliseconds between consumer heartbeats to the group coordinator'),
  startFromBeginning: z
    .boolean()
    .optional()
    .describe('Whether new consumer groups start reading from the earliest available offset'),
  partitionKey: z
    .union([
      z.string(),
      z.custom<(event: string, payload: unknown) => string | null>(
        value => typeof value === 'function',
        'partitionKey function must be (event: string, payload: unknown) => string | null',
      ),
    ])
    .optional()
    .describe(
      'Static string or function returning the Kafka partition key for each produced message',
    ),
  compression: compressionSchema
    .optional()
    .describe('Compression codec applied to produced messages (e.g. gzip, snappy, lz4)'),
  validation: z
    .enum(['strict', 'warn', 'off'])
    .optional()
    .describe('Event payload validation mode: strict rejects, warn logs, off skips validation'),
  /**
   * Policy for messages that fail to deserialize on the consumer.
   * `dlq` (default) sends the raw bytes to `${topic}.deser-dlq` before
   * committing the offset. `skip` commits without forwarding.
   */
  deserializationErrorPolicy: z
    .enum(['dlq', 'skip'])
    .optional()
    .describe(
      'Policy for messages that fail to deserialize: dlq routes raw bytes to a dead-letter topic, skip commits the offset',
    ),
  /**
   * Maximum number of failed-publish events held in the in-memory reconnect
   * buffer before new events are dropped with reason `pending-buffer-full`.
   * Defaults to 1000.
   */
  pendingBufferSize: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Maximum number of failed-publish events held in the in-memory reconnect buffer before new events are dropped',
    ),
  /**
   * Optional callback invoked when the adapter drops or skips a message.
   * Use this to emit metrics / alerts without log scraping.
   */
  onDrop: z
    .custom<(event: KafkaAdapterDropEvent) => void>(
      value => typeof value === 'function',
      'onDrop must be a function',
    )
    .optional()
    .describe(
      'Callback invoked when the adapter drops or skips a message; use for metrics and alerts',
    ),
  /**
   * Maximum milliseconds to wait for `producer.send()` before rejecting.
   * A hung broker would otherwise block emit() forever and overflow the
   * pending buffer to OOM. Default: 30_000 (30 seconds).
   */
  producerTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum milliseconds to wait for producer.send() before rejecting; prevents OOM from hung brokers (default 30000)',
    ),
  /**
   * Maximum milliseconds to wait for `producer.connect()` /
   * `admin.connect()` before rejecting. Guards against DNS hangs at
   * adapter init. Default: 30_000.
   */
  connectTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum milliseconds to wait for producer/admin connect before rejecting; guards against DNS hangs (default 30000)',
    ),
  /**
   * Maximum milliseconds a custom deserializer may take per message before
   * the consumer treats the message as undecodable and routes it to the
   * deserialization DLQ (or skips, per `deserializationErrorPolicy`).
   * Default: 5_000.
   */
  deserializeTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum milliseconds a custom deserializer may take per message before routing to DLQ or skipping (default 5000)',
    ),
  /**
   * Maximum milliseconds a single in-flight handler may take to settle
   * during a rebalance. Handlers exceeding this limit are abandoned (the
   * tracker is released) so GROUP_JOIN can proceed; the original promise
   * continues running but its outcome no longer blocks the rebalance.
   * Default: 60_000.
   */
  handlerTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum milliseconds a handler may take during a rebalance before being abandoned (default 60000)',
    ),
  /**
   * Behavior when a downstream DLQ produce fails for an exhausted handler
   * message. `redeliver` (default) leaves the offset uncommitted so the
   * broker redelivers the message after restart. `commit-and-log` keeps
   * the legacy behavior — log the failure and commit, accepting the lost
   * message in exchange for forward progress.
   */
  onDlqFailure: z
    .enum(['redeliver', 'commit-and-log'])
    .optional()
    .describe(
      'Behavior when a downstream DLQ produce fails: redeliver leaves offset uncommitted, commit-and-log accepts message loss',
    ),
  /**
   * How to derive a stable message id when an inbound message lacks the
   * `slingshot.message-id` header. `fingerprint` (default) hashes the
   * message body with SHA-256. `random` keeps the legacy `randomUUID()`
   * behavior with a warning. `reject` throws — useful for callers that
   * require strict provenance.
   */
  onIdMissing: z
    .enum(['fingerprint', 'random', 'reject'])
    .optional()
    .describe(
      'How to derive a stable message id when the slingshot.message-id header is missing: fingerprint hashes the body, random uses UUID, reject throws',
    ),
});

/**
 * Runtime options accepted by {@link createKafkaAdapter}.
 */
export type KafkaAdapterOptions = z.infer<typeof kafkaAdapterOptionsSchema>;

interface ResolvedKafkaConfig {
  readonly brokers: string[];
  readonly clientId: string;
  readonly topicPrefix: string;
  readonly groupPrefix: string;
  readonly maxRetries: number;
  readonly autoCreateTopics: boolean;
  readonly defaultPartitions: number;
  readonly replicationFactor: number;
  readonly connectionTimeout: number;
  readonly requestTimeout: number;
  readonly sessionTimeout: number;
  readonly heartbeatInterval: number;
  readonly startFromBeginning: boolean;
  readonly partitionKey: KafkaAdapterOptions['partitionKey'];
  readonly compression: KafkaAdapterOptions['compression'];
  readonly sasl: KafkaAdapterOptions['sasl'];
  readonly ssl: KafkaAdapterOptions['ssl'];
  readonly validation: NonNullable<KafkaAdapterOptions['validation']>;
  readonly deserializationErrorPolicy: KafkaAdapterDeserErrorPolicy;
  readonly pendingBufferSize: number;
  readonly onDrop: ((event: KafkaAdapterDropEvent) => void) | undefined;
  readonly producerTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly deserializeTimeoutMs: number;
  readonly handlerTimeoutMs: number;
  readonly onDlqFailure: 'redeliver' | 'commit-and-log';
  readonly onIdMissing: 'fingerprint' | 'random' | 'reject';
}

const DEFAULTS = {
  clientId: 'slingshot',
  topicPrefix: 'slingshot.events',
  groupPrefix: 'slingshot',
  maxRetries: 3,
  autoCreateTopics: true,
  defaultPartitions: 3,
  replicationFactor: 1,
  connectionTimeout: 10_000,
  requestTimeout: 30_000,
  sessionTimeout: 30_000,
  heartbeatInterval: 3_000,
  startFromBeginning: false,
  validation: 'off' as const,
  producerTimeoutMs: 30_000,
  connectTimeoutMs: 30_000,
  deserializeTimeoutMs: 5_000,
  handlerTimeoutMs: 60_000,
  onDlqFailure: 'redeliver' as const,
  onIdMissing: 'fingerprint' as const,
} as const;

interface PendingProduce {
  topic: string;
  event: string;
  serialized: Uint8Array;
  key: string | null;
  headers: Record<string, string>;
  attempts: number;
}

interface DurableConsumerEntry {
  consumer: Consumer;
  groupId: string;
  topic: string;
  event: string;
  name: string;
  /**
   * Resolves when consumer.connect() + consumer.subscribe() both settle. The
   * adapter uses this in shutdown to ensure pending setup never overlaps a
   * teardown, and tests can await it to assert subscribe outcomes.
   */
  setupPromise: Promise<void>;
  /** Final state of `setupPromise` — surfaced through health(). */
  setupState: 'pending' | 'subscribed' | 'failed';
  /** Reason for the failed state, if any. */
  setupError?: unknown;
}

export interface KafkaAdapterHealthConsumer {
  /** Event name registered on the Slingshot bus. */
  readonly event: string;
  /** Kafka topic bound to the event. */
  readonly topic: string;
  /** Durable subscriber name supplied through `SubscriptionOpts.name`. */
  readonly name: string;
  /** Kafka consumer group used for the durable subscription. */
  readonly groupId: string;
  /** Whether the consumer is currently connected to the broker. */
  readonly connected: boolean;
}

/**
 * Aggregate drop / skip counters surfaced through {@link KafkaAdapterHealth}.
 */
export interface KafkaAdapterDropStats {
  /** Total number of drops observed since adapter creation. */
  readonly totalDrops: number;
  /** Drop counts keyed by reason. */
  readonly byReason: Readonly<Record<KafkaAdapterDropReason, number>>;
  /** Wall-clock timestamp (ms) of the most recent drop, or null. */
  readonly lastDropAt: number | null;
  /** Reason of the most recent drop, or null. */
  readonly lastDropReason: KafkaAdapterDropReason | null;
}

/**
 * Health snapshot for the Kafka event-bus adapter.
 */
export interface KafkaAdapterHealth {
  /** Whether the producer has an active Kafka connection. */
  readonly producerConnected: boolean;
  /** Whether the admin client has an active Kafka connection. */
  readonly adminConnected: boolean;
  /** Whether `shutdown()` has already been called. */
  readonly isShutdown: boolean;
  /** Number of buffered outbound messages waiting for a reconnect. */
  readonly pendingBufferSize: number;
  /** Durable consumer status keyed by event subscription. */
  readonly consumers: readonly KafkaAdapterHealthConsumer[];
  /** Cumulative drop telemetry; use this to alert on silent overflow. */
  readonly droppedMessages: KafkaAdapterDropStats;
}

/**
 * Structured health snapshot for the Kafka adapter, designed for higher-level
 * health-endpoint aggregation.
 *
 * `status` is derived from the underlying signals:
 *   - `'unhealthy'` when the adapter has been shut down or the producer is
 *     disconnected with pending events buffered.
 *   - `'degraded'` when the producer is disconnected with no buffer pressure,
 *     the admin client is disconnected, or any registered consumer is
 *     disconnected.
 *   - `'healthy'` otherwise.
 */
export interface KafkaAdapterHealthSnapshot {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly details: KafkaAdapterHealth;
}

/**
 * Introspection handle attached to Kafka-backed event buses.
 */
export interface KafkaAdapterIntrospection {
  /** Stable marker used to detect the Kafka adapter at runtime. */
  readonly kind: 'slingshot-kafka-adapter';
  /** Topic prefix applied before Slingshot event keys. */
  readonly topicPrefix: string;
  /** Resolve the Kafka topic that the adapter uses for an event key. */
  topicNameForEvent(event: string): string;
}

const ADAPTER_INTROSPECTION_SYMBOL = Symbol.for('slingshot.kafka.adapter.introspection');
const DEFAULT_PENDING_BUFFER_SIZE = 1000;
const MAX_PENDING_ATTEMPTS = 5;
const DRAIN_INTERVAL_MS = 2_000;

function resolvePartitionKey(
  config: ResolvedKafkaConfig,
  event: string,
  payload: unknown,
): string | null {
  if (!config.partitionKey) return null;
  if (typeof config.partitionKey === 'function') {
    return config.partitionKey(event, payload);
  }
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[config.partitionKey];
  return value == null ? null : String(value);
}

function buildEnvelopeHeaders(
  envelope: EventEnvelope,
  serializerContentType: string,
): Record<string, string> {
  // Defense-in-depth: every value here is framework-derived (event-key
  // template literal, UUID, plugin name, tenantId from a resolved scope),
  // but a misconfigured event registration or a buggy upstream resolver
  // could still leak CR/LF into one of these fields. Sanitize so the
  // resulting Kafka headers cannot smuggle header-splitting bytes into
  // downstream HTTP-bridged consumers.
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
  };
  if (envelope.meta.scope?.tenantId) {
    headers['slingshot.tenant-id'] = sanitizeHeaderValue(
      envelope.meta.scope.tenantId,
      'slingshot.tenant-id',
    );
  }
  return headers;
}

function nextOffset(offset: string): string {
  return (BigInt(offset) + 1n).toString();
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
 * Read Kafka adapter introspection metadata from a bus when available.
 */
export function getKafkaAdapterIntrospectionOrNull(
  bus: SlingshotEventBus,
): KafkaAdapterIntrospection | null {
  // The bus exposes an opaque symbol-keyed introspection slot stamped by
  // createKafkaAdapter(); SlingshotEventBus does not declare symbol indexers,
  // so we widen at the read boundary and validate the discriminant below.
  const introspectable = bus as unknown as Record<PropertyKey, unknown>;
  const value = introspectable[ADAPTER_INTROSPECTION_SYMBOL];
  if (!value || typeof value !== 'object') return null;
  if ((value as KafkaAdapterIntrospection).kind !== 'slingshot-kafka-adapter') return null;
  return value as KafkaAdapterIntrospection;
}

/**
 * Create a Slingshot event bus backed by Kafka durable topics.
 *
 * Non-durable listeners still execute in-process. Durable listeners are bridged
 * through Kafka topics, consumer groups, and a reconnect buffer for transient
 * producer failures.
 */
export function createKafkaAdapter(
  rawOpts: KafkaAdapterOptions &
    EventBusSerializationOptions & {
      /**
       * Optional metrics sink. When provided, the adapter records publish /
       * consume / dlq counters, publish/consume durations, and pending-buffer
       * + connection-state gauges so operators can wire ad-hoc dashboards
       * without log scraping. Defaults to a no-op emitter.
       */
      metrics?: MetricsEmitter;
      /**
       * Optional structured logger. Defaults to a console-backed JSON
       * logger when omitted. All warn/error paths route through the logger
       * so no structured information is lost to console formatting.
       */
      logger?: Logger;
    },
): SlingshotEventBus & {
  readonly __slingshotKafkaAdapter?: KafkaAdapterIntrospection;
  health(): KafkaAdapterHealth;
  /** {@link HealthCheck.getHealth} — synchronous, last-cached state. */
  getHealth(): HealthReport;
  /** Structured snapshot kept for callers that need raw counters. */
  getHealthSnapshot(): KafkaAdapterHealthSnapshot;
  _drainPendingBuffer(): Promise<void>;
  shutdown(): Promise<void>;
} {
  const {
    serializer,
    schemaRegistry,
    metrics: metricsOpt,
    logger: rawLogger,
    ...adapterOpts
  } = rawOpts;
  const metrics: MetricsEmitter = metricsOpt ?? createNoopMetricsEmitter();
  const logger: Logger =
    rawLogger ?? createConsoleLogger({ base: { component: 'slingshot-kafka' } });
  const opts = validatePluginConfig('slingshot-kafka', adapterOpts, kafkaAdapterOptionsSchema);
  const config: ResolvedKafkaConfig = Object.freeze({
    brokers: [...opts.brokers],
    clientId: opts.clientId ?? DEFAULTS.clientId,
    topicPrefix: opts.topicPrefix ?? DEFAULTS.topicPrefix,
    groupPrefix: opts.groupPrefix ?? DEFAULTS.groupPrefix,
    maxRetries: opts.maxRetries ?? DEFAULTS.maxRetries,
    autoCreateTopics: opts.autoCreateTopics ?? DEFAULTS.autoCreateTopics,
    defaultPartitions: opts.defaultPartitions ?? DEFAULTS.defaultPartitions,
    replicationFactor: opts.replicationFactor ?? DEFAULTS.replicationFactor,
    connectionTimeout: opts.connectionTimeout ?? DEFAULTS.connectionTimeout,
    requestTimeout: opts.requestTimeout ?? DEFAULTS.requestTimeout,
    sessionTimeout: opts.sessionTimeout ?? DEFAULTS.sessionTimeout,
    heartbeatInterval: opts.heartbeatInterval ?? DEFAULTS.heartbeatInterval,
    startFromBeginning: opts.startFromBeginning ?? DEFAULTS.startFromBeginning,
    partitionKey: opts.partitionKey,
    compression: opts.compression,
    sasl: opts.sasl,
    ssl: opts.ssl,
    validation: opts.validation ?? DEFAULTS.validation,
    deserializationErrorPolicy: opts.deserializationErrorPolicy ?? 'dlq',
    pendingBufferSize: opts.pendingBufferSize ?? DEFAULT_PENDING_BUFFER_SIZE,
    onDrop: opts.onDrop,
    producerTimeoutMs: opts.producerTimeoutMs ?? DEFAULTS.producerTimeoutMs,
    connectTimeoutMs: opts.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
    deserializeTimeoutMs: opts.deserializeTimeoutMs ?? DEFAULTS.deserializeTimeoutMs,
    handlerTimeoutMs: opts.handlerTimeoutMs ?? DEFAULTS.handlerTimeoutMs,
    onDlqFailure: opts.onDlqFailure ?? DEFAULTS.onDlqFailure,
    onIdMissing: opts.onIdMissing ?? DEFAULTS.onIdMissing,
  });

  function errToString(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function notifyDrop(event: KafkaAdapterDropEvent): void {
    dropCounts[event.reason] = (dropCounts[event.reason] ?? 0) + 1;
    totalDrops += 1;
    lastDropAt = Date.now();
    lastDropReason = event.reason;
    if (!config.onDrop) return;
    try {
      config.onDrop(event);
    } catch (err) {
      logger.error('onDrop callback threw', { err: errToString(err) });
    }
  }

  if (config.heartbeatInterval >= config.sessionTimeout) {
    throw new KafkaAdapterConfigError(
      `[KafkaAdapter] heartbeatInterval must be less than sessionTimeout ` +
        `(got heartbeat=${config.heartbeatInterval}ms, session=${config.sessionTimeout}ms)`,
    );
  }
  if (config.sasl && !config.ssl) {
    console.warn(
      '[KafkaAdapter] SASL configured without SSL. Credentials will travel in plaintext.',
    );
  }
  if (config.ssl && config.ssl !== true && config.ssl.rejectUnauthorized === false) {
    console.warn(
      '[KafkaAdapter] ssl.rejectUnauthorized=false disables broker certificate verification. ' +
        'Use only for local development or controlled test environments.',
    );
  }
  if (config.autoCreateTopics && config.replicationFactor === 1) {
    console.warn(
      '[KafkaAdapter] autoCreateTopics=true with replicationFactor=1 is convenient for local development ' +
        'but is not a production-safe default. Prefer pre-provisioned topics or replicationFactor >= 3.',
    );
  }

  const eventSerializer = serializer ?? JSON_SERIALIZER;
  const envelopeListeners = new Map<
    string,
    Set<(envelope: EventEnvelope) => void | Promise<void>>
  >();
  const payloadListenerWrappers = new Map<
    string,
    Map<
      (payload: unknown) => void | Promise<void>,
      (envelope: EventEnvelope) => void | Promise<void>
    >
  >();
  const durableListeners = new Map<
    string,
    Set<(envelope: EventEnvelope) => void | Promise<void>>
  >();
  const durableConsumers = new Map<string, DurableConsumerEntry>();
  const connectedConsumers = new Set<string>();
  /** entryKey -> Map<topic|partition, nextOffset>: most recent offset waiting to commit during a rebalance. */
  const pendingCommitOffsets = new Map<string, Map<string, string>>();
  /** entryKey -> Set of in-flight handler promises so we can quiesce on rebalance. */
  const inFlightHandlers = new Map<string, Set<Promise<void>>>();
  /** entryKey -> true while a rebalance is in progress; new messages should pause. */
  const rebalancingConsumers = new Set<string>();
  const createdTopics = new Set<string>();
  const pendingHandlers = new Set<Promise<void>>();
  const pendingBuffer: PendingProduce[] = [];
  const dropCounts: Record<KafkaAdapterDropReason, number> = {
    'serialize-failed': 0,
    'pending-buffer-full': 0,
    'pending-attempts-exhausted': 0,
    'deserialize-failed': 0,
    'null-message-value': 0,
    'shutdown-with-pending': 0,
    'producer-timeout': 0,
    'dlq-production-failed': 0,
    'deserialize-timeout': 0,
    'handler-timeout': 0,
  };
  let totalDrops = 0;
  let lastDropAt: number | null = null;
  let lastDropReason: KafkaAdapterDropReason | null = null;
  let producer: Producer | null = null;
  let admin: Admin | null = null;
  let producerConnected = false;
  let adminConnected = false;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let isDraining = false;
  let isShutdown = false;

  const kafka = new Kafka({
    clientId: config.clientId,
    brokers: config.brokers,
    connectionTimeout: config.connectionTimeout,
    requestTimeout: config.requestTimeout,
    ...(config.sasl ? { sasl: config.sasl } : {}),
    ...(config.ssl != null ? { ssl: config.ssl } : {}),
  });

  const introspection: KafkaAdapterIntrospection = Object.freeze({
    kind: 'slingshot-kafka-adapter',
    topicPrefix: config.topicPrefix,
    topicNameForEvent(event: string): string {
      return toTopicName(config.topicPrefix, event);
    },
  });

  async function ensureProducer(): Promise<Producer> {
    if (producer) return producer;
    const nextProducer = kafka.producer({ idempotent: true, maxInFlightRequests: 5 });
    try {
      // Bound producer.connect() so DNS hangs cannot stall init forever.
      await withTimeout(nextProducer.connect(), config.connectTimeoutMs, 'kafka.producer.connect');
      producer = nextProducer;
      producerConnected = true;
      metrics.gauge('kafka.producer.connected', 1);
      return nextProducer;
    } catch (err) {
      producer = null;
      producerConnected = false;
      metrics.gauge('kafka.producer.connected', 0);
      throw err;
    }
  }

  async function ensureAdmin(): Promise<Admin> {
    if (admin) return admin;
    const nextAdmin = kafka.admin();
    try {
      // Same connect bound as the producer — admin DNS hangs would
      // otherwise block ensureTopic at adapter init.
      await withTimeout(nextAdmin.connect(), config.connectTimeoutMs, 'kafka.admin.connect');
      admin = nextAdmin;
      adminConnected = true;
      return nextAdmin;
    } catch (err) {
      admin = null;
      adminConnected = false;
      throw err;
    }
  }

  async function ensureTopic(topic: string): Promise<void> {
    if (!config.autoCreateTopics || createdTopics.has(topic)) return;
    const ensuredAdmin = await ensureAdmin();
    await ensuredAdmin.createTopics({
      topics: [
        {
          topic,
          numPartitions: config.defaultPartitions,
          replicationFactor: config.replicationFactor,
        },
      ],
    });
    createdTopics.add(topic);
  }

  function scheduleDrain(): void {
    if (drainTimer || isDraining || pendingBuffer.length === 0 || isShutdown) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      void drainPendingBuffer().catch(err => {
        console.error('[KafkaAdapter] failed to drain pending buffer:', err);
      });
    }, DRAIN_INTERVAL_MS);
  }

  async function drainPendingBuffer(): Promise<void> {
    if (isDraining || pendingBuffer.length === 0 || isShutdown) return;
    isDraining = true;
    const entries = pendingBuffer.splice(0, pendingBuffer.length);
    const retry: PendingProduce[] = [];

    try {
      const ensuredProducer = await ensureProducer();

      for (const item of entries) {
        const drainStart = performance.now();
        try {
          await ensureTopic(item.topic);
          await withTimeout(
            ensuredProducer.send({
              topic: item.topic,
              compression: config.compression ? COMPRESSION_CODEC[config.compression] : undefined,
              messages: [
                {
                  key: item.key ?? undefined,
                  value: Buffer.from(item.serialized),
                  headers: item.headers,
                },
              ],
            }),
            config.producerTimeoutMs,
            `kafka.producer.send[${item.topic}]`,
          );
          metrics.counter('kafka.publish.count', 1, { topic: item.topic, result: 'success' });
          metrics.timing('kafka.publish.duration', performance.now() - drainStart, {
            topic: item.topic,
          });
        } catch (err) {
          metrics.counter('kafka.publish.count', 1, { topic: item.topic, result: 'failure' });
          if (err instanceof TimeoutError) {
            metrics.counter('kafka.producer.timeout', 1, { topic: item.topic });
          }
          const next = { ...item, attempts: item.attempts + 1 };
          if (next.attempts >= MAX_PENDING_ATTEMPTS) {
            logger.error('dropping event after pending-attempts exhausted', {
              event: item.event,
              topic: item.topic,
              attempts: MAX_PENDING_ATTEMPTS,
              err: errToString(err),
            });
            notifyDrop({
              reason: 'pending-attempts-exhausted',
              event: item.event,
              topic: item.topic,
              error: err,
            });
          } else {
            retry.push(next);
          }
        }
      }
    } catch (err) {
      logger.error('unable to reconnect while draining buffered events', {
        err: errToString(err),
      });
      pendingBuffer.unshift(...entries);
      metrics.gauge('kafka.pending.size', pendingBuffer.length);
      return;
    } finally {
      isDraining = false;
      if (retry.length > 0) {
        pendingBuffer.push(...retry);
      }
      metrics.gauge('kafka.pending.size', pendingBuffer.length);
      if (pendingBuffer.length > 0) scheduleDrain();
    }
  }

  function hasDurableSubscribersForTopic(topic: string): boolean {
    for (const entry of durableConsumers.values()) {
      if (entry.topic === topic) return true;
    }
    return false;
  }

  function addEnvelopeListener<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (envelope: EventEnvelope<K>) => void | Promise<void>,
  ): void {
    const key = event as string;
    if (!envelopeListeners.has(key)) envelopeListeners.set(key, new Set());
    envelopeListeners.get(key)?.add(listener as (envelope: EventEnvelope) => void | Promise<void>);
  }

  function removeEnvelopeListener<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (envelope: EventEnvelope<K>) => void,
  ): void {
    if (
      durableListeners
        .get(event as string)
        ?.has(listener as (envelope: EventEnvelope) => void | Promise<void>)
    ) {
      throw new KafkaDurableSubscriptionOffError();
    }
    envelopeListeners
      .get(event as string)
      ?.delete(listener as (envelope: EventEnvelope) => void | Promise<void>);
  }

  function registerEnvelopeListener<K extends keyof SlingshotEventMap>(
    event: K,
    listener: (envelope: EventEnvelope<K>) => void | Promise<void>,
    opts?: SubscriptionOpts,
  ): void {
    const key = event as string;
    if (isShutdown) {
      console.warn('[KafkaAdapter] onEnvelope() called after shutdown, ignoring.');
      return;
    }

    if (opts?.durable) {
      if (!opts.name) {
        throw new KafkaDurableSubscriptionNameRequiredError();
      }

      const topic = toTopicName(config.topicPrefix, event as string);
      const groupId = toGroupId(config.groupPrefix, topic, opts.name);
      const entryKey = `${topic}:${opts.name}`;
      if (durableConsumers.has(entryKey)) {
        throw new KafkaDuplicateDurableSubscriptionError(event as string, opts.name);
      }

      const consumer = kafka.consumer({
        groupId,
        sessionTimeout: config.sessionTimeout,
        heartbeatInterval: config.heartbeatInterval,
        allowAutoTopicCreation: config.autoCreateTopics,
      });

      const entry: DurableConsumerEntry = {
        consumer,
        groupId,
        topic,
        event: event as string,
        name: opts.name,
        setupPromise: Promise.resolve(),
        setupState: 'pending',
      };
      durableConsumers.set(entryKey, entry);

      // P-KAFKA-6 + P-KAFKA-2: do NOT register the listener — and do NOT
      // mark the consumer connected — until consumer.connect() and
      // consumer.subscribe() both resolve. If subscribe rejects, the
      // listener never receives messages and the entry is rolled back.
      const setupPromise = (async () => {
        let connected = false;
        try {
          await ensureTopic(topic);
          await withTimeout(
            consumer.connect(),
            config.connectTimeoutMs,
            `kafka.consumer.connect[${groupId}]`,
          );
          connected = true;
          await consumer.subscribe({
            topic,
            fromBeginning: config.startFromBeginning,
          });

          // Subscribe succeeded — only now register the listener so the
          // bus does not believe we're consuming events that we are not.
          if (!durableListeners.has(event as string)) {
            durableListeners.set(event as string, new Set());
          }
          durableListeners
            .get(event as string)
            ?.add(listener as (envelope: EventEnvelope) => void | Promise<void>);

          // Wire rebalance lifecycle hooks BEFORE run() so we don't miss the
          // first GROUP_JOIN. On REBALANCING: pause new processing and flush
          // any pending offsets so the next assignment doesn't double-process.
          // On GROUP_JOIN: resume by clearing the rebalance flag.
          const eventName = event as string;
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
              consumerOn.call(
                consumer,
                consumerEvents.REBALANCING,
                async (rebalanceEvent: unknown) => {
                  // Note: do not delete the consumer from connectedConsumers
                  // here — the GROUP_JOIN that arrives on the very next
                  // round-trip would race the SET maintained by P-KAFKA-2.
                  // The consumer is connected throughout a rebalance.
                  rebalancingConsumers.add(entryKey);
                  logger.info('rebalancing', {
                    event: eventName,
                    group: groupId,
                    topic,
                  });
                  // P-KAFKA-13: wait for in-flight handlers to finish, but
                  // bound each by `handlerTimeoutMs` so a hung handler
                  // cannot block GROUP_JOIN forever (which would trigger
                  // the broker session-timeout loop).
                  const inflight = inFlightHandlers.get(entryKey);
                  if (inflight && inflight.size > 0) {
                    const bounded = Array.from(inflight).map(p =>
                      withTimeout(p, config.handlerTimeoutMs, 'kafka.handler.rebalance').catch(
                        err => {
                          if (err instanceof TimeoutError) {
                            notifyDrop({
                              reason: 'handler-timeout',
                              event: eventName,
                              topic,
                            });
                            logger.warn('handler exceeded handlerTimeoutMs during rebalance', {
                              event: eventName,
                              group: groupId,
                              timeoutMs: config.handlerTimeoutMs,
                            });
                          }
                        },
                      ),
                    );
                    await Promise.allSettled(bounded);
                  }
                  await flushPendingCommits(entryKey);
                  void rebalanceEvent;
                },
              );
              hasGroupJoinHook = true;
              consumerOn.call(consumer, consumerEvents.GROUP_JOIN, (joinEvent: unknown) => {
                // Idempotent set membership — multiple GROUP_JOIN events
                // (after a rebalance) keep the set in the connected state.
                connectedConsumers.add(entryKey);
                rebalancingConsumers.delete(entryKey);
                metrics.gauge('kafka.consumer.connected', 1, { topic, groupId });
                const member = (joinEvent as { payload?: { memberId?: string } } | undefined)
                  ?.payload?.memberId;
                logger.info('group join', {
                  event: eventName,
                  group: groupId,
                  memberId: member ?? 'unknown',
                });
              });
            } catch (instErr) {
              // Instrumentation hooks are best-effort; log and continue.
              logger.warn('failed to register rebalance listeners', {
                group: groupId,
                err: errToString(instErr),
              });
            }
          }

          await consumer.run({
            autoCommit: false,
            partitionsConsumedConcurrently: 1,
            eachMessage: async payload => {
              const e = durableConsumers.get(entryKey);
              if (!e) return;
              await processDurableMessage(
                entryKey,
                e,
                listener as (envelope: EventEnvelope) => void | Promise<void>,
                payload,
              );
            },
          });
          // P-KAFKA-2: only mark connected when both connect + subscribe +
          // run succeed (or after the first GROUP_JOIN, which is wired
          // above).
          if (!hasGroupJoinHook) {
            connectedConsumers.add(entryKey);
            metrics.gauge('kafka.consumer.connected', 1, { topic, groupId });
          }
          entry.setupState = 'subscribed';
        } catch (err) {
          entry.setupState = 'failed';
          entry.setupError = err;
          connectedConsumers.delete(entryKey);
          durableConsumers.delete(entryKey);
          durableListeners
            .get(event as string)
            ?.delete(listener as (envelope: EventEnvelope) => void | Promise<void>);
          if (connected) {
            try {
              await consumer.disconnect();
            } catch (disconnectErr) {
              logger.error('error disconnecting failed consumer', {
                group: groupId,
                err: errToString(disconnectErr),
              });
            }
          }
          logger.error('durable consumer setup failed', {
            event: event as string,
            group: groupId,
            err: errToString(err),
          });
          throw err;
        }
      })();
      // Track the setup promise so shutdown() and tests can observe it.
      // The catch keeps the unhandled-rejection trap quiet — callers that
      // need the error inspect entry.setupState / entry.setupError or
      // await the promise themselves.
      entry.setupPromise = setupPromise.catch(() => undefined);
      return;
    }

    addEnvelopeListener(event, listener);
  }

  async function commitProcessedMessage(
    consumer: Consumer,
    topic: string,
    partition: number,
    message: KafkaMessage,
    entryKey?: string,
  ): Promise<void> {
    const offset = nextOffset(message.offset);
    if (entryKey) {
      // Record the latest known commit point so a rebalance can flush it.
      const partitionMap = pendingCommitOffsets.get(entryKey) ?? new Map<string, string>();
      partitionMap.set(`${topic}|${partition}`, offset);
      pendingCommitOffsets.set(entryKey, partitionMap);
    }
    try {
      await consumer.commitOffsets([{ topic, partition, offset }]);
      // Successful commit clears the recorded pending offset to avoid double-commits.
      if (entryKey) {
        pendingCommitOffsets.get(entryKey)?.delete(`${topic}|${partition}`);
      }
    } catch (err) {
      // P-KAFKA-9: do NOT silently swallow. Log, pause the partition so the
      // broker stops redelivering until the operator (or rebalance) clears
      // the condition, and re-throw so the caller's `eachMessage` chain
      // surfaces the failure to kafkajs (which will trigger a CRASH event
      // and reconnect cycle if the failure persists). Pause is best-effort
      // — kafkajs's pause() requires the active assignment.
      logger.error('failed to commit offset', {
        topic,
        partition,
        offset: message.offset,
        err: errToString(err),
      });
      try {
        const pause = (consumer as { pause?: (args: unknown[]) => void }).pause;
        if (typeof pause === 'function') {
          pause.call(consumer, [{ topic, partitions: [partition] }]);
        }
      } catch {
        // Best-effort — pause() may not be available pre-assignment.
      }
      throw err;
    }
  }

  /**
   * Flush any uncommitted offsets recorded for a consumer entry. Called from
   * the REBALANCING hook so the next assignment doesn't replay messages whose
   * handlers already finished.
   */
  async function flushPendingCommits(entryKey: string): Promise<void> {
    const entry = durableConsumers.get(entryKey);
    const partitionMap = pendingCommitOffsets.get(entryKey);
    if (!entry || !partitionMap || partitionMap.size === 0) return;
    const toCommit: Array<{ topic: string; partition: number; offset: string }> = [];
    for (const [tp, offset] of partitionMap.entries()) {
      const [topic, partitionStr] = tp.split('|');
      if (!topic || partitionStr === undefined) continue;
      toCommit.push({ topic, partition: Number(partitionStr), offset });
    }
    if (toCommit.length === 0) return;
    try {
      await entry.consumer.commitOffsets(toCommit);
      partitionMap.clear();
      console.info(
        `[KafkaAdapter] flushed ${toCommit.length} pending offset(s) for ` +
          `event="${entry.event}" group="${entry.groupId}" before rebalance`,
      );
    } catch (err) {
      console.error(
        `[KafkaAdapter] failed to flush pending offsets during rebalance for "${entry.groupId}":`,
        err,
      );
    }
  }

  async function sendToDlq(
    topic: string,
    partition: number,
    message: KafkaMessage,
    error: unknown,
    suffix: 'dlq' | 'deser-dlq' = 'dlq',
  ): Promise<void> {
    const ensuredProducer = await ensureProducer();
    const dlqTopic = `${topic}.${suffix}`;
    await ensureTopic(dlqTopic);
    // Split error type so downstream consumers can filter corrupt-message
    // (deserialize) from logic-bug (handler) failures without parsing the
    // topic suffix. `x-slingshot-dlq-reason` is the canonical filter header.
    const errorType: 'deserialize' | 'handler' = suffix === 'deser-dlq' ? 'deserialize' : 'handler';
    metrics.counter('kafka.dlq.count', 1, { topic, errorType });
    await withTimeout(
      ensuredProducer.send({
        topic: dlqTopic,
        messages: [
          {
            key: message.key?.toString(),
            value: message.value ? Buffer.from(message.value) : null,
            headers: {
              'slingshot.event': message.headers?.['slingshot.event']?.toString() ?? topic,
              'slingshot.timestamp': Date.now().toString(),
              'slingshot.original-topic': topic,
              'slingshot.original-partition': String(partition),
              'slingshot.original-offset': message.offset,
              'slingshot.error': error instanceof Error ? error.message : String(error),
              'slingshot.error-type': errorType,
              'slingshot.dlq-reason': suffix,
              'x-slingshot-dlq-reason': errorType,
            },
          },
        ],
      }),
      config.producerTimeoutMs,
      `kafka.dlq.send[${dlqTopic}]`,
    );
  }

  async function processDurableMessage(
    entryKey: string,
    entry: DurableConsumerEntry,
    listener: (envelope: EventEnvelope) => void | Promise<void>,
    payload: EachMessagePayload,
  ): Promise<void> {
    const { topic, partition, message, heartbeat } = payload;
    const consumeStart = performance.now();
    metrics.counter('kafka.consume.count', 1, { topic });
    let decodedEnvelope: EventEnvelope;

    // Track this handler so a rebalance can wait for it to finish before
    // flushing offsets. We resolve the tracker after the work below completes.
    let resolveTracker: (() => void) | null = null;
    const tracker = new Promise<void>(resolve => {
      resolveTracker = resolve;
    });
    const inflightSet = inFlightHandlers.get(entryKey) ?? new Set<Promise<void>>();
    inflightSet.add(tracker);
    inFlightHandlers.set(entryKey, inflightSet);
    const finish = () => {
      inflightSet.delete(tracker);
      resolveTracker?.();
    };

    if (!message.value) {
      console.warn(
        `[KafkaAdapter] null message value on topic "${topic}" partition ${partition} ` +
          `offset ${message.offset}; skipping`,
      );
      notifyDrop({
        reason: 'null-message-value',
        event: entry.event,
        topic,
        partition,
        offset: message.offset,
      });
      await commitProcessedMessage(entry.consumer, topic, partition, message, entryKey);
      finish();
      return;
    }

    try {
      // Heartbeat before deserialize so the broker session stays alive even if
      // a large/expensive payload would otherwise block the consumer thread.
      await heartbeat();
      // Yield once to the event loop between batches so other I/O callbacks
      // (and any heartbeat task scheduled by setInterval elsewhere) get CPU.
      // We yield BEFORE deserialize, then run the decode synchronously, so
      // observers (tests, metrics) see a deterministic ordering: yield ->
      // decode -> validate -> next-heartbeat, with no interleaved scheduling
      // surprises depending on the runtime's setImmediate semantics.
      await new Promise<void>(resolve => setImmediate(resolve));
      // P-KAFKA-14: bound the user serializer/deserializer with
      // `deserializeTimeoutMs` so a stalled custom decoder cannot starve
      // the consumer's heartbeat loop.
      const decoded = await withTimeout(
        Promise.resolve().then(() =>
          eventSerializer.deserialize(entry.event, message.value as Buffer),
        ),
        config.deserializeTimeoutMs,
        `kafka.deserialize[${entry.event}]`,
      );
      decodedEnvelope = isEventEnvelope(decoded, entry.event as never)
        ? (decoded as EventEnvelope)
        : createRawEventEnvelope(
            entry.event as Extract<keyof SlingshotEventMap, string>,
            validateEventPayload(
              entry.event,
              decoded,
              schemaRegistry,
              config.validation,
            ) as SlingshotEventMap[Extract<keyof SlingshotEventMap, string>],
          );
      // Heartbeat after deserialize completes so the handler invocation starts
      // with a fresh session deadline.
      await heartbeat();
    } catch (deserializeErr) {
      const isTimeout = deserializeErr instanceof TimeoutError;
      logger.error(isTimeout ? 'deserialize timed out' : 'deserialization error', {
        topic,
        partition,
        offset: message.offset,
        err: errToString(deserializeErr),
      });
      notifyDrop({
        reason: isTimeout ? 'deserialize-timeout' : 'deserialize-failed',
        event: entry.event,
        topic,
        partition,
        offset: message.offset,
        error: deserializeErr,
      });
      // Route undecodable bytes to a deser-specific DLQ so the original
      // payload is recoverable after a schema fix; legacy 'skip' policy
      // only commits and discards.
      if (config.deserializationErrorPolicy === 'dlq') {
        try {
          await sendToDlq(topic, partition, message, deserializeErr, 'deser-dlq');
        } catch (dlqErr) {
          logger.error('failed to publish undecodable message to deser-dlq', {
            topic,
            err: errToString(dlqErr),
          });
        }
      }
      await commitProcessedMessage(entry.consumer, topic, partition, message, entryKey);
      finish();
      return;
    }

    try {
      let handlerSucceeded = false;
      for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
          await Promise.resolve(listener(decodedEnvelope));
          handlerSucceeded = true;
          break;
        } catch (err) {
          if (attempt >= config.maxRetries) {
            // P-KAFKA-8: if the DLQ produce fails, the message is the only
            // record of a poisoned event. With `onDlqFailure: 'redeliver'`
            // (default) we DO NOT commit the offset — the broker will
            // redeliver after restart, and the operator sees the
            // `dlq-production-failed` drop event. With `'commit-and-log'`
            // we accept the lost message in exchange for forward progress
            // (legacy behaviour).
            let dlqDelivered = false;
            try {
              await sendToDlq(topic, partition, message, err);
              dlqDelivered = true;
            } catch (dlqErr) {
              logger.error('failed to publish exhausted message to DLQ', {
                topic,
                err: errToString(dlqErr),
              });
              notifyDrop({
                reason: 'dlq-production-failed',
                event: entry.event,
                topic,
                partition,
                offset: message.offset,
                error: dlqErr,
              });
            }
            if (dlqDelivered || config.onDlqFailure === 'commit-and-log') {
              await commitProcessedMessage(entry.consumer, topic, partition, message, entryKey);
            } else {
              // Skip the commit — broker redelivers on the next round.
              logger.warn('DLQ produce failed; leaving offset uncommitted for redelivery', {
                topic,
                partition,
                offset: message.offset,
              });
            }
            return;
          }
          await waitWithHeartbeat(heartbeat, backoffMs(attempt));
        }
      }
      if (handlerSucceeded) {
        // Commit the offset OUTSIDE the retry try/catch so a commit failure
        // surfaces (P-KAFKA-9) instead of being treated as a handler error.
        await commitProcessedMessage(entry.consumer, topic, partition, message, entryKey);
        metrics.timing('kafka.consume.duration', performance.now() - consumeStart, { topic });
      }
    } finally {
      finish();
    }
  }

  const bus: SlingshotEventBus & {
    readonly __slingshotKafkaAdapter?: KafkaAdapterIntrospection;
    health(): KafkaAdapterHealth;
    getHealth(): HealthReport;
    getHealthSnapshot(): KafkaAdapterHealthSnapshot;
    _drainPendingBuffer(): Promise<void>;
    shutdown(): Promise<void>;
  } = {
    emit<K extends keyof SlingshotEventMap>(event: K, payload: SlingshotEventMap[K]): void {
      if (isShutdown) {
        console.warn('[KafkaAdapter] emit() called after shutdown, ignoring.');
        return;
      }

      const envelope = isEventEnvelope(payload, event)
        ? payload
        : createRawEventEnvelope(
            event as Extract<keyof SlingshotEventMap, string>,
            validateEventPayload(
              event as string,
              payload,
              schemaRegistry,
              config.validation,
            ) as SlingshotEventMap[K],
          );

      const eventListeners = envelopeListeners.get(event as string);
      if (eventListeners) {
        for (const listener of Array.from(eventListeners)) {
          let result: void | Promise<void>;
          try {
            result = listener(envelope as EventEnvelope);
          } catch (err) {
            console.error(`[KafkaAdapter] listener error on event "${event}":`, err);
            continue;
          }
          const promise = Promise.resolve(result);
          pendingHandlers.add(promise);
          promise
            .catch(err => {
              console.error(`[KafkaAdapter] listener error on event "${event}":`, err);
            })
            .finally(() => {
              pendingHandlers.delete(promise);
            });
        }
      }

      const topic = toTopicName(config.topicPrefix, event as string);
      if (!hasDurableSubscribersForTopic(topic)) return;

      void (async () => {
        let key: string | null = null;
        let serialized: Uint8Array | null = null;
        const headers = buildEnvelopeHeaders(
          envelope as EventEnvelope,
          eventSerializer.contentType,
        );
        const publishStart = performance.now();
        try {
          key = resolvePartitionKey(config, event as string, envelope.payload);
          serialized = eventSerializer.serialize(event as string, envelope);
          await ensureTopic(topic);
          const ensuredProducer = await ensureProducer();
          // P-KAFKA-7: bound the produce call. A hung broker would
          // otherwise block this IIFE forever, fill the pending buffer to
          // OOM, and never surface a signal.
          await withTimeout(
            ensuredProducer.send({
              topic,
              compression: config.compression ? COMPRESSION_CODEC[config.compression] : undefined,
              messages: [
                {
                  key: key ?? undefined,
                  value: Buffer.from(serialized),
                  headers,
                },
              ],
            }),
            config.producerTimeoutMs,
            `kafka.producer.send[${topic}]`,
          );
          metrics.counter('kafka.publish.count', 1, { topic, result: 'success' });
          metrics.timing('kafka.publish.duration', performance.now() - publishStart, { topic });
        } catch (err) {
          metrics.counter('kafka.publish.count', 1, { topic, result: 'failure' });
          const isTimeout = err instanceof TimeoutError;
          if (isTimeout) {
            metrics.counter('kafka.producer.timeout', 1, { topic });
          }
          if (!serialized) {
            logger.error('failed to serialize event', {
              event: event as string,
              topic,
              err: errToString(err),
            });
            notifyDrop({
              reason: 'serialize-failed',
              event: event as string,
              topic,
              error: err,
            });
            return;
          }
          if (pendingBuffer.length >= config.pendingBufferSize) {
            logger.error('pending buffer full; dropping event', {
              event: event as string,
              topic,
              err: errToString(err),
            });
            notifyDrop({
              reason: 'pending-buffer-full',
              event: event as string,
              topic,
              error: err,
            });
            return;
          }
          if (isTimeout) {
            // Surface the timeout as a drop signal so operators can alert
            // on producer-timeout independently of the eventual buffer
            // overflow. The event itself is still buffered for retry.
            notifyDrop({
              reason: 'producer-timeout',
              event: event as string,
              topic,
              error: err,
            });
            logger.warn('producer.send timed out; buffering for retry', {
              event: event as string,
              topic,
              timeoutMs: config.producerTimeoutMs,
            });
          }
          pendingBuffer.push({
            topic,
            event: event as string,
            serialized,
            key,
            headers,
            attempts: 1,
          });
          metrics.gauge('kafka.pending.size', pendingBuffer.length);
          scheduleDrain();
        }
      })();
    },

    on<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (payload: SlingshotEventMap[K]) => void | Promise<void>,
      opts?: SubscriptionOpts,
    ): void {
      if (isShutdown) {
        console.warn('[KafkaAdapter] on() called after shutdown, ignoring.');
        return;
      }

      const key = event as string;
      const wrapper = (envelope: EventEnvelope): void | Promise<void> =>
        listener(envelope.payload as SlingshotEventMap[K]);
      let wrappers = payloadListenerWrappers.get(key);
      if (!wrappers) {
        wrappers = new Map();
        payloadListenerWrappers.set(key, wrappers);
      }
      wrappers.set(listener as (payload: unknown) => void | Promise<void>, wrapper);
      registerEnvelopeListener(
        event,
        wrapper as (envelope: EventEnvelope<K>) => void | Promise<void>,
        opts,
      );
    },

    onEnvelope<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (envelope: EventEnvelope<K>) => void | Promise<void>,
      opts?: SubscriptionOpts,
    ): void {
      registerEnvelopeListener(event, listener, opts);
    },

    off<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (payload: SlingshotEventMap[K]) => void,
    ): void {
      const wrappers = payloadListenerWrappers.get(event as string);
      const wrapper = wrappers?.get(listener as (payload: unknown) => void | Promise<void>);
      if (!wrapper) {
        return;
      }
      wrappers?.delete(listener as (payload: unknown) => void | Promise<void>);
      if (wrappers?.size === 0) {
        payloadListenerWrappers.delete(event as string);
      }
      removeEnvelopeListener(event, wrapper as (envelope: EventEnvelope<K>) => void);
    },

    offEnvelope<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (envelope: EventEnvelope<K>) => void,
    ): void {
      removeEnvelopeListener(event, listener);
    },

    async shutdown(): Promise<void> {
      if (isShutdown) return;
      isShutdown = true;

      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }

      envelopeListeners.clear();
      payloadListenerWrappers.clear();
      durableListeners.clear();
      await Promise.allSettled([...pendingHandlers]);

      const consumers = [...durableConsumers.values()];
      durableConsumers.clear();
      connectedConsumers.clear();
      pendingCommitOffsets.clear();
      inFlightHandlers.clear();
      rebalancingConsumers.clear();
      for (const entry of consumers) {
        metrics.gauge('kafka.consumer.connected', 0, {
          topic: entry.topic,
          groupId: entry.groupId,
        });
        // Wait for the entry's setup chain so we don't race a still-in-
        // flight subscribe with disconnect (P-KAFKA-6).
        try {
          await entry.setupPromise;
        } catch {
          // setup already failed; nothing to wait for.
        }
        try {
          await entry.consumer.disconnect();
        } catch (err) {
          logger.error('error disconnecting consumer', {
            group: entry.groupId,
            err: errToString(err),
          });
        }
      }

      if (pendingBuffer.length > 0) {
        logger.warn('shutdown: discarding buffered messages', {
          count: pendingBuffer.length,
        });
        for (const item of pendingBuffer) {
          notifyDrop({
            reason: 'shutdown-with-pending',
            event: item.event,
            topic: item.topic,
          });
        }
        pendingBuffer.length = 0;
      }

      if (producer) {
        try {
          await producer.disconnect();
        } catch (err) {
          logger.error('error disconnecting producer', { err: errToString(err) });
        }
        producer = null;
        producerConnected = false;
        metrics.gauge('kafka.producer.connected', 0);
      }

      if (admin) {
        try {
          await admin.disconnect();
        } catch (err) {
          logger.error('error disconnecting admin client', { err: errToString(err) });
        }
        admin = null;
        adminConnected = false;
      }

      createdTopics.clear();
    },

    health(): KafkaAdapterHealth {
      return {
        producerConnected,
        adminConnected,
        isShutdown,
        pendingBufferSize: pendingBuffer.length,
        consumers: [...durableConsumers.entries()].map(([key, entry]) => ({
          event: entry.event,
          topic: entry.topic,
          name: entry.name,
          groupId: entry.groupId,
          connected: connectedConsumers.has(key),
        })),
        droppedMessages: {
          totalDrops,
          byReason: { ...dropCounts },
          lastDropAt,
          lastDropReason,
        },
      };
    },

    getHealthSnapshot(): KafkaAdapterHealthSnapshot {
      const details = this.health();
      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      if (details.isShutdown) {
        // Shutdown is terminal — always unhealthy.
        status = 'unhealthy';
      } else if (details.pendingBufferSize > 0 && !details.producerConnected) {
        // Buffered events with no producer to drain them — operators need to
        // act before the buffer overflows.
        status = 'unhealthy';
      } else if (details.consumers.some(c => !c.connected)) {
        // A registered durable consumer dropped its connection — degraded.
        // Producer/admin connections are lazy and stay disconnected on a
        // freshly-created adapter, so we do NOT treat their absence as
        // degraded on its own.
        status = 'degraded';
      }
      return { status, details };
    },

    /**
     * `HealthCheck.getHealth()` — returns a `HealthReport` aggregable by
     * the framework's health endpoint. The structured snapshot remains
     * available via `getHealthSnapshot()`.
     */
    getHealth(): HealthReport {
      const snapshot = this.getHealthSnapshot();
      const state: HealthState = snapshot.status;
      return {
        component: 'slingshot-kafka',
        state,
        ...(state === 'healthy'
          ? {}
          : { message: `kafka adapter ${state} (see details for counts)` }),
        details: {
          producerConnected: snapshot.details.producerConnected,
          adminConnected: snapshot.details.adminConnected,
          isShutdown: snapshot.details.isShutdown,
          pendingBufferSize: snapshot.details.pendingBufferSize,
          consumers: snapshot.details.consumers.length,
          consumersConnected: snapshot.details.consumers.filter(c => c.connected).length,
          totalDrops: snapshot.details.droppedMessages.totalDrops,
          lastDropReason: snapshot.details.droppedMessages.lastDropReason,
        },
      };
    },

    _drainPendingBuffer: drainPendingBuffer,
  };

  Object.defineProperties(bus, {
    [ADAPTER_INTROSPECTION_SYMBOL]: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: introspection,
    },
    __slingshotKafkaAdapter: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: introspection,
    },
  });

  console.info(
    `[KafkaAdapter] Adapter created — broker connectivity will be validated on first connect. Brokers: ${config.brokers.join(', ')}`,
  );

  return bus;
}
