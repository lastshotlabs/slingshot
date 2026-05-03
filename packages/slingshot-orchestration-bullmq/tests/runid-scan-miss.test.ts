import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

type MockJobState =
  | 'active'
  | 'completed'
  | 'failed'
  | 'waiting'
  | 'delayed'
  | 'prioritized'
  | 'waiting-children';

class MockRedisClient {
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

const mockRedis = new MockRedisClient();

class MockJob {
  queue: MockQueue;
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
  state: MockJobState;

  constructor(options: {
    queue: MockQueue;
    id: string;
    name: string;
    data: Record<string, unknown>;
    opts?: Record<string, unknown>;
    state?: MockJobState;
  }) {
    this.queue = options.queue;
    this.id = options.id;
    this.name = options.name;
    this.data = options.data;
    this.opts = options.opts ?? {};
    this.progress = undefined;
    this.returnvalue = undefined;
    this.timestamp = Date.now();
    this.finishedOn = options.state === 'completed' ? Date.now() : undefined;
    this.state = options.state ?? 'waiting';
  }

  async waitUntilFinished() {
    return this.data['input'];
  }

  async getState() {
    return this.state;
  }

  async remove() {
    this.queue.jobs = this.queue.jobs.filter(job => job !== this);
  }
}

class MockQueue {
  static instances: MockQueue[] = [];

  name: string;
  options: Record<string, unknown> | undefined;
  jobs: MockJob[] = [];
  schedulers: Array<{ key: string; name: string; pattern?: string }> = [];

  constructor(name: string, options?: Record<string, unknown>) {
    this.name = name;
    this.options = options;
    MockQueue.instances.push(this);
  }

  async add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) {
    const jobId =
      (opts?.['jobId'] as string | undefined) ??
      String(data['runId'] ?? `${this.name}-${this.jobs.length + 1}`);
    const job = new MockJob({ queue: this, id: jobId, name, data, opts });
    this.jobs.push(job);
    return job;
  }

  async getJobs() {
    return this.jobs;
  }

  async getJobSchedulers() {
    return this.schedulers;
  }

  async removeJobScheduler() {}

  get client() {
    return Promise.resolve(mockRedis);
  }

  async close() {}
}

class MockQueueEvents {
  static instances: MockQueueEvents[] = [];

  name: string;
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(name: string) {
    this.name = name;
    MockQueueEvents.instances.push(this);
  }

  on() {}
  off() {}
  async close() {}
}

class MockWorker {
  static instances: MockWorker[] = [];

  constructor(
    public name: string,
    public processor: (job: Record<string, unknown>) => Promise<unknown>,
    public opts: Record<string, unknown>,
  ) {
    MockWorker.instances.push(this);
  }

  on() {}
  emit() {}
  async pause() {}
  async getActiveCount() {
    return 0;
  }
  async close() {}
}

mock.module('bullmq', () => ({
  Job: {
    fromId: async (queue: MockQueue, jobId: string) =>
      queue.jobs.find(job => job.id === jobId) ?? null,
  },
  Queue: MockQueue,
  QueueEvents: MockQueueEvents,
  Worker: MockWorker,
}));

let createBullMQOrchestrationAdapter: (typeof import('../src/adapter'))['createBullMQOrchestrationAdapter'];

beforeAll(async () => {
  const mod = await import('../src/adapter');
  createBullMQOrchestrationAdapter = mod.createBullMQOrchestrationAdapter;
});

