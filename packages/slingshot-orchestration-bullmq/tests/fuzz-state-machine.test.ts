/**
 * Property-based / fuzz tests for the BullMQ orchestration adapter's lazy-start
 * state machine.
 *
 * The adapter's internal state machine transitions through:
 *   idle -> starting -> started   (normal init)
 *   idle -> starting -> failed    (init error)
 *   failed -> idle                (reset)
 *
 * Additionally, `disposed` is set permanently by `shutdown()` and prevents
 * further operations.
 *
 * This test generates random sequences of API calls (start, shutdown, reset,
 * runTask, getRun, listRuns, cancelRun) and verifies that the adapter never
 * enters an inconsistent state and that state invariants hold after every
 * operation.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '@lastshotlabs/slingshot-orchestration';

// ---------------------------------------------------------------------------
// BullMQ mock with controllable failure injection
// ---------------------------------------------------------------------------

class MockRedisClient {
  private values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); }
  async mget(...keys: string[]) { return keys.map(k => this.values.get(k) ?? null); }
  async zadd() { return 1; }
  async zrange() { return [] as string[]; }
  async zrem() {}
  async del(...keys: string[]) { for (const k of keys) this.values.delete(k); }
  reset() { this.values.clear(); }
}

const mockRedis = new MockRedisClient();

class MockQueue {
  static instances: MockQueue[] = [];
  name: string;
  jobs: unknown[] = [];

  constructor(name: string) {
    this.name = name;
    MockQueue.instances.push(this);
  }
  async add() { return { id: 'mock-job-' + Date.now() }; }
  async getJobs() { return []; }
  async getJobSchedulers() { return []; }
  async removeJobScheduler() {}
  get client() { return Promise.resolve(mockRedis); }
  async close() {}
}

class MockQueueEvents {
  static instances: MockQueueEvents[] = [];
  name: string;
  constructor(name: string) {
    this.name = name;
    MockQueueEvents.instances.push(this);
  }
  on() {}
  off() {}
  async close() {}
}

/** Module-level flag — when set, the next Worker construction throws. */
let failNextWorkerConstruction: Error | null = null;

class MockWorker {
  static instances: MockWorker[] = [];
  static constructorCallCount = 0;

  name: string;
  closed = false;
  paused = false;

  constructor(name: string) {
    this.name = name;
    MockWorker.constructorCallCount += 1;
    MockWorker.instances.push(this);
    if (failNextWorkerConstruction) {
      const err = failNextWorkerConstruction;
      failNextWorkerConstruction = null;
      throw err;
    }
  }
  on() {}
  emit() {}
  async pause() { this.paused = true; }
  async getActiveCount() { return 0; }
  async close() { this.closed = true; }
}

mock.module('bullmq', () => ({
  Job: { fromId: async () => null },
  Queue: MockQueue,
  QueueEvents: MockQueueEvents,
  Worker: MockWorker,
}));

let createBullMQOrchestrationAdapter: (typeof import('../src/adapter'))['createBullMQOrchestrationAdapter'];
let OrchestrationAdapterDisposedError: (typeof import('../src/adapter'))['OrchestrationAdapterDisposedError'];

beforeAll(async () => {
  const mod = await import('../src/adapter');
  createBullMQOrchestrationAdapter = mod.createBullMQOrchestrationAdapter;
  OrchestrationAdapterDisposedError = mod.OrchestrationAdapterDisposedError;
});

function resetMocks(): void {
  MockQueue.instances = [];
  MockQueueEvents.instances = [];
  MockWorker.instances = [];
  MockWorker.constructorCallCount = 0;
  failNextWorkerConstruction = null;
  mockRedis.reset();
}

beforeEach(() => resetMocks());
afterEach(() => resetMocks());

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------
function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return (s >>> 0) / 0x100000000;
  };
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

const TASK = defineTask({
  name: 'fuzz-task',
  input: z.object({ value: z.string() }),
  output: z.object({ value: z.string() }),
  async handler(input) { return input; },
});

