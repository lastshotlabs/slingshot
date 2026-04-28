/**
 * Tests for task queue separation, idempotency, and retry behavior.
 *
 * Note on retry simulation: Testing BullMQ job retries (where a failed job is
 * automatically requeued for another attempt) requires real Redis + BullMQ
 * infrastructure. The BullMQ retry mechanism is implemented inside the BullMQ
 * library itself; the Worker constructor accepts a processor function, and BullMQ
 * manages re-scheduling failed jobs internally. Simulating this with mocks would
 * require reimplementing the BullMQ retry loop, which defeats the purpose of
 * integration testing retry behavior. These tests therefore cover queue separation
 * and idempotency, which are implemented in the adapter layer and can be fully
 * exercised with mocks.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '@lastshotlabs/slingshot-orchestration';

// ---------------------------------------------------------------------------
// Enhanced mock — respects opts.jobId so Job.fromId can find existing jobs
// ---------------------------------------------------------------------------

class MockJob {
  queue: MockQueue;
  id: string;
  name: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  returnvalue: unknown;
  timestamp: number;
  finishedOn?: number;
  failedReason = '';
  state = 'waiting';

  constructor(options: {
    queue: MockQueue;
    id: string;
    name: string;
    data: Record<string, unknown>;
    opts?: Record<string, unknown>;
    returnvalue?: unknown;
    state?: string;
  }) {
    this.queue = options.queue;
    this.id = options.id;
    this.name = options.name;
    this.data = options.data;
    this.opts = options.opts ?? {};
    this.returnvalue = options.returnvalue;
    this.timestamp = Date.now();
    this.finishedOn = options.state === 'completed' ? Date.now() : undefined;
    this.state = options.state ?? 'waiting';
  }

  async waitUntilFinished(_queueEvents: unknown) {
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

class MockQueue {
  static instances: MockQueue[] = [];

  name: string;
  jobs: MockJob[] = [];

  constructor(name: string) {
    this.name = name;
    MockQueue.instances.push(this);
  }

  async add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) {
    // Respect opts.jobId so that Job.fromId can find jobs by their idempotency key
    const id = String(
      (opts?.['jobId'] as string | undefined) ??
        data['runId'] ??
        `${this.name}-${this.jobs.length + 1}`,
    );
    const job = new MockJob({ queue: this, id, name, data, opts });
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
    return Promise.resolve({
      get: async (_key: string) => null,
      set: async (_key: string, _value: string) => {},
      mget: async (..._keys: string[]) => [],
      zadd: async (_key: string, _score: number, _member: string) => {},
      zrange: async (_key: string, _start: number, _end: number) => [] as string[],
      zrem: async (_key: string, ..._members: string[]) => {},
      del: async (..._keys: string[]) => {},
    });
  }

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

class MockWorker {
  static instances: MockWorker[] = [];

  constructor(
    public name: string,
    public processor: (job: Record<string, unknown>) => Promise<unknown>,
    public opts: Record<string, unknown>,
  ) {
    MockWorker.instances.push(this);
  }

  on(_event: string, _listener: (...args: unknown[]) => void) {}

  async pause(_force?: boolean) {}

  async getActiveCount() {
    return 0;
  }

  async close(_force?: boolean) {}
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

// ---------------------------------------------------------------------------
// Task queue separation
// ---------------------------------------------------------------------------

describe('task queue separation', () => {
  beforeEach(() => {
    MockQueue.instances = [];
    MockQueueEvents.instances = [];
    MockWorker.instances = [];
  });

  test('tasks with different queue names go to separate BullMQ queue instances', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'queue-sep',
    });

    const taskA = defineTask({
      name: 'task-a',
      queue: 'high-priority',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });

    const taskB = defineTask({
      name: 'task-b',
      queue: 'low-priority',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });

    adapter.registerTask(taskA);
    adapter.registerTask(taskB);

    await adapter.runTask(taskA.name, { value: 'a' });
    await adapter.runTask(taskB.name, { value: 'b' });

    // Each task should route to its own named queue. Queue names use '_' as
    // the separator (BullMQ 5.x rejects ':' in queue names).
    const highPriorityQueue = MockQueue.instances.find(
      q => q.name === 'queue-sep_high-priority_tasks',
    );
    const lowPriorityQueue = MockQueue.instances.find(
      q => q.name === 'queue-sep_low-priority_tasks',
    );

    expect(highPriorityQueue).toBeDefined();
    expect(lowPriorityQueue).toBeDefined();

    // Jobs landed in the correct queues
    expect(highPriorityQueue!.jobs).toHaveLength(1);
    expect(highPriorityQueue!.jobs[0]?.data['taskName']).toBe('task-a');

    expect(lowPriorityQueue!.jobs).toHaveLength(1);
    expect(lowPriorityQueue!.jobs[0]?.data['taskName']).toBe('task-b');

    // The two queues are distinct instances
    expect(highPriorityQueue).not.toBe(lowPriorityQueue);

    await adapter.shutdown();
  });

  test('task without a queue name uses the default task queue', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'default-q',
    });

    const task = defineTask({
      name: 'no-queue-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });

    adapter.registerTask(task);
    await adapter.runTask(task.name, { value: 'x' });

    const defaultQueue = MockQueue.instances.find(q => q.name === 'default-q_tasks');
    expect(defaultQueue).toBeDefined();
    expect(defaultQueue!.jobs).toHaveLength(1);
    expect(defaultQueue!.jobs[0]?.data['taskName']).toBe('no-queue-task');

    await adapter.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  beforeEach(() => {
    MockQueue.instances = [];
    MockQueueEvents.instances = [];
    MockWorker.instances = [];
  });

  test('second runTask with the same idempotencyKey returns the existing run id without adding a new job', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'idem-test',
    });

    const task = defineTask({
      name: 'idempotent-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });

    adapter.registerTask(task);

    const handle1 = await adapter.runTask(
      task.name,
      { value: 'first' },
      { idempotencyKey: 'key-abc' },
    );
    const handle2 = await adapter.runTask(
      task.name,
      { value: 'second' },
      { idempotencyKey: 'key-abc' },
    );

    // Both handles should refer to the same run
    expect(handle1.id).toBe(handle2.id);

    // Only one job should have been enqueued despite two runTask calls
    const taskQueue = MockQueue.instances.find(q => q.name === 'idem-test_tasks');
    expect(taskQueue).toBeDefined();
    expect(taskQueue!.jobs).toHaveLength(1);
    // The second call's input ('second') should not have overwritten the first
    expect(taskQueue!.jobs[0]?.data['input']).toMatchObject({ value: 'first' });

    await adapter.shutdown();
  });

  test('different idempotencyKeys produce separate jobs', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'idem-multi',
    });

    const task = defineTask({
      name: 'multi-key-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });

    adapter.registerTask(task);

    const handle1 = await adapter.runTask(
      task.name,
      { value: 'first' },
      { idempotencyKey: 'key-1' },
    );
    const handle2 = await adapter.runTask(
      task.name,
      { value: 'second' },
      { idempotencyKey: 'key-2' },
    );

    // Different keys → different run ids
    expect(handle1.id).not.toBe(handle2.id);

    const taskQueue = MockQueue.instances.find(q => q.name === 'idem-multi_tasks');
    expect(taskQueue).toBeDefined();
    expect(taskQueue!.jobs).toHaveLength(2);

    await adapter.shutdown();
  });
});
