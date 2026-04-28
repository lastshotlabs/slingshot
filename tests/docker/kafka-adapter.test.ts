import { afterEach, describe, expect, test } from 'bun:test';
import { createEventEnvelope, createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createKafkaAdapter, createKafkaConnectors } from '@lastshotlabs/slingshot-kafka';

process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

const KAFKA_BROKER = 'localhost:19092';
const KAFKA_TEST_TIMEOUT_MS = 30_000;
const RUN_ID = Date.now();

function uniqueName(label: string): string {
  return `${label}-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
}

async function waitFor(condition: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function runCleanupWithTimeout(fn: () => Promise<void>, ms = 10_000): Promise<void> {
  await Promise.race([fn().catch(() => {}), sleep(ms)]);
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

function unwrapEventEnvelopePayload<T = unknown>(value: unknown): T {
  if (
    value &&
    typeof value === 'object' &&
    'payload' in value &&
    'key' in value &&
    'meta' in value
  ) {
    return (value as { payload: T }).payload;
  }
  return value as T;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = cleanup.splice(0, cleanup.length).reverse();
  await Promise.allSettled(pending.map(fn => runCleanupWithTimeout(fn)));
}, KAFKA_TEST_TIMEOUT_MS);

describe('Kafka adapter and connectors (Docker)', () => {
  test(
    'Kafka adapter durable subscriptions round-trip through the broker',
    async () => {
      const bus = createKafkaAdapter({
        brokers: [KAFKA_BROKER],
        topicPrefix: uniqueName('slingshot.kafka'),
        groupPrefix: uniqueName('slingshot.group'),
      });
      cleanup.push(() => bus.shutdown?.() ?? Promise.resolve());

      const received: Array<{ userId: string; sessionId: string }> = [];
      bus.on(
        'auth:login',
        payload => {
          received.push(payload);
        },
        { durable: true, name: uniqueName('login-worker') },
      );

      await waitFor(() => bus.health().consumers[0]?.connected === true);

      bus.emit('auth:login', { userId: 'docker-user', sessionId: 'docker-session' });

      await waitFor(() => received.length === 1);
      expect(received).toEqual([{ userId: 'docker-user', sessionId: 'docker-session' }]);
    },
    KAFKA_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka connectors bridge bus events through Kafka topics',
    async () => {
      const bus = createInProcessAdapter();
      const topic = uniqueName('external.users');
      const groupId = uniqueName('user-sync');
      const received: unknown[] = [];

      const connectors = createKafkaConnectors({
        brokers: [KAFKA_BROKER],
        inbound: [
          {
            topic,
            groupId,
            handler: payload => {
              received.push(payload);
            },
          },
        ],
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
      await new Promise(resolve => setTimeout(resolve, 500));

      bus.emit(
        'auth:user.created',
        createConnectorEnvelope('auth:user.created', {
          userId: 'connector-user',
          email: 'connector@example.com',
        }) as never,
      );

      await waitFor(() => received.length === 1);
      expect(received.map(unwrapEventEnvelopePayload)).toEqual([
        { userId: 'connector-user', email: 'connector@example.com' },
      ]);
    },
    KAFKA_TEST_TIMEOUT_MS,
  );
});
