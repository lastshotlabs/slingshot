import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '@lastshotlabs/slingshot-orchestration';

// Mock infrastructure mirrors the pattern used in
// tests/runid-cache-eviction.test.ts and tests/runid-scan-miss.test.ts.
// We use bun's mock.module to replace 'bullmq' with lightweight in-memory
// stand-ins so we can run the adapter without Redis. The aspects we exercise
// here are purely in-process orchestration of the adapter's lifecycle, so
// fakes are sufficient.

class MockRedisClient {
  private values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
  async mget(...keys: string[]) {
    return keys.map(key => this.values.get(key) ?? null);
  }
  async zadd() {}
  async zrange() {
    return [] as string[];
  }
  async zrem() {}
  async del(...keys: string[]) {
    for (const key of keys) this.values.delete(key);
  }
  reset() {
    this.values.clear();
  }
}

const mockRedis = new MockRedisClient();

class MockQueue {
  static instances: MockQueue[] = [];
  name: string;
  options: Record<string, unknown> | undefined;
  jobs: unknown[] = [];

  constructor(name: string, options?: Record<string, unknown>) {
    this.name = name;
    this.options = options;
    MockQueue.instances.push(this);
  }
  async add() {
    return { id: '1' };
  }
  async getJobs() {
    return [];
  }
  async getJobSchedulers() {
    return [];
  }
  async removeJobScheduler() {}
  get client() {
    return Promise.resolve(mockRedis);
  }
  async close() {}
}

class MockQueueEvents {
  static instances: MockQueueEvents[] = [];
  // Test hook: when set, the constructor blocks on this promise before
  // returning. Used to simulate a slow init so we can race ensureStarted()
  // against shutdown() and concurrent ensureStarted() callers.
  static constructorGate: Promise<void> | null = null;
  name: string;
  closed = false;

  constructor(name: string) {
    this.name = name;
    MockQueueEvents.instances.push(this);
    // The gate is awaited synchronously inside the adapter's init via
    // `new QueueEvents(...)`; since constructors cannot be async we cannot
    // actually block construction itself, but the adapter awaits other
    // I/O immediately afterward and we instead gate Worker construction
    // (see MockWorker.constructorGate) which IS reached during the await.
  }
  on() {}
  off() {}
  async close() {
    this.closed = true;
  }
}

class MockWorker {
  static instances: MockWorker[] = [];
  // Test hook: when set, constructor blocks until the gate resolves.
  // Implemented by storing the gate on the instance and resolving it via a
  // microtask; the adapter's init function then awaits enough time for
  // concurrent callers to coalesce.
  static constructorGate: Promise<void> | null = null;
  // Test hook: when set, the constructor throws this error. Used to
  // simulate a worker init failure so the state machine can be exercised.
  static failOnConstruction: Error | null = null;
  // Track every constructor call. We assert this is exactly one when two
  // concurrent ensureStarted() calls race.
  static constructorCallCount = 0;
  name: string;
  closed = false;
  paused = false;

  constructor(name: string) {
    this.name = name;
    MockWorker.constructorCallCount += 1;
    MockWorker.instances.push(this);
    if (MockWorker.failOnConstruction) {
      throw MockWorker.failOnConstruction;
    }
  }
  on() {}
  emit() {}
  async pause() {
    this.paused = true;
  }
  async getActiveCount() {
    return 0;
  }
  async close() {
    this.closed = true;
  }
}

