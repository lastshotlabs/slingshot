/**
 * Shared in-memory mocks for BullMQ classes used by the orchestration adapter.
 *
 * These fakes simulate the subset of the BullMQ API that
 * `createBullMQOrchestrationAdapter()` uses. They support test-only hooks
 * (static properties on the classes) for injecting failures, tracking
 * construction, and controlling timing.
 *
 * Usage in test files:
 *
 *   import { createFakeBullMQModule, FakeRedisClient } from '../src/testing';
 *   import { mock } from 'bun:test';
 *
 *   const mockRedis = new FakeRedisClient();
 *   mock.module('bullmq', () => createFakeBullMQModule(mockRedis));
 *
 *   // Access instances for assertions:
 *   expect(FakeQueue.instances).toHaveLength(1);
 */

export type FakeJobState =
  | 'active'
  | 'completed'
  | 'failed'
  | 'waiting'
  | 'delayed'
  | 'prioritized'
  | 'waiting-children';

/**
 * In-memory Redis client simulation used by FakeQueue.get client().
 */
export class FakeRedisClient {
  private values = new Map<string, string>();
  private sortedSets = new Map<string, Map<string, number>>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
  }

  async mget(...keys: string[]) {
    return keys.map(key => this.values.get(key) ?? null);
  }

  async zadd(key: string, score: number | string, member: string) {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    set.set(member, Number(score));
    this.sortedSets.set(key, set);
  }

  async zrange(key: string, start: number, end: number) {
    const set = this.sortedSets.get(key);
    if (!set) return [];
    const members = [...set.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member);
    const normalizedEnd = end < 0 ? members.length + end : end;
    return members.slice(start, normalizedEnd + 1);
  }

  async zrem(key: string, ...members: string[]) {
    const set = this.sortedSets.get(key);
    if (!set) return;
    for (const member of members) set.delete(member);
  }

  async del(...keys: string[]) {
    for (const key of keys) {
      this.values.delete(key);
      this.sortedSets.delete(key);
    }
  }

  reset() {
    this.values.clear();
    this.sortedSets.clear();
  }
}

/**
 * In-memory fake for BullMQ's Job class.
 */
export class FakeJob {
  queue: FakeQueue;
  id: string;
  name: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  progress: unknown;
  returnvalue: unknown;
  timestamp: number;
  finishedOn?: number;
  processedOn?: number;
  failedReason = '';
  state: FakeJobState;

  constructor(options: {
    queue: FakeQueue;
    id: string;
    name: string;
    data: Record<string, unknown>;
    opts?: Record<string, unknown>;
    state?: FakeJobState;
    returnvalue?: unknown;
  }) {
    this.queue = options.queue;
    this.id = options.id;
    this.name = options.name;
    this.data = options.data;
    this.opts = options.opts ?? {};
    this.progress = undefined;
    this.returnvalue = options.returnvalue;
    this.timestamp = Date.now();
    this.finishedOn = options.state === 'completed' ? Date.now() : undefined;
    this.state = options.state ?? 'waiting';
  }

  async waitUntilFinished(_queueEvents: unknown) {
    if (!_queueEvents) throw new Error('queue events missing');
    return this.returnvalue ?? this.data['input'];
  }

  async getState() {
    return this.state;
  }

  async remove() {
    this.queue.jobs = this.queue.jobs.filter(j => j !== this);
  }

  async moveToFailed() {
    this.state = 'failed';
    this.failedReason = 'Run cancelled';
    this.finishedOn = Date.now();
  }
}

/**
 * In-memory fake for BullMQ's Queue class.
 * Supports tracking schedulers (repeatable jobs) and job lists.
 */
export class FakeQueue {
  static instances: FakeQueue[] = [];
  /** Test hook: when set, the next `get client` call returns a custom client. */
  static customClient: FakeRedisClient | null = null;

  name: string;
  options: Record<string, unknown> | undefined;
  jobs: FakeJob[] = [];
  schedulers: Array<{ key: string; name: string; pattern?: string; memo?: unknown }> = [];

  constructor(name: string, options?: Record<string, unknown>) {
    this.name = name;
    this.options = options;
    FakeQueue.instances.push(this);
  }

