import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  createEventEnvelope,
  createEventSchemaRegistry,
  createInProcessAdapter,
} from '@lastshotlabs/slingshot-core';
import {
  createKafkaAdapter,
  createKafkaConnectors,
  getKafkaAdapterIntrospectionOrNull,
} from '@lastshotlabs/slingshot-kafka';
import {
  Kafka,
  type KafkaMessage,
  type Message,
} from '../../packages/slingshot-kafka/node_modules/kafkajs';
import { createServerFromManifest } from '../../src/lib/createServerFromManifest';
import { createManifestHandlerRegistry } from '../../src/lib/manifestHandlerRegistry';
import { getServerContext } from '../../src/server';

process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

const KAFKA_BROKER = 'localhost:19092';
const KAFKA_TEST_TIMEOUT_MS = 30_000;
const RUN_ID = Date.now();

type RunningServer = {
  port: number;
  stop(close?: boolean): void | Promise<void>;
};

type CollectedKafkaMessage = {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
};

const cleanup: Array<() => Promise<void>> = [];

function uniqueName(label: string): string {
  return `${label}-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
}

function headersToStrings(headers: KafkaMessage['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    result[key] = Buffer.isBuffer(value) ? value.toString() : String(value);
  }

  return result;
}

function createConnectorEnvelope(event: string, payload: unknown) {
  return createEventEnvelope({
    key: event as never,
    payload: payload as never,
    ownerPlugin: 'slingshot-kafka-docker-test',
    exposure: ['connector'],
    scope: null,
    source: 'connector',
    requestTenantId: null,
  });
}

function parseKafkaPayload<T = unknown>(value: string | null): T {
  const parsed = JSON.parse(value ?? 'null') as unknown;
  if (
    parsed &&
    typeof parsed === 'object' &&
    'payload' in parsed &&
    'key' in parsed &&
    'meta' in parsed
  ) {
    return (parsed as { payload: T }).payload;
  }
  return parsed as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function runCleanupWithTimeout(fn: () => Promise<void>, ms = 5_000): Promise<void> {
  await Promise.race([fn().catch(() => {}), sleep(ms)]);
}

async function waitFor(
  condition: () => boolean,
  ms = 15_000,
  message = 'waitFor timed out',
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await sleep(50);
  }
}

async function createAdmin() {
  const kafka = new Kafka({
    clientId: uniqueName('docker-admin'),
    brokers: [KAFKA_BROKER],
  });
  const admin = kafka.admin();
  await admin.connect();
  cleanup.push(async () => {
    await admin.disconnect().catch(() => {});
  });
  return admin;
}

async function createProducer() {
  const kafka = new Kafka({
    clientId: uniqueName('docker-producer'),
    brokers: [KAFKA_BROKER],
  });
  const producer = kafka.producer();
  await producer.connect();
  cleanup.push(async () => {
    await producer.disconnect().catch(() => {});
  });
  return producer;
}

async function ensureTopic(topic: string, numPartitions = 1): Promise<void> {
  const admin = await createAdmin();
  await admin.createTopics({
    waitForLeaders: true,
    topics: [{ topic, numPartitions, replicationFactor: 1 }],
  });
}

async function collectKafkaMessages(
  topic: string,
  opts?: { fromBeginning?: boolean; groupId?: string },
): Promise<CollectedKafkaMessage[]> {
  const kafka = new Kafka({
    clientId: uniqueName('docker-consumer'),
    brokers: [KAFKA_BROKER],
  });
  const consumer = kafka.consumer({
    groupId: opts?.groupId ?? uniqueName(`collector.${topic}`),
  });
  const messages: CollectedKafkaMessage[] = [];

  await consumer.connect();
  await consumer.subscribe({
    topic,
    fromBeginning: opts?.fromBeginning ?? false,
  });
  await consumer.run({
    eachMessage: async payload => {
      messages.push({
        topic: payload.topic,
        partition: payload.partition,
        offset: payload.message.offset,
        key: payload.message.key?.toString() ?? null,
        value: payload.message.value?.toString() ?? null,
        headers: headersToStrings(payload.message.headers),
      });
    },
  });
  cleanup.push(async () => {
    await consumer.disconnect().catch(() => {});
  });

  await sleep(300);
  return messages;
}

async function createTempKafkaManifest(
  content: Record<string, unknown>,
): Promise<{ dir: string; path: string }> {
  const dir = join(process.cwd(), '.tmp', 'kafka-docker', uniqueName('manifest')).replaceAll(
    '\\',
    '/',
  );
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/app.manifest.json`;
  writeFileSync(path, JSON.stringify(content, null, 2), 'utf-8');
  cleanup.push(async () => {
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path };
}

async function createKafkaProxy(): Promise<{
  broker: string;
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const upstreams = new Set<net.Socket>();
  let paused = false;

  const server = net.createServer(client => {
    if (paused) {
      client.destroy();
      return;
    }

    const upstream = net.connect({
      host: '127.0.0.1',
      port: 19092,
    });

    sockets.add(client);
    upstreams.add(upstream);

    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      upstreams.delete(upstream);
      client.destroy();
    });
    client.on('error', () => {});
    upstream.on('error', () => {});

    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Kafka proxy failed to bind to a TCP port');
  }

  const destroyTrackedSockets = () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    for (const upstream of upstreams) {
      upstream.destroy();
    }
  };

  return {
    broker: `127.0.0.1:${address.port}`,
    pause() {
      paused = true;
      destroyTrackedSockets();
    },
    resume() {
      paused = false;
    },
    async close() {
      paused = true;
      destroyTrackedSockets();
      await new Promise<void>(resolve => {
        server.close(() => resolve());
      });
    },
  };
}