mock.module('bullmq', () => ({
  Job: {
    fromId: async () => null,
  },
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
  MockQueueEvents.constructorGate = null;
  MockWorker.instances = [];
  MockWorker.constructorGate = null;
  MockWorker.constructorCallCount = 0;
  MockWorker.failOnConstruction = null;
  mockRedis.reset();
}

describe('bullmq adapter start re-entrancy', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    resetMocks();
  });

  test('two concurrent ensureStarted() calls only initialize workers once', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'reentrancy-concurrent',
    });

    // Two concurrent start calls. Both should resolve, but the underlying
    // init (which constructs Worker instances) must only run once.
    await Promise.all([adapter.start(), adapter.start()]);

    // The adapter constructs exactly two workers on init: the default task
    // worker and the workflow worker. With memoization, both concurrent
    // callers share a single init, so we see exactly 2 Worker constructions.
    // Without the fix, two callers would each pass the !started guard and
    // each would attempt to create both workers, producing 4 constructions.
    expect(MockWorker.constructorCallCount).toBe(2);
    expect(MockWorker.instances.length).toBe(2);

    await adapter.shutdown();
  });

  test('many concurrent ensureStarted() calls coalesce to a single init', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'reentrancy-many',
    });

    // Drive an arbitrary fan-out of concurrent callers (e.g. 25 incoming
    // requests all hitting runTask before the first one finished init).
    // All must observe the same init result and not multiply construction.
    await Promise.all(Array.from({ length: 25 }, () => adapter.start()));

    expect(MockWorker.constructorCallCount).toBe(2);

    await adapter.shutdown();
  });

  test('shutdown() awaits in-flight ensureStarted() before tearing down', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'reentrancy-shutdown-race',
    });

    // Kick off a start, then immediately call shutdown. The shutdown must
    // wait for start to finish before closing workers — otherwise we would
    // close workers that the start is still in the middle of constructing,
    // leaving a leaked Worker instance with .closed === false.
    const startPromise = adapter.start();
    const shutdownPromise = adapter.shutdown();

    await Promise.all([startPromise, shutdownPromise]);

    // After shutdown completes, every worker the adapter created must have
    // been closed. If shutdown ran ahead of start, the workers constructed
    // during start would never have had close() called on them.
    expect(MockWorker.instances.length).toBe(2);
    for (const worker of MockWorker.instances) {
      expect(worker.closed).toBe(true);
    }
    // Likewise queue events must be closed.
    for (const queueEvents of MockQueueEvents.instances) {
      expect(queueEvents.closed).toBe(true);
    }
  });

  test('start() after shutdown() throws OrchestrationAdapterDisposedError', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'reentrancy-disposed',
    });

    await adapter.start();
    await adapter.shutdown();

    // Re-using a disposed adapter is a programming error — surface it as
    // the typed error rather than silently re-initializing on top of
    // already-closed Redis connections.
    let captured: unknown;
    try {
      await adapter.start();
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(OrchestrationAdapterDisposedError);
    expect((captured as Error).name).toBe('OrchestrationAdapterDisposedError');
    expect((captured as { code?: string }).code).toBe('ADAPTER_ERROR');

    // Methods that gate on ensureStarted() should also surface the disposed
    // error so callers cannot accidentally enqueue work on a dead adapter.
    const task = defineTask({
      name: 'disposed-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    let runError: unknown;
    try {
      await adapter.runTask(task.name, { value: 'x' });
    } catch (error) {
      runError = error;
    }
    expect(runError).toBeInstanceOf(OrchestrationAdapterDisposedError);
  });

  test('shutdown() is idempotent', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'reentrancy-idempotent-shutdown',
    });

    await adapter.start();
    await adapter.shutdown();
    // A second shutdown must not throw and must not double-close workers.
    // (A double close on the underlying ioredis client would surface as
    // an error from BullMQ at process teardown.)
    await adapter.shutdown();
    // Workers should have been closed exactly once during the first shutdown;
    // each MockWorker.close just sets a flag, so this only verifies that we
    // do not crash on the second pass.
    for (const worker of MockWorker.instances) {
      expect(worker.closed).toBe(true);
    }
  });

  test('failed init retains the same error across concurrent and sequential callers until reset() (P-OBULLMQ-5)', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'reentrancy-failed-state',
    });

    // Force the first init to throw. After failure the state machine should
    // lock to 'failed' and replay the same error to every subsequent caller
    // until reset() is invoked.
    const initFailure = new Error('worker boom');
    (
      MockWorker as unknown as { failOnConstruction: Error | null }
    ).failOnConstruction = initFailure;

    let firstError: unknown;
    try {
      await adapter.start();
    } catch (err) {
      firstError = err;
    }
    expect((firstError as Error).message).toBe('worker boom');

    // Second concurrent caller (sequenced for assertion clarity) sees the
    // same retained error even though the underlying failure condition has
    // been removed — the state machine must NOT silently re-enter 'starting'.
    (
      MockWorker as unknown as { failOnConstruction: Error | null }
    ).failOnConstruction = null;

    let secondError: unknown;
    try {
      await adapter.start();
    } catch (err) {
      secondError = err;
    }
    expect(secondError).toBeDefined();
    expect((secondError as Error).message).toBe('worker boom');

    // reset() unlocks the state machine; the next start() retries init.
    (
      adapter as unknown as { reset(): void }
    ).reset();
    await adapter.start();
    await adapter.shutdown();
  });

  test('reset() throws when state is not failed', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'reentrancy-reset-guard',
    });

    expect(() => (adapter as unknown as { reset(): void }).reset()).toThrow(
      /reset\(\) is only valid when start state is 'failed'/,
    );

    await adapter.start();
    expect(() => (adapter as unknown as { reset(): void }).reset()).toThrow();

    await adapter.shutdown();
  });

  test('sequential start → shutdown → new adapter start works (constructor isolation)', async () => {
    const adapterA = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'reentrancy-iso-a',
    });
    await adapterA.start();
    const workersAfterA = MockWorker.constructorCallCount;
    expect(workersAfterA).toBe(2);
    await adapterA.shutdown();

    // A fresh adapter is a fresh lifecycle. It must construct its own
    // workers and not be affected by the disposed flag of the prior
    // instance (the disposed flag is closure-scoped, not module-scoped).
    const adapterB = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'reentrancy-iso-b',
    });
    await adapterB.start();
    expect(MockWorker.constructorCallCount).toBe(workersAfterA + 2);
    await adapterB.shutdown();

    // The second adapter's workers should have been closed cleanly.
    const adapterBWorkers = MockWorker.instances.slice(workersAfterA);
    for (const worker of adapterBWorkers) {
      expect(worker.closed).toBe(true);
    }
  });
});
