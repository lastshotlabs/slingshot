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
  EventEnvelope,
  EventBusSerializationOptions,
  SlingshotEventBus,
  SlingshotEventMap,
  SubscriptionOpts,
} from '@lastshotlabs/slingshot-core';
import {
  JSON_SERIALIZER,
  createRawEventEnvelope,
  isEventEnvelope,
  validateEventPayload,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import {
  COMPRESSION_CODEC,
  backoffMs,
  compressionSchema,
  saslSchema,
  sslSchema,
} from './kafkaShared';
import { toGroupId, toTopicName } from './kafkaTopicNaming';

/**
 * Zod schema for the programmatic Kafka event-bus adapter configuration.
 */
export const kafkaAdapterOptionsSchema = z.object({
  brokers: z.array(z.string()).min(1, 'At least one broker address is required'),
  clientId: z.string().optional(),
  topicPrefix: z.string().optional(),
  groupPrefix: z.string().optional(),
  sasl: saslSchema.optional(),
  ssl: sslSchema.optional(),
  maxRetries: z.number().int().min(1).optional(),
  autoCreateTopics: z.boolean().optional(),
  defaultPartitions: z.number().int().min(1).optional(),
  replicationFactor: z.number().int().min(1).optional(),
  connectionTimeout: z.number().int().min(1000).optional(),
  requestTimeout: z.number().int().min(1000).optional(),
  sessionTimeout: z.number().int().min(6000).optional(),
  heartbeatInterval: z.number().int().min(1000).optional(),
  startFromBeginning: z.boolean().optional(),
  partitionKey: z
    .union([
      z.string(),
      z.custom<(event: string, payload: unknown) => string | null>(
        value => typeof value === 'function',
        'partitionKey function must be (event: string, payload: unknown) => string | null',
      ),
    ])
    .optional(),
  compression: compressionSchema.optional(),
  validation: z.enum(['strict', 'warn', 'off']).optional(),
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
const MAX_PENDING_BUFFER = 1000;
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
  const headers: Record<string, string> = {
    'slingshot.event': envelope.key,
    'slingshot.event-id': envelope.meta.eventId,
    'slingshot.owner-plugin': envelope.meta.ownerPlugin,
    'slingshot.exposure': envelope.meta.exposure.join(','),
    'slingshot.content-type': serializerContentType,
  };
  if (envelope.meta.scope?.tenantId) {
    headers['slingshot.tenant-id'] = envelope.meta.scope.tenantId;
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
  const value = (bus as unknown as Record<PropertyKey, unknown>)[ADAPTER_INTROSPECTION_SYMBOL];
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
  rawOpts: KafkaAdapterOptions & EventBusSerializationOptions,
): SlingshotEventBus & {
  readonly __slingshotKafkaAdapter?: KafkaAdapterIntrospection;
  health(): KafkaAdapterHealth;
  _drainPendingBuffer(): Promise<void>;
} {
  const { serializer, schemaRegistry, ...adapterOpts } = rawOpts;
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
  });

  if (config.heartbeatInterval >= config.sessionTimeout) {
    throw new Error(
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
  const envelopeListeners = new Map<string, Set<(envelope: EventEnvelope) => void | Promise<void>>>();
  const payloadListenerWrappers = new Map<
    string,
    Map<
      (payload: unknown) => void | Promise<void>,
      (envelope: EventEnvelope) => void | Promise<void>
    >
  >();
  const durableListeners = new Map<string, Set<(envelope: EventEnvelope) => void | Promise<void>>>();
  const durableConsumers = new Map<string, DurableConsumerEntry>();
  const connectedConsumers = new Set<string>();
  const createdTopics = new Set<string>();
  const pendingHandlers = new Set<Promise<void>>();
  const pendingBuffer: PendingProduce[] = [];
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
      await nextProducer.connect();
      producer = nextProducer;
      producerConnected = true;
      return nextProducer;
    } catch (err) {
      producer = null;
      producerConnected = false;
      throw err;
    }
  }

  async function ensureAdmin(): Promise<Admin> {
    if (admin) return admin;
    const nextAdmin = kafka.admin();
    try {
      await nextAdmin.connect();
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
        try {
          await ensureTopic(item.topic);
          await ensuredProducer.send({
            topic: item.topic,
            compression: config.compression ? COMPRESSION_CODEC[config.compression] : undefined,
            messages: [
              {
                key: item.key ?? undefined,
                value: Buffer.from(item.serialized),
                headers: item.headers,
              },
            ],
          });
        } catch (err) {
          const next = { ...item, attempts: item.attempts + 1 };
          if (next.attempts >= MAX_PENDING_ATTEMPTS) {
            console.error(
              `[KafkaAdapter] dropping event "${item.event}" for topic "${item.topic}" ` +
                `after ${MAX_PENDING_ATTEMPTS} attempts:`,
              err,
            );
          } else {
            retry.push(next);
          }
        }
      }
    } catch (err) {
      console.error('[KafkaAdapter] unable to reconnect while draining buffered events:', err);
      pendingBuffer.unshift(...entries);
      return;
    } finally {
      isDraining = false;
      if (retry.length > 0) {
        pendingBuffer.push(...retry);
      }
      if (pendingBuffer.length > 0) scheduleDrain();
    }
  }

  function hasDurableSubscribersForTopic(topic: string): boolean {
    for (const entry of durableConsumers.values()) {
      if (entry.topic === topic) return true;
    }
    return false;
  }

  async function commitProcessedMessage(
    consumer: Consumer,
    topic: string,
    partition: number,
    message: KafkaMessage,
  ): Promise<void> {
    await consumer.commitOffsets([{ topic, partition, offset: nextOffset(message.offset) }]);
  }

  async function sendToDlq(
    topic: string,
    partition: number,
    message: KafkaMessage,
    error: unknown,
  ): Promise<void> {
    const ensuredProducer = await ensureProducer();
    const dlqTopic = `${topic}.dlq`;
    await ensureTopic(dlqTopic);
    await ensuredProducer.send({
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
          },
        },
      ],
    });
  }

  async function processDurableMessage(
    entryKey: string,
    entry: DurableConsumerEntry,
    listener: (envelope: EventEnvelope) => void | Promise<void>,
    payload: EachMessagePayload,
  ): Promise<void> {
    const { topic, partition, message, heartbeat } = payload;
    let decodedEnvelope: EventEnvelope;

    if (!message.value) {
      console.warn(
        `[KafkaAdapter] null message value on topic "${topic}" partition ${partition} ` +
          `offset ${message.offset}; skipping`,
      );
      await commitProcessedMessage(entry.consumer, topic, partition, message);
      return;
    }

    try {
      const decoded = eventSerializer.deserialize(entry.event, message.value);
      decodedEnvelope = isEventEnvelope(decoded, entry.event as never)
        ? (decoded as EventEnvelope)
        : createRawEventEnvelope(
            entry.event as Extract<keyof SlingshotEventMap, string>,
            validateEventPayload(entry.event, decoded, schemaRegistry, config.validation) as
              SlingshotEventMap[Extract<keyof SlingshotEventMap, string>],
          );
    } catch (deserializeErr) {
      console.error(
        `[KafkaAdapter] deserialization error on topic "${topic}" partition ${partition} ` +
          `offset ${message.offset}:`,
        deserializeErr,
      );
      await commitProcessedMessage(entry.consumer, topic, partition, message);
      return;
    }

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        await Promise.resolve(listener(decodedEnvelope));
        await commitProcessedMessage(entry.consumer, topic, partition, message);
        return;
      } catch (err) {
        if (attempt >= config.maxRetries) {
          try {
            await sendToDlq(topic, partition, message, err);
          } catch (dlqErr) {
            console.error('[KafkaAdapter] failed to publish exhausted message to DLQ:', dlqErr);
          }
          await commitProcessedMessage(entry.consumer, topic, partition, message);
          return;
        }
        await waitWithHeartbeat(heartbeat, backoffMs(attempt));
      }
    }
  }

  const bus: SlingshotEventBus & {
    readonly __slingshotKafkaAdapter?: KafkaAdapterIntrospection;
    health(): KafkaAdapterHealth;
    _drainPendingBuffer(): Promise<void>;
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
            validateEventPayload(event as string, payload, schemaRegistry, config.validation) as
              SlingshotEventMap[K],
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
        const headers = buildEnvelopeHeaders(envelope as EventEnvelope, eventSerializer.contentType);
        try {
          key = resolvePartitionKey(config, event as string, envelope.payload);
          serialized = eventSerializer.serialize(event as string, envelope);
          await ensureTopic(topic);
          const ensuredProducer = await ensureProducer();
          await ensuredProducer.send({
            topic,
            compression: config.compression ? COMPRESSION_CODEC[config.compression] : undefined,
            messages: [
              {
                key: key ?? undefined,
                value: Buffer.from(serialized),
                headers,
              },
            ],
          });
        } catch (err) {
          if (!serialized) {
            console.error(
              `[KafkaAdapter] failed to serialize event "${event}" for topic "${topic}":`,
              err,
            );
            return;
          }
          if (pendingBuffer.length >= MAX_PENDING_BUFFER) {
            console.error(
              `[KafkaAdapter] pending buffer full; dropping event "${event}" for topic "${topic}":`,
              err,
            );
            return;
          }
          pendingBuffer.push({
            topic,
            event: event as string,
            serialized,
            key,
            headers,
            attempts: 1,
          });
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
      this.onEnvelope(event, wrapper as (envelope: EventEnvelope<K>) => void | Promise<void>, opts);
    },

    onEnvelope<K extends keyof SlingshotEventMap>(
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
          throw new Error('[KafkaAdapter] durable subscriptions require a name. Pass opts.name.');
        }

        const topic = toTopicName(config.topicPrefix, event as string);
        const groupId = toGroupId(config.groupPrefix, topic, opts.name);
        const entryKey = `${topic}:${opts.name}`;
        if (durableConsumers.has(entryKey)) {
          throw new Error(
            `[KafkaAdapter] a durable subscription named "${opts.name}" for event "${event}" already exists.`,
          );
        }

        const consumer = kafka.consumer({
          groupId,
          sessionTimeout: config.sessionTimeout,
          heartbeatInterval: config.heartbeatInterval,
          allowAutoTopicCreation: config.autoCreateTopics,
        });

        durableConsumers.set(entryKey, {
          consumer,
          groupId,
          topic,
          event: event as string,
          name: opts.name,
        });
        if (!durableListeners.has(event as string)) {
          durableListeners.set(event as string, new Set());
        }
        durableListeners
          .get(event as string)
          ?.add(listener as (envelope: EventEnvelope) => void | Promise<void>);

        void (async () => {
          try {
            await ensureTopic(topic);
            await consumer.connect();
            connectedConsumers.add(entryKey);
            await consumer.subscribe({
              topic,
              fromBeginning: config.startFromBeginning,
            });
            await consumer.run({
              autoCommit: false,
              eachMessage: async payload => {
                const entry = durableConsumers.get(entryKey);
                if (!entry) return;
                await processDurableMessage(
                  entryKey,
                  entry,
                  listener as (envelope: EventEnvelope) => void | Promise<void>,
                  payload,
                );
              },
            });
          } catch (err) {
            connectedConsumers.delete(entryKey);
            durableConsumers.delete(entryKey);
            durableListeners
              .get(event as string)
              ?.delete(listener as (envelope: EventEnvelope) => void | Promise<void>);
            console.error(
              `[KafkaAdapter] durable consumer setup failed for event "${event}" group "${groupId}":`,
              err,
            );
          }
        })();
        return;
      }

      if (!envelopeListeners.has(key)) envelopeListeners.set(key, new Set());
      envelopeListeners
        .get(key)
        ?.add(listener as (envelope: EventEnvelope) => void | Promise<void>);
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
      this.offEnvelope(event, wrapper as (envelope: EventEnvelope<K>) => void);
    },

    offEnvelope<K extends keyof SlingshotEventMap>(
      event: K,
      listener: (envelope: EventEnvelope<K>) => void,
    ): void {
      if (
        durableListeners
          .get(event as string)
          ?.has(listener as (envelope: EventEnvelope) => void | Promise<void>)
      ) {
        throw new Error(
          '[KafkaAdapter] cannot remove a durable subscription via off(). Use shutdown() to close all consumers.',
        );
      }
      envelopeListeners
        .get(event as string)
        ?.delete(listener as (envelope: EventEnvelope) => void | Promise<void>);
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
      for (const entry of consumers) {
        try {
          await entry.consumer.disconnect();
        } catch (err) {
          console.error(`[KafkaAdapter] error disconnecting consumer "${entry.groupId}":`, err);
        }
      }

      if (pendingBuffer.length > 0) {
        console.warn(
          `[KafkaAdapter] shutdown: discarding ${pendingBuffer.length} buffered message(s).`,
        );
        pendingBuffer.length = 0;
      }

      if (producer) {
        try {
          await producer.disconnect();
        } catch (err) {
          console.error('[KafkaAdapter] error disconnecting producer:', err);
        }
        producer = null;
        producerConnected = false;
      }

      if (admin) {
        try {
          await admin.disconnect();
        } catch (err) {
          console.error('[KafkaAdapter] error disconnecting admin client:', err);
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

  return bus;
}
