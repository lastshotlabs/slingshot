import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { type ProgressCapability, defineTask } from '@lastshotlabs/slingshot-orchestration';

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
    if (!set) {
      return [];
    }
    const members = [...set.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member);
    const normalizedEnd = end < 0 ? members.length + end : end;
    return members.slice(start, normalizedEnd + 1);
  }

  async zrem(key: string, ...members: string[]) {
    const set = this.sortedSets.get(key);
    if (!set) {
      return;
    }
    for (const member of members) {
      set.delete(member);
    }
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

  async waitUntilFinished(queueEvents: unknown) {
    if (!queueEvents) {
      throw new Error('queue events missing');
    }
    return this.returnvalue ?? this.data['input'];
  }

  async getState() {
    return this.state;
  }

  async remove() {
    this.queue.jobs = this.queue.jobs.filter(job => job !== this);
  }

  async moveToFailed() {
    this.state = 'failed';
    this.failedReason = 'Run cancelled';
    this.finishedOn = Date.now();
  }
}

class MockQueue {
  static instances: MockQueue[] = [];

  name: string;
  jobs: MockJob[] = [];

  constructor(name: string) {
    this.name = name;
    MockQueue.instances.push(this);
  }

  async add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) {
    const job = new MockJob({
      queue: this,
      id: String(data['runId'] ?? `${this.name}-${this.jobs.length + 1}`),
      name,
      data,
      opts,
    });
    this.jobs.push(job);
    return job;
  }

  async getJobs() {
    return this.jobs;
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

  name: string;
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(name: string) {
    this.name = name;
    MockQueueEvents.instances.push(this);
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  async close() {}
}

class MockWorker {
  static instances: MockWorker[] = [];
  static failOnConstruction: Error | null = null;

  constructor(
    public name: string,
    public processor: (job: Record<string, unknown>) => Promise<unknown>,
    public opts: Record<string, unknown>,
  ) {
    if (MockWorker.failOnConstruction) {
      const error = MockWorker.failOnConstruction;
      MockWorker.failOnConstruction = null;
      throw error;
    }
    MockWorker.instances.push(this);
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

describe('bullmq orchestration adapter', () => {
  beforeEach(() => {
    MockQueue.instances = [];
    MockQueueEvents.instances = [];
    MockWorker.instances = [];
    MockWorker.failOnConstruction = null;
    mockRedis.reset();
  });

  test('auto-starts on first task run without explicit start()', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'auto-start',
    });
    const task = defineTask({
      name: 'auto-start-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    const queueEventsBefore = MockQueueEvents.instances.length;
    const workersBefore = MockWorker.instances.length;

    const handle = await adapter.runTask(task.name, { value: 'ok' });
    await expect(handle.result()).resolves.toEqual({ value: 'ok' });

    expect(MockQueueEvents.instances.length).toBeGreaterThan(queueEventsBefore);
    expect(MockWorker.instances.length).toBeGreaterThan(workersBefore);
  });

  test('retries startup after a worker constructor failure', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'retry-startup',
    });
    const task = defineTask({
      name: 'retry-startup-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    MockWorker.failOnConstruction = new Error('worker failed');
    await expect(adapter.runTask(task.name, { value: 'ok' })).rejects.toThrow('worker failed');

    const handle = await adapter.runTask(task.name, { value: 'ok' });
    await expect(handle.result()).resolves.toEqual({ value: 'ok' });
  });

  test('listRuns maps BullMQ job states to portable run statuses', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'status-map',
    });

    const taskQueue = MockQueue.instances.find(queue => queue.name === 'status-map:tasks');
    const workflowQueue = MockQueue.instances.find(queue => queue.name === 'status-map:workflows');

    if (taskQueue) {
      taskQueue.jobs.push(
        new MockJob({
          queue: taskQueue,
          id: 'run_task',
          name: 'sync-user',
          data: { taskName: 'sync-user', runId: 'run_task', input: { userId: 'u1' } },
          state: 'active',
        }),
      );
    }
    if (workflowQueue) {
      workflowQueue.jobs.push(
        new MockJob({
          queue: workflowQueue,
          id: 'run_workflow',
          name: 'onboard-user',
          data: { workflowName: 'onboard-user', runId: 'run_workflow', input: { userId: 'u1' } },
          state: 'completed',
          returnvalue: { ok: true },
        }),
      );
    }

    const result = await adapter.listRuns();
    const statuses = Object.fromEntries(result.runs.map(run => [run.id, run.status]));

    expect(statuses['run_task']).toBe('running');
    expect(statuses['run_workflow']).toBe('completed');
  });

  test('onProgress unsubscribe before lazy start resolves does not leak listeners', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'progress-race',
    });
    const task = defineTask({
      name: 'progress-race-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    const unsubscribe = (adapter as typeof adapter & ProgressCapability).onProgress(
      'run_progress',
      () => {},
    );
    unsubscribe();
    await Promise.resolve();
    await Promise.resolve();

    expect(MockQueueEvents.instances.length).toBeGreaterThan(0);
    expect(
      MockQueueEvents.instances.every(
        queueEvents => (queueEvents.listeners.get('progress')?.size ?? 0) === 0,
      ),
    ).toBe(true);
  });

  test('cancelled runs remain visible and reject their result handle', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'cancelled-runs',
    });
    const task = defineTask({
      name: 'cancel-me',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    const handle = await adapter.runTask(task.name, { value: 'pending' });
    await adapter.cancelRun(handle.id);

    await expect(handle.result()).rejects.toThrow('Run cancelled');

    const run = await adapter.getRun(handle.id);
    expect(run?.status).toBe('cancelled');
    expect(run?.error?.message).toBe('Run cancelled');

    const listed = await adapter.listRuns({ status: 'cancelled' });
    expect(listed.total).toBe(1);
    expect(listed.runs[0]?.id).toBe(handle.id);
    expect(listed.runs[0]?.status).toBe('cancelled');
  });

  test('persisted cancelled snapshots survive adapter restart for removed pending jobs', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'cancelled-restart',
    });
    const task = defineTask({
      name: 'cancel-persisted',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    const handle = await adapter.runTask(task.name, { value: 'pending' });
    await adapter.cancelRun(handle.id);
    await adapter.shutdown();

    const restartedAdapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'cancelled-restart',
    });

    const run = await restartedAdapter.getRun(handle.id);
    expect(run?.status).toBe('cancelled');
    expect(run?.error?.message).toBe('Run cancelled');

    const listed = await restartedAdapter.listRuns({ status: 'cancelled' });
    expect(listed.total).toBe(1);
    expect(listed.runs[0]?.id).toBe(handle.id);

    await restartedAdapter.shutdown();
  });

  test('does not report cancelled when active cancellation fails', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'cancelled-failure',
    });
    const task = defineTask({
      name: 'cancel-active-failure',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    const handle = await adapter.runTask(task.name, { value: 'active' });
    const queue = MockQueue.instances.find(instance => instance.name === 'cancelled-failure:tasks');
    const job = queue?.jobs[0];
    expect(job).toBeDefined();
    if (!job) {
      return;
    }

    job.state = 'active';
    job.moveToFailed = async () => {
      throw new Error('missing lock token');
    };

    await expect(adapter.cancelRun(handle.id)).rejects.toThrow('Failed to cancel active run');

    const run = await adapter.getRun(handle.id);
    expect(run?.status).toBe('running');

    const listed = await adapter.listRuns({});
    expect(listed.runs.find(candidate => candidate.id === handle.id)?.status).toBe('running');
  });
});