describe('bullmq adapter runId scan miss', () => {
  beforeEach(() => {
    MockQueue.instances = [];
    MockQueueEvents.instances = [];
    MockWorker.instances = [];
    mockRedis.reset();
  });

  afterEach(() => {
    mockRedis.reset();
  });

  test('logs scan miss + increments metric when getRun cannot find a runId', async () => {
    const warnings: Array<{ args: unknown[] }> = [];
    const logger = {
      info: () => {},
      warn: (...args: unknown[]) => {
        warnings.push({ args });
      },
      error: () => {},
      debug: () => {},
    };

    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'scan-miss',
      structuredLogger: logger,
    });

    // Force the scan path: no jobs exist with the given runId, so Job.fromId returns
    // null on every queue and the fallback scan runs to completion without a match.
    expect(adapter.getMetrics().runIdScanMisses).toBe(0);

    const result = await adapter.getRun('nonexistent-run-id');
    expect(result).toBeNull();

    const metrics = adapter.getMetrics();
    // findRunRecord scans the default task queue, the workflow queue, and any named
    // task queues. With no jobs registered there are only the two built-in queues,
    // so we expect at least 2 scan misses (one per queue) and no matches.
    expect(metrics.runIdScanMisses).toBeGreaterThanOrEqual(2);

    // The structured logger receives `(message, fields)` for each call.
    // We match the warning by message and read the structured fields.
    const missWarnings = warnings.filter(entry => {
      return typeof entry.args[0] === 'string' && entry.args[0] === 'Run ID scan miss';
    });
    expect(missWarnings.length).toBeGreaterThanOrEqual(2);

    for (const entry of missWarnings) {
      const fields = entry.args[1] as {
        runId: string;
        scannedCount: number;
        maxScan: number;
      };
      expect(fields.runId).toBe('nonexistent-run-id');
      expect(fields.maxScan).toBe(500);
      expect(typeof fields.scannedCount).toBe('number');
      expect(fields.scannedCount).toBeGreaterThanOrEqual(0);
    }
  });

  test('does not log a miss when a job is found via direct lookup', async () => {
    const warnings: Array<{ args: unknown[] }> = [];
    const logger = {
      info: () => {},
      warn: (...args: unknown[]) => {
        warnings.push({ args });
      },
      error: () => {},
      debug: () => {},
    };

    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'scan-hit',
      structuredLogger: logger,
    });

    // Seed a job in the default task queue keyed by runId. Job.fromId returns it
    // directly, so the scan path is not exercised and no miss should be recorded.
    await adapter.start();
    const taskQueue = MockQueue.instances.find(q => q.name === 'scan-hit_tasks');
    expect(taskQueue).toBeDefined();
    if (!taskQueue) throw new Error('task queue missing');
    taskQueue.jobs.push(
      new MockJob({
        queue: taskQueue,
        id: 'present-run-id',
        name: 'sync-user',
        data: { taskName: 'sync-user', runId: 'present-run-id', input: { userId: 'u1' } },
        state: 'completed',
      }),
    );

    const run = await adapter.getRun('present-run-id');
    expect(run?.id).toBe('present-run-id');
    expect(adapter.getMetrics().runIdScanMisses).toBe(0);

    const missWarnings = warnings.filter(entry => {
      return typeof entry.args[0] === 'string' && entry.args[0] === 'Run ID scan miss';
    });
    expect(missWarnings.length).toBe(0);
  });

  test('logs scan miss when a runId has been evicted from the cache', async () => {
    const warnings: Array<{ args: unknown[] }> = [];
    const logger = {
      info: () => {},
      warn: (...args: unknown[]) => {
        warnings.push({ args });
      },
      error: () => {},
      debug: () => {},
    };

    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'evicted-scan-miss',
      structuredLogger: logger,
    });

    await adapter.start();
    const taskQueue = MockQueue.instances.find(q => q.name === 'evicted-scan-miss_tasks');
    expect(taskQueue).toBeDefined();
    if (!taskQueue) throw new Error('task queue missing');

    // Simulate a process that knows about a runId but the underlying job has been
    // dropped (e.g. completed + retention policy removed it). The cache no longer
    // has the entry — Job.fromId returns null and the scan finishes empty.
    const evictedRunId = 'evicted-run-id';
    const result = await adapter.getRun(evictedRunId);
    expect(result).toBeNull();

    expect(adapter.getMetrics().runIdScanMisses).toBeGreaterThan(0);
    const missWarnings = warnings.filter(entry => {
      return (
        typeof entry.args[0] === 'string' &&
        entry.args[0] === 'Run ID scan miss' &&
        typeof entry.args[1] === 'object' &&
        entry.args[1] !== null &&
        (entry.args[1] as { runId?: unknown }).runId === evictedRunId
      );
    });
    expect(missWarnings.length).toBeGreaterThan(0);
  });
});
