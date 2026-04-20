import { afterEach, describe, expect, test } from 'bun:test';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createKafkaAdapter, createKafkaConnectors } from '@lastshotlabs/slingshot-kafka';

process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

const KAFKA_BROKER = 'localhost:19092';
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

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    await fn?.().catch(() => {});
  }
});

describe('Kafka adapter and connectors (Docker)', () => {
  test('Kafka adapter durable subscriptions round-trip through the broker', async () => {
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
  });

  test('Kafka connectors bridge bus events through Kafka topics', async () => {
    const bus = createInProcessAdapter();
    const topic = uniqueName('external.users');
    const groupId = uniqueName('user-sync');
    const received: Array<{ userId: string; email?: string }> = [];

    const connectors = createKafkaConnectors({
      brokers: [KAFKA_BROKER],
      inbound: [
        {
          topic,
          groupId,
          handler: payload => {
            received.push(payload as { userId: string; email?: string });
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

    bus.emit('auth:user.created', { userId: 'connector-user', email: 'connector@example.com' });

    await waitFor(() => received.length === 1);
    expect(received).toEqual([{ userId: 'connector-user', email: 'connector@example.com' }]);
  });
});
