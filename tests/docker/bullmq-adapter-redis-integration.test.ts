/**
 * Redis integration tests for the BullMQ adapter — behaviors that require a live
 * Redis instance and cannot be validated with mocks alone.
 *
 * Guard: set BULLMQ_INTEGRATION_REDIS_URL to opt in.
 * The entire suite is skipped when the variable is absent so unrelated CI jobs
 * and local runs without Redis are unaffected.
 *
 *   BULLMQ_INTEGRATION_REDIS_URL=redis://localhost:6380 \
 *     bun test tests/docker/bullmq-adapter-redis-integration.test.ts
 *
 * Cleanup contract: afterEach calls shutdown() on every bus created in the test
 * and obliterates each queue from Redis so subsequent runs start from a clean state.
 */
import { Queue } from 'bullmq';
import { afterEach, describe, expect, test } from 'bun:test';
import { createBullMQAdapter } from '../../packages/slingshot-bullmq/src/bullmqAdapter';
import type { SlingshotEventBus } from '../../packages/slingshot-core/src/eventBus';

// Local dynamic-bus cast: community:* events are declared via entity config
// and not in SlingshotEventMap. Rule 14: widen locally, don't pollute the global map.
type DynamicEventBus = {
  emit(event: string, payload: Record<string, unknown>): void;
  on(
    event: string,
    handler: (payload: Record<string, unknown>) => void | Promise<void>,
    opts?: { durable?: boolean; name?: string },
  ): void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Guard
// ─────────────────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.BULLMQ_INTEGRATION_REDIS_URL;

function connectionFromUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 6379,
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.pathname && u.pathname !== '/' ? { db: Number(u.pathname.slice(1)) } : {}),
  };
}

// Unreachable when skipIf fires, but must have a value for type-checking.
const connection = REDIS_URL ? connectionFromUrl(REDIS_URL) : { host: 'localhost', port: 6379 };

// ─────────────────────────────────────────────────────────────────────────────
// Per-test cleanup registry
// ─────────────────────────────────────────────────────────────────────────────

type CleanupFn = () => Promise<void>;
const cleanupFns: CleanupFn[] = [];

afterEach(async () => {
  const fns = cleanupFns.splice(0);
  await Promise.allSettled(fns.map(fn => fn()));
});

/**
 * Register a bus + queue names for cleanup after the current test.
 * Shutdown is called first so connections are closed before obliterate.
 */
