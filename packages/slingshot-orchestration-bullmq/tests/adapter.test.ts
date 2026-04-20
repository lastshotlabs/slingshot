import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { defineTask, type ProgressCapability } from '@lastshotlabs/slingshot-orchestration';

type MockJobState =
  | 'active'
  | 'completed'
  | 'failed'
  | 'waiting'
  | 'delayed'
  | 'prioritized'
  | 'waiting-children';

class MockJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  progress: unknown;
  returnvalue: unknown;
  timestamp: number;
  finishedOn?: number;
  state: MockJobState;

  constructor(options: {
    id: string;
    name: string;
    data: Record<string, unknown>;
    opts?: Record<string, unknown>;
    state?: MockJobState;
    returnvalue?: unknown;
  }) {
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

  async remove() {}

  async moveToFailed() {
    this.state = 'failed';
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

  constructor(
    public name: string,
    public processor: (job: Record<string, unknown>) => Promise<unknown>,
    public opts: Record<string, unknown>,
  ) {
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

let createBullMQOrchestrationAdapter: typeof import('../src/adapter')['createBullMQOrchestrationAdapter'];

beforeAll(async () => {
  const mod = await import('../src/adapter');
  createBullMQOrchestrationAdapter = mod.createBullMQOrchestrationAdapter;
});

describe('bullmq orchestration adapter', () => {
  beforeEach(() => {
    MockQueue.instances = [];
    MockQueueEvents.instances = [];
    MockWorker.instances = [];
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

  test('listRuns maps BullMQ job states to portable run statuses', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'status-map',
    });

    const taskQueue = MockQueue.instances.find(queue => queue.name === 'status-map:tasks');
    const workflowQueue = MockQueue.instances.find(
      queue => queue.name === 'status-map:workflows',
    );

    taskQueue?.jobs.push(
      new MockJob({
        id: 'run_task',
        name: 'sync-user',
        data: { taskName: 'sync-user', runId: 'run_task', input: { userId: 'u1' } },
        state: 'active',
      }),
    );
    workflowQueue?.jobs.push(
      new MockJob({
        id: 'run_workflow',
        name: 'onboard-user',
        data: { workflowName: 'onboard-user', runId: 'run_workflow', input: { userId: 'u1' } },
        state: 'completed',
        returnvalue: { ok: true },
      }),
    );

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
});
