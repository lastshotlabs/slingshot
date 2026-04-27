import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

type Processor<T = unknown, R = unknown> = (job: { data: T }) => Promise<R>;

class MockQueue {
  name: string;
  opts: Record<string, unknown>;

  constructor(name: string, opts: Record<string, unknown>) {
    this.name = name;
    this.opts = opts;
  }
}

class MockWorker {
  name: string;
  processor: Processor;
  opts: Record<string, unknown>;

  constructor(name: string, processor: Processor, opts: Record<string, unknown>) {
    this.name = name;
    this.processor = processor;
    this.opts = opts;
  }
}

const createdQueues: MockQueue[] = [];
const createdWorkers: MockWorker[] = [];

mock.module('bullmq', () => ({
  Queue: class extends MockQueue {
    constructor(name: string, opts: Record<string, unknown>) {
      super(name, opts);
      createdQueues.push(this);
    }
  },
  Worker: class extends MockWorker {
    constructor(name: string, processor: Processor, opts: Record<string, unknown>) {
      super(name, processor, opts);
      createdWorkers.push(this);
    }
  },
}));

let createQueueFactory: typeof import('../../src/infra/queue').createQueueFactory;

beforeAll(async () => {
  ({ createQueueFactory } = await import(`../../src/infra/queue.ts?queue=${Date.now()}`));
});

beforeEach(() => {
  createdQueues.length = 0;
  createdWorkers.length = 0;
});

describe('createQueueFactory', () => {
  test('creates queues and workers bound to the shared redis connection', () => {
    const redis = { host: 'localhost', port: 6379 } as never;
    const factory = createQueueFactory(() => redis);
    const processor = async (job: { data: unknown }) => (job.data as { userId: string }).userId;

    const queue = factory.createQueue('auth-deletions', {
      defaultJobOptions: { attempts: 4 },
    }) as unknown as MockQueue;
    const worker = factory.createWorker('auth-deletions', processor, {
      concurrency: 2,
    }) as unknown as MockWorker;

    expect(queue.name).toBe('auth-deletions');
    expect(queue.opts.connection).toBe(redis);
    expect(queue.opts.defaultJobOptions).toEqual({ attempts: 4 });

    expect(worker.name).toBe('auth-deletions');
    expect(worker.processor).toBe(processor);
    expect(worker.opts.connection).toBe(redis);
    expect(worker.opts.concurrency).toBe(2);
  });
});
