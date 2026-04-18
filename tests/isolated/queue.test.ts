/**
 * Tests src/lib/queue.ts with a mocked bullmq module.
 *
 * Must run in an isolated bun test invocation to avoid mock leakage.
 * Mocks bullmq BEFORE importing queue.ts so require("bullmq") inside
 * requireBullMQ() returns our mock implementation.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
// ---------------------------------------------------------------------------
// Now import queue.ts (uses lazy require("bullmq") inside functions)
// ---------------------------------------------------------------------------

import {
  cleanupStaleSchedulers,
  createCronWorker,
  createDLQHandler,
  createQueue,
  createQueueFactory,
  createWorker,
} from '../../src/lib/queue';

// ---------------------------------------------------------------------------
// Mock bullmq before any imports that might trigger require("bullmq")
// ---------------------------------------------------------------------------

// Shared event listener store for DLQ test
type FailedListener = (job: MockJob | undefined, error: Error) => Promise<void>;

interface MockJob {
  id?: string;
  name: string;
  data: unknown;
  opts?: { attempts?: number; delay?: number; priority?: number; backoff?: unknown };
  attemptsMade: number;
  returnvalue?: unknown;
  failedReason?: string;
  timestamp: number;
  finishedOn?: number;
  getState: () => Promise<string>;
  remove: () => Promise<void>;
}

class MockQueue {
  public name: string;
  public addedJobs: { name: string; data: unknown; opts?: unknown; jobId?: string }[] = [];
  public schedulers: Map<string, unknown> = new Map();
  public closed = false;
  public waitingJobs: MockJob[] = [];
  private _waitingCount = 0;

  constructor(name: string) {
    this.name = name;
  }

  async add(name: string, data: unknown, opts?: { jobId?: string }) {
    this.addedJobs.push({ name, data, opts, jobId: opts?.jobId });
    return { id: `job-${Date.now()}` };
  }

  upsertJobScheduler(schedulerName: string, scheduleOpts: unknown, data: unknown) {
    this.schedulers.set(schedulerName, { scheduleOpts, data });
  }

  async removeJobScheduler(name: string) {
    this.schedulers.delete(name);
  }

  async getWaiting(start = 0, end = 19): Promise<MockJob[]> {
    return this.waitingJobs.slice(start, end + 1);
  }

  async getWaitingCount(): Promise<number> {
    return this._waitingCount;
  }

  setWaitingCount(n: number) {
    this._waitingCount = n;
  }

  async getJob(id: string): Promise<MockJob | null> {
    return this.waitingJobs.find(j => j.id === id) ?? null;
  }

  async close() {
    this.closed = true;
  }
}

class MockWorker {
  public name: string;
  public processor: unknown;
  public opts: unknown;
  private _listeners: Map<string, FailedListener[]> = new Map();

  constructor(name: string, processor: unknown, opts: unknown) {
    this.name = name;
    this.processor = processor;
    this.opts = opts;
  }

  on(event: string, listener: FailedListener) {
    const existing = this._listeners.get(event) ?? [];
    existing.push(listener);
    this._listeners.set(event, existing);
  }

  async emit(event: string, ...args: Parameters<FailedListener>) {
    const listeners = this._listeners.get(event) ?? [];
    for (const l of listeners) await l(...args);
  }
}

// Keep a reference to the last constructed instances for assertions
let lastQueue: MockQueue | null = null;
let lastWorker: MockWorker | null = null;

mock.module('bullmq', () => ({
  Queue: class extends MockQueue {
    constructor(name: string) {
      super(name);
      lastQueue = this;
    }
  },
  Worker: class extends MockWorker {
    constructor(name: string, processor: unknown, opts: unknown) {
      super(name, processor, opts);
      lastWorker = this;
    }
  },
}));

// Also mock redis so getRedisConnectionOptions() doesn't throw (REDIS_HOST missing)
mock.module('ioredis', () => ({ default: class {} }));

const QUEUE_CREDS = { host: 'localhost:6379' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createQueue', () => {
  test('returns a Queue instance with the given name', () => {
    const q = createQueue('my-queue', undefined, QUEUE_CREDS);
    expect(q).toBeDefined();
    expect((q as unknown as MockQueue).name).toBe('my-queue');
  });
});

describe('createQueueFactory', () => {
  test('returns helpers bound to explicit Redis credentials', () => {
    const queueFactory = createQueueFactory(QUEUE_CREDS);
    const q = queueFactory.createQueue('factory-queue');
    expect((q as unknown as MockQueue).name).toBe('factory-queue');
  });
});

describe('createWorker', () => {
  test('returns a Worker instance with the given name and processor', () => {
    const processor = async () => 'done';
    const w = createWorker('my-worker', processor, undefined, QUEUE_CREDS);
    expect(w).toBeDefined();
    expect((w as unknown as MockWorker).name).toBe('my-worker');
    expect((w as unknown as MockWorker).processor).toBe(processor);
  });
});

describe('createCronWorker', () => {
  test('returns the registered name', () => {
    const { registeredName } = createCronWorker(
      'cron-alpha',
      async () => {},
      { cron: '0 * * * *' },
      undefined,
      QUEUE_CREDS,
    );
    expect(registeredName).toBe('cron-alpha');
  });

  test('calls upsertJobScheduler with cron pattern', () => {
    createCronWorker(
      'cron-beta',
      async () => {},
      { cron: '*/5 * * * *', timezone: 'UTC' },
      undefined,
      QUEUE_CREDS,
    );
    const q = lastQueue!;
    expect(q.schedulers.has('cron-beta')).toBe(true);
    const sched = q.schedulers.get('cron-beta') as {
      scheduleOpts: { pattern: string; tz?: string };
    };
    expect(sched.scheduleOpts.pattern).toBe('*/5 * * * *');
    expect(sched.scheduleOpts.tz).toBe('UTC');
  });

  test('calls upsertJobScheduler with every interval', () => {
    createCronWorker('cron-gamma', async () => {}, { every: 30_000 }, undefined, QUEUE_CREDS);
    const q = lastQueue!;
    const sched = q.schedulers.get('cron-gamma') as { scheduleOpts: { every: number } };
    expect(sched.scheduleOpts.every).toBe(30_000);
  });
});