  async add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) {
    const jobId =
      (opts?.['jobId'] as string | undefined) ??
      String(data['runId'] ?? `${this.name}-${this.jobs.length + 1}`);
    const job = new FakeJob({
      queue: this,
      id: jobId,
      name,
      data,
      opts,
    });
    // Track repeatable jobs as schedulers
    if (
      opts &&
      typeof opts['jobId'] === 'string' &&
      opts['repeat'] &&
      typeof opts['repeat'] === 'object'
    ) {
      const repeat = opts['repeat'] as Record<string, unknown>;
      this.schedulers.push({
        key: opts['jobId'] as string,
        name,
        pattern: typeof repeat['pattern'] === 'string' ? repeat['pattern'] : undefined,
        memo: data,
      });
    } else {
      this.jobs.push(job);
    }
    return job;
  }

  async getJobs() {
    return this.jobs;
  }

  async getJobSchedulers() {
    return this.schedulers;
  }

  async removeJobScheduler(key: string) {
    this.schedulers = this.schedulers.filter(s => s.key !== key);
  }

  get client() {
    if (FakeQueue.customClient) return Promise.resolve(FakeQueue.customClient);
    return Promise.resolve(fakeRedisClient);
  }

  async close() {}
}

const fakeRedisClient = new FakeRedisClient();

/**
 * In-memory fake for BullMQ's QueueEvents class.
 */
export class FakeQueueEvents {
  static instances: FakeQueueEvents[] = [];
  static constructorGate: Promise<void> | null = null;
  static constructorGateResolve: (() => void) | null = null;

  name: string;
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  closed = false;

  constructor(name: string) {
    this.name = name;
    FakeQueueEvents.instances.push(this);
    if (FakeQueueEvents.constructorGate) {
      const gate = FakeQueueEvents.constructorGate;
      // Use microtask to avoid blocking the constructor itself
      Promise.resolve().then(() => gate);
    }
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  async close() {
    this.closed = true;
  }
}

/**
 * In-memory fake for BullMQ's Worker class.
 * Supports test-only hooks for failure injection and tracking.
 */
export class FakeWorker {
  static instances: FakeWorker[] = [];
  static failOnConstruction: Error | null = null;
  static constructorGate: Promise<void> | null = null;
  static constructorCallCount = 0;

  eventListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  paused = false;
  pauseCalls = 0;
  closed = false;
  closedForce: boolean | undefined = undefined;
  activeCounts: number[] = [0];
  activeCountCalls = 0;

  constructor(
    public name: string,
    public processor: (job: Record<string, unknown>) => Promise<unknown>,
    public opts: Record<string, unknown>,
  ) {
    FakeWorker.constructorCallCount += 1;
    if (FakeWorker.failOnConstruction) {
      const error = FakeWorker.failOnConstruction;
      FakeWorker.failOnConstruction = null;
      throw error;
    }
    FakeWorker.instances.push(this);
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.eventListeners.get(event) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(event, listeners);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.eventListeners.get(event) ?? []) {
      listener(...args);
    }
  }

  async pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  async getActiveCount() {
    this.activeCountCalls += 1;
    if (this.activeCounts.length === 1) return this.activeCounts[0] ?? 0;
    return this.activeCounts.shift() ?? 0;
  }

  async close(force?: boolean) {
    this.closed = true;
    this.closedForce = force;
  }
}

/**
 * Create the mock module object for `mock.module('bullmq', ...)`.
 * Returns a plain object with the same shape that `import('bullmq')` would export.
 */
export function createFakeBullMQModule(redisClient?: FakeRedisClient) {
  if (redisClient) {
    fakeRedisClient.reset();
    // Copy the provided client's data into the shared client
    // We'll use the custom via FakeQueue.customClient instead
    FakeQueue.customClient = redisClient;
  } else {
    FakeQueue.customClient = null;
  }
  return {
    Job: {
      fromId: async (queue: FakeQueue, jobId: string) =>
        queue.jobs.find(job => job.id === jobId) ?? null,
    } as unknown,
    Queue: FakeQueue as unknown,
    QueueEvents: FakeQueueEvents as unknown,
    Worker: FakeWorker as unknown,
  };
}

/**
 * Reset all static instance trackers and test hooks across all fake classes.
 * Call in `beforeEach` or `afterEach` to isolate tests.
 */
export function resetFakeBullMQState(): void {
  FakeQueue.instances = [];
  FakeQueue.customClient = null;
  FakeQueueEvents.instances = [];
  FakeQueueEvents.constructorGate = null;
  FakeQueueEvents.constructorGateResolve = null;
  FakeWorker.instances = [];
  FakeWorker.failOnConstruction = null;
  FakeWorker.constructorGate = null;
  FakeWorker.constructorCallCount = 0;
  fakeRedisClient.reset();
}