afterEach(async () => {
  const pending = cleanup.splice(0, cleanup.length).reverse();
  await Promise.allSettled(pending.map(fn => runCleanupWithTimeout(fn)));
}, KAFKA_TEST_TIMEOUT_MS);

describe('Kafka runtime paths (Docker)', () => {
  test(
    'Kafka adapter enforces strict publish validation and skips invalid consumed payloads',
    async () => {
      const registry = createEventSchemaRegistry();
      registry.register(
        'auth:login',
        z.object({
          userId: z.string().transform(value => value.toUpperCase()),
          sessionId: z.string(),
        }),
      );

      const bus = createKafkaAdapter({
        brokers: [KAFKA_BROKER],
        topicPrefix: uniqueName('slingshot.runtime.validation'),
        groupPrefix: uniqueName('slingshot.runtime.group'),
        schemaRegistry: registry,
        validation: 'strict',
      });
      cleanup.push(() => bus.shutdown?.() ?? Promise.resolve());

      const introspection = getKafkaAdapterIntrospectionOrNull(bus);
      if (!introspection) {
        throw new Error('Kafka adapter introspection missing');
      }

      const topic = introspection.topicNameForEvent('auth:login');
      const brokerMessages = await collectKafkaMessages(topic);
      const producer = await createProducer();

      const received: Array<{ userId: string; sessionId: string }> = [];
      bus.on(
        'auth:login',
        payload => {
          received.push(payload);
        },
        { durable: true, name: uniqueName('strict-worker') },
      );

      await waitFor(
        () => bus.health().consumers[0]?.connected === true,
        15_000,
        'Kafka adapter durable consumer did not connect',
      );

      expect(() => {
        bus.emit('auth:login', { userId: 'bad' } as never);
      }).toThrow('validation failed');

      await sleep(600);
      expect(received).toHaveLength(0);
      expect(brokerMessages).toHaveLength(0);

      bus.emit('auth:login', { userId: 'docker-user', sessionId: 'session-1' });

      await waitFor(
        () => brokerMessages.length === 1,
        15_000,
        'Kafka publish did not reach broker',
      );
      await waitFor(
        () => received.length === 1,
        15_000,
        'Kafka adapter did not receive the valid durable message',
      );

      expect(
        parseKafkaPayload<{ userId: string; sessionId: string }>(brokerMessages[0]!.value),
      ).toEqual({
        userId: 'DOCKER-USER',
        sessionId: 'session-1',
      });
      expect(received).toEqual([{ userId: 'DOCKER-USER', sessionId: 'session-1' }]);

      await producer.send({
        topic,
        messages: [
          {
            key: 'invalid',
            value: Buffer.from(JSON.stringify({ userId: 'raw-user', sessionId: 42 })),
          },
          {
            key: 'valid',
            value: Buffer.from(JSON.stringify({ userId: 'raw-user', sessionId: 'session-2' })),
          },
        ],
      });

      await sleep(800);
      expect(received).toEqual([
        { userId: 'DOCKER-USER', sessionId: 'session-1' },
        { userId: 'RAW-USER', sessionId: 'session-2' },
      ]);
    },
    KAFKA_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka outbound connectors apply shared schema validation before publishing to Kafka',
    async () => {
      const registry = createEventSchemaRegistry();
      registry.register(
        'auth:user.created',
        z.object({
          userId: z.string().transform(value => `user:${value}`),
        }),
      );

      const bus = createInProcessAdapter();
      const topic = uniqueName('external.users.schema');
      const collector = await collectKafkaMessages(topic);
      const connectors = createKafkaConnectors({
        brokers: [KAFKA_BROKER],
        schemaRegistry: registry,
        validationMode: 'strict',
        outbound: [
          {
            event: 'auth:user.created',
            topic,
            autoCreateTopic: true,
          },
        ],
      });
      cleanup.push(() => connectors.stop());

      await connectors.start(bus);
      await sleep(400);

      bus.emit(
        'auth:user.created',
        createConnectorEnvelope('auth:user.created', { userId: 'abc' }),
      );

      await waitFor(
        () => collector.length === 1,
        15_000,
        'Outbound connector did not publish the schema-validated message',
      );
      expect(parseKafkaPayload<{ userId: string }>(collector[0]!.value)).toEqual({
        userId: 'user:abc',
      });
      expect(connectors.health().outbound[0]?.messagesProduced).toBe(1);
    },
    KAFKA_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka inbound connectors send exhausted failures to an auto-created DLQ',
    async () => {
      const topic = uniqueName('incoming.billing.failures');
      const dlqTopic = `${topic}.dlq`;
      await ensureTopic(topic);

      const handler = mock(async () => {
        throw new Error('handler failed');
      });
      const connectors = createKafkaConnectors({
        brokers: [KAFKA_BROKER],
        inbound: [
          {
            topic,
            groupId: uniqueName('billing-sync'),
            maxRetries: 1,
            errorStrategy: 'dlq',
            autoCreateDLQ: true,
            handler,
          },
        ],
      });
      cleanup.push(() => connectors.stop());

      await connectors.start(createInProcessAdapter());
      await waitFor(
        () => connectors.health().inbound[0]?.status === 'active',
        15_000,
        'Inbound connector did not become active',
      );

      const producer = await createProducer();
      await producer.send({
        topic,
        messages: [{ key: 'invoice-1', value: Buffer.from(JSON.stringify({ id: 'invoice-1' })) }],
      });

      await waitFor(
        () => connectors.health().inbound[0]?.messagesDLQ === 1,
        15_000,
        'Inbound connector did not route the exhausted message to DLQ',
      );

      const dlqMessages = await collectKafkaMessages(dlqTopic, { fromBeginning: true });
      await waitFor(() => dlqMessages.length === 1, 15_000, 'DLQ message was not written to Kafka');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(parseKafkaPayload<{ id: string }>(dlqMessages[0]!.value)).toEqual({
        id: 'invoice-1',
      });
      expect(dlqMessages[0]!.headers['slingshot.original-topic']).toBe(topic);
      expect(dlqMessages[0]!.headers['slingshot.original-offset']).toBeDefined();
    },
    KAFKA_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka inbound connectors honor maxRetries: 0 and still process once before DLQ',
    async () => {
      const topic = uniqueName('incoming.once');
      const dlqTopic = `${topic}.dlq`;
      await ensureTopic(topic);

      const handler = mock(async () => {
        throw new Error('failed once');
      });
      const connectors = createKafkaConnectors({
        brokers: [KAFKA_BROKER],
        inbound: [
          {
            topic,
            groupId: uniqueName('once-only'),
            maxRetries: 0,
            errorStrategy: 'dlq',
            autoCreateDLQ: true,
            handler,
          },
        ],
      });
      cleanup.push(() => connectors.stop());

      await connectors.start(createInProcessAdapter());
      await waitFor(
        () => connectors.health().inbound[0]?.status === 'active',
        15_000,
        'Inbound connector did not become active',
      );

      const producer = await createProducer();
      await producer.send({
        topic,
        messages: [{ key: 'once-1', value: Buffer.from(JSON.stringify({ id: 'once-1' })) }],
      });

      await waitFor(
        () => connectors.health().inbound[0]?.messagesDLQ === 1,
        15_000,
        'maxRetries: 0 message did not reach DLQ',
      );

      const dlqMessages = await collectKafkaMessages(dlqTopic, { fromBeginning: true });
      await waitFor(
        () => dlqMessages.length === 1,
        15_000,
        'DLQ message for maxRetries: 0 was not written',
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(parseKafkaPayload<{ id: string }>(dlqMessages[0]!.value)).toEqual({
        id: 'once-1',
      });
    },
    KAFKA_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka inbound connectors process partitions concurrently when concurrency is raised',
    async () => {
      const topic = uniqueName('incoming.concurrent');
      await ensureTopic(topic, 3);

      let inFlight = 0;
      let maxInFlight = 0;
      const started = new Set<string>();
      let releaseHandlers!: () => void;
      const releasePromise = new Promise<void>(resolve => {
        releaseHandlers = resolve;
      });

      const connectors = createKafkaConnectors({
        brokers: [KAFKA_BROKER],
        inbound: [
          {
            topic,
            groupId: uniqueName('concurrency'),
            concurrency: 3,
            fromBeginning: true,
            handler: async payload => {
              const id = String((payload as { id: string }).id);
              started.add(id);
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              try {
                await releasePromise;
              } finally {
                inFlight -= 1;
              }
            },
          },
        ],
      });
      cleanup.push(() => connectors.stop());

      const producer = await createProducer();
      const messages: Message[] = [
        {
          partition: 0,
          key: 'partition-0',
          value: Buffer.from(JSON.stringify({ id: 'partition-0' })),
        },
        {
          partition: 1,
          key: 'partition-1',
          value: Buffer.from(JSON.stringify({ id: 'partition-1' })),
        },
        {
          partition: 2,
          key: 'partition-2',
          value: Buffer.from(JSON.stringify({ id: 'partition-2' })),
        },
      ];
      await producer.send({ topic, messages });

      await connectors.start(createInProcessAdapter());
      await waitFor(
        () => connectors.health().inbound[0]?.status === 'active',
        15_000,
        'Inbound connector did not become active',
      );

      try {
        await waitFor(
          () => started.size >= 2 && maxInFlight > 1,
          15_000,
          'Inbound connector did not process partitions concurrently',
        );
        expect(maxInFlight).toBeGreaterThan(1);
      } finally {
        releaseHandlers();
      }

      await waitFor(
        () => connectors.health().inbound[0]?.messagesProcessed === 3,
        15_000,
        'Concurrent handlers did not finish processing all messages',
      );
    },
    KAFKA_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka adapter buffers publishes across a broker disconnect and drains after reconnect',
    async () => {
      const proxy = await createKafkaProxy();
      cleanup.push(() => proxy.close());

      const bus = createKafkaAdapter({
        brokers: [proxy.broker],
        topicPrefix: uniqueName('slingshot.runtime.buffer'),
        groupPrefix: uniqueName('slingshot.runtime.group'),
      });
      cleanup.push(() => bus.shutdown?.() ?? Promise.resolve());

      const introspection = getKafkaAdapterIntrospectionOrNull(bus);
      if (!introspection) {
        throw new Error('Kafka adapter introspection missing');
      }

      const topic = introspection.topicNameForEvent('auth:login');
      const collector = await collectKafkaMessages(topic);
      bus.on('auth:login', () => {}, { durable: true, name: uniqueName('buffer-worker') });

      await waitFor(
        () => bus.health().consumers[0]?.connected === true,
        15_000,
        'Kafka adapter durable consumer did not connect',
      );

      proxy.pause();
      bus.emit('auth:login', { userId: 'buffered-user', sessionId: 'buffered-session' });

      await waitFor(
        () => bus.health().pendingBufferSize === 1,
        15_000,
        'Kafka adapter did not buffer the failed publish',
      );

      proxy.resume();
      await bus._drainPendingBuffer();

      await waitFor(
        () => bus.health().pendingBufferSize === 0,
        15_000,
        'Kafka adapter pending buffer did not drain after reconnect',
      );
      await waitFor(
        () => collector.length === 1,
        15_000,
        'Buffered Kafka adapter publish did not reach the broker after reconnect',
      );

      expect(parseKafkaPayload<{ userId: string; sessionId: string }>(collector[0]!.value)).toEqual(
        {
          userId: 'buffered-user',
          sessionId: 'buffered-session',
        },
      );
    },
    KAFKA_TEST_TIMEOUT_MS,
  );

  test(
    'overlapping Kafka adapter and outbound connector routes warn and publish duplicate messages',
    async () => {
      const bus = createKafkaAdapter({
        brokers: [KAFKA_BROKER],
        topicPrefix: uniqueName('slingshot.runtime.duplicate'),
        groupPrefix: uniqueName('slingshot.runtime.group'),
      });
      cleanup.push(() => bus.shutdown?.() ?? Promise.resolve());

      const introspection = getKafkaAdapterIntrospectionOrNull(bus);
      if (!introspection) {
        throw new Error('Kafka adapter introspection missing');
      }

      const event = 'auth:login';
      const topic = introspection.topicNameForEvent(event);
      await ensureTopic(topic);

      const warned = mock((_message: unknown) => {});
      const originalWarn = console.warn;
      console.warn = warned;

      try {
        bus.on(event, () => {}, { durable: true, name: uniqueName('duplicate-worker') });
        await waitFor(
          () => bus.health().consumers[0]?.connected === true,
          15_000,
          'Kafka adapter durable consumer did not connect',
        );

        const collector = await collectKafkaMessages(topic);
        const connectors = createKafkaConnectors({
          brokers: [KAFKA_BROKER],
          outbound: [{ event, topic, autoCreateTopic: true }],
        });
        cleanup.push(() => connectors.stop());

        await connectors.start(bus);
        await sleep(400);

        bus.emit(
          event,
          createConnectorEnvelope(event, {
            userId: 'duplicate-user',
            sessionId: 'duplicate-session',
          }) as never,
        );

        await waitFor(
          () => collector.length === 2,
          15_000,
          'Expected duplicate publishes were not observed on Kafka',
        );

        expect(
          warned.mock.calls.some(call =>
            String(call[0]).includes('also produced by the internal Kafka event bus adapter'),
          ),
        ).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    },
    KAFKA_TEST_TIMEOUT_MS,
  );

  test(
    'manifest bootstrap wires Kafka event bus and connectors against the live broker',
    async () => {
      const previousEnv = {
        KAFKA_BROKERS: process.env.KAFKA_BROKERS,
        KAFKA_CLIENT_ID: process.env.KAFKA_CLIENT_ID,
      };
      process.env.KAFKA_BROKERS = KAFKA_BROKER;
      process.env.KAFKA_CLIENT_ID = uniqueName('manifest-kafka');
      cleanup.push(async () => {
        if (previousEnv.KAFKA_BROKERS !== undefined) {
          process.env.KAFKA_BROKERS = previousEnv.KAFKA_BROKERS;
        } else {
          delete process.env.KAFKA_BROKERS;
        }
        if (previousEnv.KAFKA_CLIENT_ID !== undefined) {
          process.env.KAFKA_CLIENT_ID = previousEnv.KAFKA_CLIENT_ID;
        } else {
          delete process.env.KAFKA_CLIENT_ID;
        }
      });

      const inboundTopic = uniqueName('manifest.inbound');
      const outboundTopic = uniqueName('manifest.outbound');
      await ensureTopic(inboundTopic);
      await ensureTopic(outboundTopic);

      const registry = createManifestHandlerRegistry();
      const inboundPayloads: Array<{
        payload: unknown;
        metadata: Record<string, unknown>;
      }> = [];
      registry.registerHandler('captureKafkaInbound', () => {
        return async (payload: unknown, metadata: Record<string, unknown>) => {
          inboundPayloads.push({ payload, metadata });
        };
      });

      const manifest = await createTempKafkaManifest({
        manifestVersion: 1,
        handlers: false,
        port: 0,
        meta: { name: 'Kafka Docker Manifest', version: '1.0.0' },
        security: { rateLimit: false },
        db: {
          sqlite: `${process.cwd().replaceAll('\\', '/')}/.tmp/${uniqueName('manifest-db')}.sqlite`,
          auth: 'sqlite',
          sessions: 'sqlite',
          redis: false,
        },
        eventBus: {
          type: 'kafka',
          config: {
            topicPrefix: uniqueName('manifest.events'),
            groupPrefix: uniqueName('manifest.groups'),
          },
        },
        kafkaConnectors: {
          inbound: [
            {
              topic: inboundTopic,
              groupId: uniqueName('manifest-inbound'),
              handler: 'captureKafkaInbound',
            },
          ],
          outbound: [
            {
              event: 'auth:user.created',
              topic: outboundTopic,
            },
          ],
        },
      });

      const server = (await createServerFromManifest(
        manifest.path,
        registry,
      )) as unknown as RunningServer;
      cleanup.push(async () => {
        const ctx = getServerContext(server);
        await server.stop(true);
        await ctx?.destroy?.();
      });

      const ctx = getServerContext(server);
      if (!ctx) {
        throw new Error('Server context missing');
      }

      const outboundMessages = await collectKafkaMessages(outboundTopic);

      ctx.bus.emit(
        'auth:user.created',
        createConnectorEnvelope('auth:user.created', {
          userId: 'manifest-user',
          email: 'manifest@example.com',
        }) as never,
      );

      await waitFor(
        () => outboundMessages.length === 1,
        15_000,
        'Manifest outbound connector did not publish to Kafka',
      );
      expect(
        parseKafkaPayload<{ userId: string; email: string }>(outboundMessages[0]!.value),
      ).toEqual({
        userId: 'manifest-user',
        email: 'manifest@example.com',
      });

      const producer = await createProducer();
      await producer.send({
        topic: inboundTopic,
        messages: [{ key: 'inbound-1', value: Buffer.from(JSON.stringify({ id: 'inbound-1' })) }],
      });

      await waitFor(
        () => inboundPayloads.length === 1,
        15_000,
        'Manifest inbound connector did not receive the Kafka message',
      );
      expect(inboundPayloads[0]?.payload).toEqual({ id: 'inbound-1' });
      expect(inboundPayloads[0]?.metadata['topic']).toBe(inboundTopic);
    },
    KAFKA_TEST_TIMEOUT_MS,
  );
});