describe('cleanupStaleSchedulers', () => {
  test('removes schedulers for queue names not in the active set', async () => {
    // Register two cron workers and collect their names
    const registeredNames = new Set<string>();
    const { registeredName: name1 } = createCronWorker(
      'stale-one',
      async () => {},
      { cron: '* * * * *' },
      undefined,
      QUEUE_CREDS,
    );
    registeredNames.add(name1);
    const { registeredName: name2 } = createCronWorker(
      'stale-two',
      async () => {},
      { cron: '* * * * *' },
      undefined,
      QUEUE_CREDS,
    );
    registeredNames.add(name2);

    // Only keep stale-two as active; stale-one should be removed
    await cleanupStaleSchedulers(['stale-two'], registeredNames, QUEUE_CREDS);
    // Verify by checking the queue that was created for stale-one is now closed
    expect(lastQueue!.closed).toBe(true);
  });
});

describe('createDLQHandler', () => {
  test('attaches a failed listener on the source worker', () => {
    const worker = new MockWorker('source', async () => {}, {}) as unknown as ReturnType<
      typeof createWorker
    >;
    createDLQHandler(worker, 'source-queue', undefined, QUEUE_CREDS);
    expect((worker as unknown as MockWorker)['_listeners'].has('failed')).toBe(true);
  });

  test('failed listener adds job to DLQ when attempts are exhausted', async () => {
    const worker = new MockWorker('src2', async () => {}, {}) as unknown as ReturnType<
      typeof createWorker
    >;
    const { dlqQueue } = createDLQHandler(worker, 'src2-queue', undefined, QUEUE_CREDS);

    const job: MockJob = {
      id: 'job-1',
      name: 'do-work',
      data: { x: 1 },
      opts: { attempts: 1 },
      attemptsMade: 1, // equals attempts — exhausted
      timestamp: Date.now(),
      getState: async () => 'failed',
      remove: async () => {},
    };

    await (worker as unknown as MockWorker).emit('failed', job, new Error('boom'));

    const dlq = dlqQueue as unknown as MockQueue;
    expect(dlq.addedJobs.length).toBeGreaterThan(0);
    expect(dlq.addedJobs[0]!.jobId).toBe('dlq:job-1');
  });

  test('failed listener does NOT add to DLQ when attempts remain', async () => {
    const worker = new MockWorker('src3', async () => {}, {}) as unknown as ReturnType<
      typeof createWorker
    >;
    const { dlqQueue } = createDLQHandler(worker, 'src3-queue', undefined, QUEUE_CREDS);

    const job: MockJob = {
      id: 'job-2',
      name: 'retry-work',
      data: {},
      opts: { attempts: 3 },
      attemptsMade: 1, // only 1 of 3 — not exhausted
      timestamp: Date.now(),
      getState: async () => 'failed',
      remove: async () => {},
    };

    await (worker as unknown as MockWorker).emit('failed', job, new Error('oops'));
    expect((dlqQueue as unknown as MockQueue).addedJobs.length).toBe(0);
  });

  test('failed listener is a no-op when job is undefined', async () => {
    const worker = new MockWorker('src4', async () => {}, {}) as unknown as ReturnType<
      typeof createWorker
    >;
    createDLQHandler(worker, 'src4-queue', undefined, QUEUE_CREDS);
    // Should not throw
    await (worker as unknown as MockWorker).emit('failed', undefined, new Error('no job'));
  });

  test('retryJob moves a job from DLQ back to the source queue', async () => {
    const worker = new MockWorker('src5', async () => {}, {}) as unknown as ReturnType<
      typeof createWorker
    >;
    const { dlqQueue, retryJob } = createDLQHandler(worker, 'src5-queue', undefined, QUEUE_CREDS);

    const dlq = dlqQueue as unknown as MockQueue;
    const fakeJob: MockJob = {
      id: 'dlq:job-3',
      name: 'my-job',
      data: { y: 2 },
      opts: {},
      attemptsMade: 1,
      timestamp: Date.now(),
      getState: async () => 'waiting',
      remove: async () => {
        /* consumed */
      },
    };
    dlq.waitingJobs = [fakeJob];

    await retryJob('dlq:job-3');

    // The source queue should have received the job
    expect(lastQueue!.addedJobs.some(j => j.name === 'my-job')).toBe(true);
  });

  test('retryJob throws when the job is not found in DLQ', async () => {
    const worker = new MockWorker('src6', async () => {}, {}) as unknown as ReturnType<
      typeof createWorker
    >;
    const { retryJob } = createDLQHandler(worker, 'src6-queue', undefined, QUEUE_CREDS);
    await expect(retryJob('nonexistent-id')).rejects.toThrow('not found in DLQ');
  });
});
