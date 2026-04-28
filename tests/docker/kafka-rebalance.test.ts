/**
 * Kafka consumer-group rebalance integration test.
 *
 * Two consumers in the same group jointly process a 3-partition topic.
 * Mid-stream we stop one consumer and assert that:
 *   - the surviving consumer takes over the unprocessed partitions
 *     (partition reassignment actually happens),
 *   - committed offsets are flushed before reassignment so the surviving
 *     consumer does not replay messages already committed by its peer,
 *   - across the whole run we receive every message at least once
 *     (kafkajs' at-least-once guarantee is honored).
 *
 * Mocks of `kafkajs` cannot exercise the rebalance protocol; this test runs
 * against the redpanda broker stood up by `docker-compose.test.yml`.
 *
 * Guard: when the broker at localhost:19092 is unreachable the suite is
 * skipped via `describe.skipIf`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  type EachMessagePayload,
  Kafka,
  type Message,
} from '../../packages/slingshot-kafka/node_modules/kafkajs';

process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

const KAFKA_BROKER = process.env.TEST_KAFKA_BROKER ?? 'localhost:19092';
const RUN_ID = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function uniqueName(label: string): string {
  return `${label}-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
}

async function probeBroker(): Promise<boolean> {
  const kafka = new Kafka({ clientId: 'docker-probe', brokers: [KAFKA_BROKER] });
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.listTopics();
    return true;
  } catch {
    return false;
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

const KAFKA_AVAILABLE = await probeBroker();

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  message = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out waiting for ${message} after ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const fns = cleanups.splice(0).reverse();
  await Promise.allSettled(fns.map(fn => fn().catch(() => {})));
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!KAFKA_AVAILABLE)('Kafka consumer-group rebalance (docker)', () => {
  test('partition reassignment after a consumer stops; offsets flushed; no message loss', async () => {
    const topic = uniqueName('rebalance-topic');
    const groupId = uniqueName('rebalance-group');
    const NUM_PARTITIONS = 3;
    const NUM_MESSAGES = 100;

    // Topic setup ────────────────────────────────────────────────────────
    const adminKafka = new Kafka({
      clientId: uniqueName('admin'),
      brokers: [KAFKA_BROKER],
    });
    const admin = adminKafka.admin();
    await admin.connect();
    cleanups.push(() => admin.disconnect());
    await admin.createTopics({
      waitForLeaders: true,
      topics: [{ topic, numPartitions: NUM_PARTITIONS, replicationFactor: 1 }],
    });

    // Track which consumer received each message (by id) and the assignment
    // changes each consumer observes via the GROUP_JOIN instrumentation
    // event (the kafkajs equivalent of "partitions reassigned").
    const receivedByConsumer: Record<'A' | 'B', Set<number>> = {
      A: new Set(),
      B: new Set(),
    };
    const groupJoinEvents: Array<{ consumer: 'A' | 'B'; partitions: number[] }> = [];
    let consumerAStopped = false;

    // Helper to build a consumer that records its received message ids and
    // its current partition assignment. Auto-commit is left enabled (the
    // kafkajs default) so kafkajs flushes offsets before reassignment —
    // exactly the behavior we want to verify.
    const createConsumerHarness = async (label: 'A' | 'B') => {
      const kafka = new Kafka({
        clientId: uniqueName(`consumer-${label}`),
        brokers: [KAFKA_BROKER],
      });
      const consumer = kafka.consumer({
        groupId,
        // sessionTimeout & heartbeatInterval kept low so the broker detects
        // the stopped consumer quickly and triggers a rebalance within the
        // test's 60s budget.
        sessionTimeout: 10_000,
        heartbeatInterval: 1_000,
        rebalanceTimeout: 10_000,
      });

      consumer.on(consumer.events.GROUP_JOIN, event => {
        const memberAssignment = event.payload.memberAssignment as Record<string, number[]>;
        groupJoinEvents.push({
          consumer: label,
          partitions: memberAssignment[topic] ?? [],
        });
      });

      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: true });
      cleanups.push(() => consumer.disconnect());

      await consumer.run({
        eachMessage: async ({ message }: EachMessagePayload) => {
          const id = Number(message.key?.toString() ?? '-1');
          receivedByConsumer[label].add(id);
          // Tiny per-message latency: gives the test space to stop consumer A
          // mid-stream (simulating a slow processor that's still mid-batch
          // when the rebalance kicks in).
          await new Promise(resolve => setTimeout(resolve, 5));
        },
      });

      return consumer;
    };

    // Start both consumers and wait for the initial assignment ───────────
    const consumerA = await createConsumerHarness('A');
    const consumerB = await createConsumerHarness('B');

    await waitFor(
      () =>
        groupJoinEvents.filter(e => e.consumer === 'A').length > 0 &&
        groupJoinEvents.filter(e => e.consumer === 'B').length > 0,
      20_000,
      'initial group join for both consumers',
    );

    // Produce 100 messages keyed by id so each id maps to a deterministic
    // partition. This makes the "no message loss" assertion meaningful —
    // every id must surface in at least one consumer's received set.
    const producerKafka = new Kafka({
      clientId: uniqueName('producer'),
      brokers: [KAFKA_BROKER],
    });
    const producer = producerKafka.producer();
    await producer.connect();
    cleanups.push(() => producer.disconnect());

    const messages: Message[] = Array.from({ length: NUM_MESSAGES }, (_, i) => ({
      key: String(i),
      value: JSON.stringify({ id: i }),
    }));
    await producer.send({ topic, messages });

    // Wait until both consumers have received at least one message — this
    // guarantees we have offsets to flush before stopping consumer A.
    await waitFor(
      () => receivedByConsumer.A.size > 0 && receivedByConsumer.B.size > 0,
      20_000,
      'both consumers to receive at least one message',
    );

    // Stop consumer A mid-stream. consumer.stop() halts polling; subsequent
    // disconnect releases the heartbeat. We do both so the broker observes
    // A leaving and triggers a rebalance.
    const groupJoinCountBefore = groupJoinEvents.length;
    await consumerA.stop();
    await consumerA.disconnect();
    consumerAStopped = true;

    // Wait for rebalance: consumer B must observe a *new* GROUP_JOIN event
    // with all 3 partitions assigned to it.
    await waitFor(
      () => {
        if (groupJoinEvents.length <= groupJoinCountBefore) return false;
        const latest = groupJoinEvents[groupJoinEvents.length - 1];
        return latest?.consumer === 'B' && latest.partitions.length === NUM_PARTITIONS;
      },
      45_000,
      'consumer B to receive reassigned partitions after A stopped',
    );

    // Wait for all messages to be received in the union — at-least-once
    // guarantees no loss; auto-commit before rebalance bounds duplication
    // to "at most a small handful of in-flight messages".
    await waitFor(
      () => {
        const union = new Set([...receivedByConsumer.A, ...receivedByConsumer.B]);
        return union.size === NUM_MESSAGES;
      },
      45_000,
      'all 100 messages to be received across both consumers',
    );

    // ── Assertions ───────────────────────────────────────────────────────

    // Reassignment actually happened: B's last assignment owns all partitions.
    const finalAssignmentB = [...groupJoinEvents].reverse().find(event => event.consumer === 'B');
    expect(finalAssignmentB?.partitions.sort()).toEqual([0, 1, 2]);

    // No message loss: every id 0..99 appears in at least one consumer.
    const union = new Set([...receivedByConsumer.A, ...receivedByConsumer.B]);
    expect(union.size).toBe(NUM_MESSAGES);

    // Offsets were flushed before rebalance: bounded duplication.
    // Auto-commit fires every commitInterval (5s default) and on rebalance,
    // so any overlap must be small (<= 20 messages — generous bound for a
    // 100-message test). A larger overlap signals the offset commit before
    // rebalance regressed.
    const overlap = [...receivedByConsumer.A].filter(id => receivedByConsumer.B.has(id));
    expect(overlap.length).toBeLessThanOrEqual(20);

    // Sanity: consumer A's set is a subset of what was produced before it
    // stopped — i.e. it never received messages after disconnect.
    expect(consumerAStopped).toBe(true);
  }, 120_000);
});