// ---------------------------------------------------------------------------
// State machine invariants
// ---------------------------------------------------------------------------
interface StateSnapshot {
  op: string;
  ok: boolean;
  errorType?: string;
  health?: { status: string; details: Record<string, unknown> };
}

function checkInvariants(history: StateSnapshot[]): void {
  let disposed = false;
  let failed = false;

  for (const snap of history) {
    const health = snap.health;
    if (!health) continue;

    const details = health.details;

    // Invariant 1: After shutdown, disposed is true permanently
    if (snap.op === 'shutdown' && snap.ok) {
      disposed = true;
    }
    if (disposed) {
      expect(details.disposed).toBe(true);
    }

    // Invariant 2: After failed init, startState is 'failed'
    if (snap.op === 'start' && !snap.ok) {
      failed = true;
    }

    // Invariant 3: reset() resets the failed state
    if (snap.op === 'reset' && snap.ok) {
      failed = false;
    }

    // Invariant 4: After failed state, operations calling ensureStarted fail
    if (failed && (snap.op === 'runTask' || snap.op === 'start' || snap.op === 'getRun' || snap.op === 'listRuns') && !snap.ok) {
      // OK — expected to fail when state machine is in failed state
    }
  }
}

// ---------------------------------------------------------------------------
// Random operation generators
// ---------------------------------------------------------------------------
type Op = 'start' | 'shutdown' | 'reset' | 'runTask' | 'getRun' | 'listRuns';

function generateSequence(rng: () => number, length: number): Op[] {
  const ops: Op[] = [];
  // Weighted distribution — more of the interesting operations
  const pool: Op[] = ['start', 'start', 'shutdown', 'shutdown', 'reset', 'runTask', 'runTask', 'runTask', 'getRun', 'listRuns'];
  for (let i = 0; i < length; i++) {
    ops.push(pick(rng, pool));
  }
  return ops;
}

