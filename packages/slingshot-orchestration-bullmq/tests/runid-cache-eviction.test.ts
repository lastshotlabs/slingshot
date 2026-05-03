import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '@lastshotlabs/slingshot-orchestration';

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

  async waitUntilFinished() {
    return this.returnvalue ?? this.data['input'];
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

describe('bullmq adapter runId cache eviction', () => {
  beforeEach(() => {
    MockQueue.instances = [];
    MockQueueEvents.instances = [];
    MockWorker.instances = [];
    mockRedis.reset();
  });

  afterEach(() => {
    mockRedis.reset();
  });

  test('emits log + increments metric when FIFO cache evicts the oldest entry', async () => {
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
      prefix: 'cache-evict',
      structuredLogger: logger,
    });
    const task = defineTask({
      name: 'cache-evict-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    // Cache limit is 10k; fill 10k+1 to force exactly one eviction.
    const RUN_ID_CACHE_LIMIT = 10_000;
    const totalRuns = RUN_ID_CACHE_LIMIT + 1;

    // Pre-condition: no evictions yet.
    expect(adapter.getMetrics().runIdCacheEvictions).toBe(0);

    for (let i = 0; i < totalRuns; i += 1) {
      await adapter.runTask(task.name, { value: `v${i}` });
    }

    const metrics = adapter.getMetrics();
    expect(metrics.runIdCacheEvictions).toBe(1);

    // The eviction warning should have been emitted exactly once. The structured
    // logger receives `(message, fields)`, so we match on the message and read fields.
    const evictionWarnings = warnings.filter(
      entry => typeof entry.args[0] === 'string' && entry.args[0] === 'Run ID cache evicted',
    );
    expect(evictionWarnings.length).toBe(1);
    const fields = evictionWarnings[0]!.args[1] as {
      evictedRunId: string;
      cacheSize: number;
    };
    expect(typeof fields.evictedRunId).toBe('string');
    expect(fields.evictedRunId.length).toBeGreaterThan(0);
    // After deleting the oldest entry but before inserting the new one, size = limit - 1.
    expect(fields.cacheSize).toBe(RUN_ID_CACHE_LIMIT - 1);
  }, 30_000);

  test('falls back to console.warn when no logger is configured', async () => {
    const original = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };

    try {
      const adapter = createBullMQOrchestrationAdapter({
        connection: { host: '127.0.0.1', port: 6379 },
        prefix: 'cache-evict-console',
      });
      const task = defineTask({
        name: 'cache-evict-console-task',
        input: z.object({ value: z.string() }),
        output: z.object({ value: z.string() }),
        async handler(input) {
          return input;
        },
      });
      adapter.registerTask(task);

      const RUN_ID_CACHE_LIMIT = 10_000;
      for (let i = 0; i < RUN_ID_CACHE_LIMIT + 1; i += 1) {
        await adapter.runTask(task.name, { value: `v${i}` });
      }

      // The default logger writes a single JSON line per call to console.error
      // (warn-level included). Parse each line and match by msg field.
      const evictionCalls = calls.filter(args => {
        const line = args[0];
        if (typeof line !== 'string') return false;
        try {
          const record = JSON.parse(line) as { msg?: unknown };
          return record.msg === 'Run ID cache evicted';
        } catch {
          return false;
        }
      });
      expect(evictionCalls.length).toBe(1);
      expect(adapter.getMetrics().runIdCacheEvictions).toBe(1);
    } finally {
      console.warn = original;
    }
  }, 30_000);
});