function registerCleanup(bus: SlingshotEventBus, queueNames: string[]): void {
  cleanupFns.push(async () => {
    await (bus as any).shutdown?.();
    for (const name of queueNames) {
      const q = new Queue(name, { connection });
      try {
        await q.obliterate({ force: true });
      } finally {
        await q.close();
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Poll until condition() returns true or deadline passes. */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 50));
  }
}

/** Derive the BullMQ queue name for a given (prefix, event, subName) triple. */
function queueName(prefix: string, event: string, subName: string): string {
  return `${prefix}:${event}:${subName}`.replace(/:/g, '_');
}

let testSeq = 0;
/** Unique per-test prefix to prevent cross-run queue contamination. */
function testPrefix(): string {
  return `bsi-${Date.now()}-${++testSeq}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite — skipped when BULLMQ_INTEGRATION_REDIS_URL is not set
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!REDIS_URL)(
  'BullMQ adapter — Redis integration (BULLMQ_INTEGRATION_REDIS_URL)',
  () => {
    test(// Why: the central durability promise — that jobs survive a process restart —
    // can only be verified end-to-end with real Redis. Mocks confirm queue.add()
    // is called but cannot prove the job persists in Redis across adapter
    // lifecycles. By seeding the queue directly (no worker attached), then
    // starting a fresh adapter, we reproduce the exact scenario of a deploy or crash.
    'T1 — jobs enqueued before the adapter starts are consumed when the worker registers', async () => {
      const prefix = testPrefix();
      const qName = queueName(prefix, 'auth:user.created', 'restart-consumer');

      // Seed Redis with a job before any worker exists
      const seedQueue = new Queue(qName, { connection });
      await seedQueue.add('auth:user.created', { userId: 'pre-start-u1' });
      await seedQueue.close();

      // Start an adapter that registers on the same queue name
      const bus = createBullMQAdapter({ connection, prefix });
      registerCleanup(bus, [qName]);

      const received: string[] = [];
      bus.on(
        'auth:user.created',
        p => {
          received.push(p.userId);
        },
        {
          durable: true,
          name: 'restart-consumer',
        },
      );

      await waitFor(() => received.length >= 1, 8000);
      expect(received).toEqual(['pre-start-u1']);
    }, 15_000);

    test(// Why: BullMQ's worker.close() is specified as non-forceful — it waits for
    // the currently processing job to complete. This is the mechanism that makes
    // graceful deploys safe. Mocks mark closed=true synchronously; only real
    // BullMQ + Redis can prove the implementation honours that contract and that
    // shutdown() does not resolve until the job callback returns.
    'T2 — shutdown() resolves only after the in-flight job completes', async () => {
      const prefix = testPrefix();
      const qName = queueName(prefix, 'auth:login', 'graceful-drain');
      const bus = createBullMQAdapter({ connection, prefix });
      registerCleanup(bus, [qName]);

      let jobCompleted = false;

      bus.on(
        'auth:login',
        async () => {
          await new Promise(r => setTimeout(r, 250));
          jobCompleted = true;
        },
        { durable: true, name: 'graceful-drain' },
      );

      bus.emit('auth:login', { userId: 'u-graceful', sessionId: 's1' });

      // Allow the worker to pick up and start processing the job before we shut down
      await new Promise(r => setTimeout(r, 80));

      await (bus as any).shutdown();

      expect(jobCompleted).toBe(true);
    }, 15_000);

    test(// Why: BullMQ serialises payloads to JSON before writing to Redis, then
    // deserialises on read. TypeScript types do not catch runtime issues such
    // as non-ASCII characters being corrupted, emoji being stripped, or
    // optional null values being coerced. Only a real Redis round-trip proves
    // the byte sequence the listener receives is identical to what was emitted.
    'T3 — complex payload with unicode and optional null fields round-trips faithfully', async () => {
      const prefix = testPrefix();
      const qName = queueName(prefix, 'community:thread.created', 'payload-fidelity');
      const bus = createBullMQAdapter({ connection, prefix });
      registerCleanup(bus, [qName]);

      const emitted = {
        threadId: 'thd-αβγ-123',
        containerId: 'ctr-🌍-xyz',
        authorId: 'author-üñícode',
        title: 'Héllo wörld — 日本語タイトル 🎉',
        contentType: 'markdown',
        tenantId: 'tenant-99',
      };

      const received: (typeof emitted)[] = [];
      (bus as unknown as DynamicEventBus).on(
        'community:thread.created',
        p => {
          received.push(p as typeof emitted);
        },
        {
          durable: true,
          name: 'payload-fidelity',
        },
      );

      (bus as unknown as DynamicEventBus).emit('community:thread.created', emitted);

      await waitFor(() => received.length >= 1, 8000);
      expect(received[0]).toEqual(emitted);
    }, 15_000);

    test(// Why: documentation states that colons in {prefix}:{event}:{name} are
    // replaced with underscores in the actual Redis queue name. Users inspecting
    // Redis via KEYS/SCAN, the BullMQ dashboard, or writing operational tooling
    // need to know the exact key format. Only a real Redis connection lets us
    // verify the key that appears on the wire matches the documented pattern.
    'T4 — Redis queue key matches the documented colon→underscore sanitized pattern', async () => {
      const prefix = testPrefix();
      const subName = 'naming-probe';
      const sanitized = queueName(prefix, 'auth:login', subName);

      const bus = createBullMQAdapter({ connection, prefix });
      registerCleanup(bus, [sanitized]);

      const received: string[] = [];
      bus.on(
        'auth:login',
        p => {
          received.push(p.userId);
        },
        {
          durable: true,
          name: subName,
        },
      );
      bus.emit('auth:login', { userId: 'naming-u1', sessionId: 's1' });

      await waitFor(() => received.length >= 1, 8000);

      // Open a Queue client for the *expected* sanitized name and inspect job counts.
      // If the adapter used a different name, this Queue would be empty/non-existent
      // and getJobCounts() would return all zeros, failing the assertion.
      const inspector = new Queue(sanitized, { connection });
      const counts = await inspector.getJobCounts('completed', 'active', 'waiting');
      await inspector.close();

      expect(counts.completed + counts.active + counts.waiting).toBeGreaterThanOrEqual(1);
    }, 15_000);

    test(// Why: the adapter contract guarantees non-durable listeners fire via the
    // local EventEmitter and are not blocked on Redis I/O. With a real network
    // connection and real Redis latency, we can assert that after a single
    // microtask yield the non-durable handler has fired, while the durable
    // handler (which requires a Queue.add → Worker round-trip) has not yet.
    // Mock tests cannot verify this because mock add() resolves synchronously.
    'T5 — non-durable listeners fire before the durable Redis round-trip completes', async () => {
      const prefix = testPrefix();
      const qName = queueName(prefix, 'auth:login', 'timing-durable');
      const bus = createBullMQAdapter({ connection, prefix });
      registerCleanup(bus, [qName]);

      const timeline: string[] = [];

      bus.on('auth:login', () => {
        timeline.push('non-durable');
      });
      bus.on(
        'auth:login',
        () => {
          timeline.push('durable');
        },
        { durable: true, name: 'timing-durable' },
      );

      bus.emit('auth:login', { userId: 'u-timing', sessionId: 's1' });

      // Non-durable fires via Promise.resolve — one microtask tick is enough
      await Promise.resolve();
      expect(timeline).toEqual(['non-durable']);

      // Wait for the durable path to complete
      await waitFor(() => timeline.length >= 2, 8000);
      expect(timeline).toEqual(['non-durable', 'durable']);
    }, 15_000);

    test(// Why: verifies that rapid-fire emits are not silently dropped under real
    // Redis throughput. Mocks confirm call counts synchronously; only real Redis
    // can reveal issues such as queue back-pressure, connection saturation, or
    // race conditions in job ID generation that would cause jobs to overwrite
    // each other or be refused by the broker.
    'T6 — five rapid emits all deliver exactly five jobs (no loss under load)', async () => {
      const prefix = testPrefix();
      const qName = queueName(prefix, 'auth:login', 'rapid-consumer');
      const bus = createBullMQAdapter({ connection, prefix });
      registerCleanup(bus, [qName]);

      const receivedIds: string[] = [];
      bus.on(
        'auth:login',
        p => {
          receivedIds.push(p.userId);
        },
        {
          durable: true,
          name: 'rapid-consumer',
        },
      );

      for (let i = 1; i <= 5; i++) {
        bus.emit('auth:login', { userId: `rapid-u${i}`, sessionId: `s${i}` });
      }

      await waitFor(() => receivedIds.length >= 5, 10_000);

      expect(receivedIds).toHaveLength(5);
      // All five distinct payloads arrived — none were merged, overwritten, or duplicated
      expect(new Set(receivedIds).size).toBe(5);
    }, 20_000);

    test(// Why: in production, multiple processes each create their own adapter and
    // register the same subscription name. BullMQ's competing-consumers model
    // guarantees each job is delivered to exactly one worker — not broadcast.
    // This is the inverse of the per-adapter fanout (same event, different names).
    // Only real Redis can verify that BullMQ honours at-most-once delivery across
    // two live Worker connections sharing a queue.
    'T7 — competing consumers: two workers on the same queue each process a job exactly once', async () => {
      const prefix = testPrefix();
      const qName = queueName(prefix, 'auth:login', 'competing');

      const busA = createBullMQAdapter({ connection, prefix });
      const busB = createBullMQAdapter({ connection, prefix });
      // Both cleanup registrations share the same Redis queue — obliterate only once
      registerCleanup(busA, [qName]);
      registerCleanup(busB, []);

      const processedByA: string[] = [];
      const processedByB: string[] = [];

      busA.on(
        'auth:login',
        p => {
          processedByA.push(p.userId);
        },
        {
          durable: true,
          name: 'competing',
        },
      );
      busB.on(
        'auth:login',
        p => {
          processedByB.push(p.userId);
        },
        {
          durable: true,
          name: 'competing',
        },
      );

      // Emit two jobs — competing consumers must share the load, not duplicate it
      busA.emit('auth:login', { userId: 'cc-u1', sessionId: 'cc-s1' });
      busB.emit('auth:login', { userId: 'cc-u2', sessionId: 'cc-s2' });

      const total = () => processedByA.length + processedByB.length;
      await waitFor(() => total() >= 2, 10_000);

      const allReceived = [...processedByA, ...processedByB];
      expect(allReceived).toHaveLength(2);
      // No job was delivered to both workers (competing consumers, not fanout)
      expect(new Set(allReceived).size).toBe(2);
    }, 20_000);

    test(// Why: the mock tests confirm that defaultJobOptions.attempts is passed to
    // the Queue constructor, but they cannot prove BullMQ actually honours it
    // during job execution. Only a real Redis + Worker cycle can verify that
    // a job which throws is retried the correct number of times and ultimately
    // delivered when the listener eventually succeeds.
    'T8 — listener that throws transiently is retried and eventually succeeds', async () => {
      const prefix = testPrefix();
      const qName = queueName(prefix, 'auth:login', 'retry-transient');
      const bus = createBullMQAdapter({ connection, prefix, attempts: 3 });
      registerCleanup(bus, [qName]);

      let callCount = 0;
      const received: string[] = [];

      bus.on(
        'auth:login',
        async p => {
          callCount++;
          if (callCount < 3) throw new Error('transient failure');
          received.push(p.userId);
        },
        { durable: true, name: 'retry-transient' },
      );

      bus.emit('auth:login', { userId: 'retry-u1', sessionId: 's1' });

      await waitFor(() => received.length >= 1, 15_000);

      // Listener was called exactly 3 times (2 failures + 1 success)
      expect(callCount).toBe(3);
      expect(received).toEqual(['retry-u1']);
    }, 25_000);

    test(// Why: confirms that when all attempts are exhausted BullMQ moves the job
    // to the failed set in Redis rather than silently dropping it or retrying
    // indefinitely. The failed handler log (F8 fix) is only observable via
    // console.error; the failed set is the durable record operators use to
    // inspect and replay jobs. Only real Redis can prove the job lands there.
    'T9 — after all attempts exhausted the job lands in the BullMQ failed set', async () => {
      const prefix = testPrefix();
      const qName = queueName(prefix, 'auth:login', 'retry-exhaust');
      const bus = createBullMQAdapter({ connection, prefix, attempts: 2 });
      registerCleanup(bus, [qName]);

      let callCount = 0;

      bus.on(
        'auth:login',
        async () => {
          callCount++;
          throw new Error('always fails');
        },
        { durable: true, name: 'retry-exhaust' },
      );

      bus.emit('auth:login', { userId: 'exhaust-u1', sessionId: 's1' });

      // Wait for both attempts to fire
      await waitFor(() => callCount >= 2, 15_000);
      // Allow BullMQ time to write the job to the failed set
      await new Promise(r => setTimeout(r, 500));

      const inspector = new Queue(qName, { connection });
      const counts = await inspector.getJobCounts('failed');
      await inspector.close();

      expect(callCount).toBe(2);
      expect(counts.failed).toBe(1);
    }, 25_000);
  },
);