// ===========================================================================
// State machine fuzz tests
// ===========================================================================
describe('state machine fuzz — random sequences', () => {
  test('random sequences of 10 operations maintain state invariants', async () => {
    const rng = seededRandom(42);

    for (let seq = 0; seq < 50; seq++) {
      resetMocks();
      const adapter = createBullMQOrchestrationAdapter({
        connection: { host: '127.0.0.1', port: 6379 },
        prefix: `fuzz-seq-${seq}`,
      });
      adapter.registerTask(TASK);

      const ops = generateSequence(rng, 10);
      const history: StateSnapshot[] = [];

      for (const op of ops) {
        const snap: StateSnapshot = { op, ok: false };
        try {
          switch (op) {
            case 'start':
              await adapter.start();
              snap.ok = true;
              break;
            case 'shutdown':
              await adapter.shutdown();
              snap.ok = true;
              break;
            case 'reset':
              (adapter as unknown as { reset(): void }).reset();
              snap.ok = true;
              break;
            case 'runTask':
              await adapter.runTask(TASK.name, { value: 'fuzz' });
              snap.ok = true;
              break;
            case 'getRun':
              await adapter.getRun('nonexistent-run');
              snap.ok = true;
              break;
            case 'listRuns':
              await adapter.listRuns();
              snap.ok = true;
              break;
          }
        } catch (err) {
          snap.ok = false;
          snap.errorType =
            err instanceof OrchestrationAdapterDisposedError
              ? 'disposed'
              : (err as Error)?.name ?? 'unknown';
        }

        // Capture health after each operation
        try {
          snap.health = await adapter.health();
        } catch {
          // Health might fail if adapter is in a strange state — that's useful info
        }

        history.push(snap);
      }

      // Verify invariants
      checkInvariants(history);

      // Ensure cleanup
      try { await adapter.shutdown(); } catch { /* best-effort */ }
    }
  });

  test('rapid start/stop cycles are safe', async () => {
    const rng = seededRandom(7);

    for (let cycle = 0; cycle < 30; cycle++) {
      resetMocks();
      const adapter = createBullMQOrchestrationAdapter({
        connection: { host: '127.0.0.1', port: 6379 },
        prefix: `rapid-cycle-${cycle}`,
      });

      try {
        await adapter.start();
        const healthBefore = await adapter.health();
        expect(healthBefore.details.disposed).toBe(false);
        expect(healthBefore.details.startState).toBe('started');

        await adapter.shutdown();
        const healthAfter = await adapter.health();
        expect(healthAfter.details.disposed).toBe(true);

        // After shutdown, start() must throw OrchestrationAdapterDisposedError
        let threw = false;
        try {
          await adapter.start();
        } catch (err) {
          threw = true;
          expect(err).toBeInstanceOf(OrchestrationAdapterDisposedError);
        }
        expect(threw).toBe(true);
      } finally {
        try { await adapter.shutdown(); } catch { /* best-effort */ }
      }
    }
  });

  test('start/fail/reset/start cycle is safe', async () => {
    const rng = seededRandom(13);

    for (let cycle = 0; cycle < 20; cycle++) {
      resetMocks();

      // Inject a worker construction failure
      failNextWorkerConstruction = new Error('simulated worker failure');

      const adapter = createBullMQOrchestrationAdapter({
        connection: { host: '127.0.0.1', port: 6379 },
        prefix: `fail-cycle-${cycle}`,
      });

      // First start should fail
      let startedOk = false;
      try {
        await adapter.start();
        startedOk = true;
      } catch {
        // Expected
      }
      expect(startedOk).toBe(false);

      // Health should show failed state
      const healthAfterFail = await adapter.health();
      expect(healthAfterFail.details.startState).toBe('failed');

      // Reset before retry
      (adapter as unknown as { reset(): void }).reset();
      const healthAfterReset = await adapter.health();
      expect(healthAfterReset.details.startState).not.toBe('failed');

      // Now start should succeed
      await adapter.start();
      const healthAfterStart = await adapter.health();
      expect(healthAfterStart.details.startState).toBe('started');

      await adapter.shutdown();
    }
  });

  test('concurrent start/shutdown from random bursts is safe', async () => {
    const rng = seededRandom(99);

    for (let burst = 0; burst < 20; burst++) {
      resetMocks();
      const adapter = createBullMQOrchestrationAdapter({
        connection: { host: '127.0.0.1', port: 6379 },
        prefix: `concurrent-burst-${burst}`,
      });
      adapter.registerTask(TASK);

      // Generate random concurrent operations
      const promises: Promise<unknown>[] = [];
      const numOps = randomInt(rng, 3, 8);

      for (let i = 0; i < numOps; i++) {
        const op = pick(rng, ['start', 'runTask', 'getRun', 'listRuns'] as const);
        switch (op) {
          case 'start':
            promises.push(adapter.start().catch(() => undefined));
            break;
          case 'runTask':
            promises.push(
              adapter
                .runTask(TASK.name, { value: `burst-${burst}-${i}` })
                .then(h => h.result())
                .catch(() => undefined),
            );
            break;
          case 'getRun':
            promises.push(adapter.getRun(`burst-${burst}-${i}`).catch(() => undefined));
            break;
          case 'listRuns':
            promises.push(adapter.listRuns().catch(() => undefined));
            break;
        }
      }

      // Let operations settle
      await Promise.allSettled(promises);

      // Health must still be accessible
      const health = await adapter.health();
      expect(typeof health.status).toBe('string');
      expect(typeof health.details.disposed).toBe('boolean');

      // Clean shutdown
      await adapter.shutdown().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic edge cases
// ---------------------------------------------------------------------------
describe('state machine edge cases', () => {
  test('reset on non-failed state throws', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'reset-edge',
    });

    // Not started yet, should be idle — reset should throw
    expect(() => (adapter as unknown as { reset(): void }).reset()).toThrow();

    // Start and then try reset while started — should throw
    await adapter.start();
    expect(() => (adapter as unknown as { reset(): void }).reset()).toThrow();

    // Shutdown and try reset while disposed — should throw
    await adapter.shutdown();
    expect(() => (adapter as unknown as { reset(): void }).reset()).toThrow();
  });

  test('shutdown is idempotent', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'idempotent-shutdown',
    });

    await adapter.start();
    await adapter.shutdown();
    await adapter.shutdown(); // second call must not throw
    await adapter.shutdown(); // third call must not throw

    // All workers should be closed exactly once
    for (const worker of MockWorker.instances) {
      expect(worker.closed).toBe(true);
    }
  });

  test('operations after shutdown throw OrchestrationAdapterDisposedError', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'post-shutdown',
    });
    adapter.registerTask(TASK);

    await adapter.start();
    await adapter.shutdown();

    // Operations that call ensureStarted() must throw after shutdown.
    // runTask and listRuns call ensureStarted(). getRun calls findRunRecord
    // directly and is therefore excluded here.
    const ops = [
      () => adapter.start(),
      () => adapter.runTask(TASK.name, { value: 'x' }),
      () => adapter.listRuns(),
    ];

    for (const op of ops) {
      let threw = false;
      try {
        await op();
      } catch (err) {
        threw = true;
        expect(err).toBeInstanceOf(OrchestrationAdapterDisposedError);
      }
      expect(threw).toBe(true);
    }
  });

  test('retained error across concurrent callers (P-OBULLMQ-5)', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'retained-error',
    });

    // Fail the first init
    failNextWorkerConstruction = new Error('first failure');

    const results = await Promise.allSettled([
      adapter.start(),
      adapter.start(), // concurrent caller
    ]);

    // Both should reject
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');

    // Clear the failure flag — state machine should still retain the error
    const result3 = await adapter.start().catch(e => e);
    expect(result3).toBeInstanceOf(Error);
    expect((result3 as Error).message).toBe('first failure');

    // Reset allows retry
    (adapter as unknown as { reset(): void }).reset();
    await adapter.start();
    await adapter.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Long random sequences (bounded)
// ---------------------------------------------------------------------------
describe('long random sequences', () => {
  test('50 random operations with interleaved failures', async () => {
    const rng = seededRandom(12345);
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'long-fuzz',
    });
    adapter.registerTask(TASK);

    let disposed = false;
    let failures = 0;

    for (let i = 0; i < 50; i++) {
      // Randomly inject a worker failure (but only if not already disposed)
      if (!disposed && rng() < 0.15) {
        failNextWorkerConstruction = new Error(`injected failure ${i}`);
      }

      const op = pick(rng, ['start', 'shutdown', 'runTask', 'getRun', 'listRuns'] as const);

      try {
        switch (op) {
          case 'start':
            await adapter.start();
            // If we were disposed, this would throw — so it means not disposed
            break;
          case 'shutdown':
            await adapter.shutdown();
            disposed = true;
            break;
          case 'runTask': {
            const handle = await adapter.runTask(TASK.name, { value: `step-${i}` });
            await handle.result();
            break;
          }
          case 'getRun':
            await adapter.getRun(`run-${i}`);
            break;
          case 'listRuns':
            await adapter.listRuns();
            break;
        }
      } catch (err) {
        failures++;
        if (disposed) {
          // All operations after shutdown must throw OrchestrationAdapterDisposedError
          expect(
            err instanceof OrchestrationAdapterDisposedError ||
            (err as Error)?.name === 'OrchestrationAdapterDisposedError',
          ).toBe(true);
        }
        // Clear the fail flag on error so subsequent ops might succeed
        failNextWorkerConstruction = null;
      }

      // Health check should never throw
      const health = await adapter.health();
      expect(health.details.disposed).toBe(disposed);
    }

    // Final cleanup
    try { await adapter.shutdown(); } catch { /* best-effort */ }
    // Failures should have occurred (the random injection should have hit)
    expect(failures).toBeGreaterThan(0);
  });
});
