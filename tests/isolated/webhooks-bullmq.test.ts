import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { WebhookDeliveryError } from '../../packages/slingshot-webhooks/src/types/queue';
import type { WebhookJob } from '../../packages/slingshot-webhooks/src/types/queue';

type JobInput = Omit<WebhookJob, 'id' | 'createdAt'>;

type BullJobShape = {
  id: string | undefined;
  data: JobInput;
  attemptsMade: number;
  timestamp: number;
};

const state = {
  queues: [] as MockQueue[],
  workers: [] as MockWorker[],
  connections: [] as MockRedis[],
  nextJobId: 0,
};

const moduleState = {
  bullmqExports: {
    Queue: undefined as typeof MockQueue | undefined,
    Worker: undefined as typeof MockWorker | undefined,
    UnrecoverableError: undefined as typeof MockUnrecoverableError | undefined,
  },
  ioredisExports: {
    default: undefined as typeof MockRedis | undefined,
    Redis: undefined as typeof MockRedis | undefined,
  },
};

class MockQueue {
  static addReturnsMissingId = false;
  static closeError: Error | null = null;

  name: string;
  opts: Record<string, unknown>;
  addedJobs: Array<{ name: string; data: JobInput; opts: Record<string, unknown> }> = [];
  countValue = 0;
  closed = false;

  constructor(name: string, opts: Record<string, unknown>) {
    this.name = name;
    this.opts = opts;
    state.queues.push(this);
  }

  async add(name: string, data: JobInput, opts: Record<string, unknown>) {
    this.addedJobs.push({ name, data, opts });
    this.countValue++;
    if (MockQueue.addReturnsMissingId) {
      return { id: undefined };
    }
    return { id: `job-${++state.nextJobId}` };
  }

  async count() {
    return this.countValue;
  }

  async close() {
    this.closed = true;
    if (MockQueue.closeError) {
      throw MockQueue.closeError;
    }
  }
}

class MockWorker {
  static throwOnConstruct: Error | null = null;
  static closeError: Error | null = null;

  name: string;
  processor: (job: BullJobShape) => Promise<void>;
  opts: Record<string, unknown>;
  closed = false;
  private failedListeners: Array<(job: BullJobShape | undefined, err: Error) => void> = [];

  constructor(
    name: string,
    processor: (job: BullJobShape) => Promise<void>,
    opts: Record<string, unknown>,
  ) {
    if (MockWorker.throwOnConstruct) {
      throw MockWorker.throwOnConstruct;
    }
    this.name = name;
    this.processor = processor;
    this.opts = opts;
    state.workers.push(this);
  }

  on(event: string, handler: (job: BullJobShape | undefined, err: Error) => void) {
    if (event === 'failed') {
      this.failedListeners.push(handler);
    }
  }

  emitFailed(job: BullJobShape | undefined, err: Error) {
    for (const listener of this.failedListeners) {
      listener(job, err);
    }
  }

  async close() {
    this.closed = true;
    if (MockWorker.closeError) {
      throw MockWorker.closeError;
    }
  }
}

class MockRedis {
  static pingError: Error | null = null;
  static quitError: Error | null = null;

  target: string | Record<string, unknown>;
  options: Record<string, unknown> | undefined;
  closed = false;
  pingCalls = 0;

  constructor(target: string | Record<string, unknown>, options?: Record<string, unknown>) {
    this.target = target;
    this.options = options;
    state.connections.push(this);
  }

  async ping() {
    this.pingCalls++;
    if (MockRedis.pingError) {
      throw MockRedis.pingError;
    }
    return 'PONG';
  }

  async quit() {
    this.closed = true;
    if (MockRedis.quitError) {
      throw MockRedis.quitError;
    }
  }
}

class MockUnrecoverableError extends Error {}

function resetModuleExports(): void {
  moduleState.bullmqExports.Queue = MockQueue;
  moduleState.bullmqExports.Worker = MockWorker;
  moduleState.bullmqExports.UnrecoverableError = MockUnrecoverableError;
  moduleState.ioredisExports.default = MockRedis;
  moduleState.ioredisExports.Redis = MockRedis;
}

mock.module('bullmq', () => ({
  default: moduleState.bullmqExports,
  get Queue() {
    return moduleState.bullmqExports.Queue;
  },
  get Worker() {
    return moduleState.bullmqExports.Worker;
  },
  get UnrecoverableError() {
    return moduleState.bullmqExports.UnrecoverableError;
  },
}));

mock.module('ioredis', () => ({
  get default() {
    return moduleState.ioredisExports.default;
  },
  get Redis() {
    return moduleState.ioredisExports.Redis;
  },
}));

let createBullMQWebhookQueue: typeof import('../../packages/slingshot-webhooks/src/queues/bullmq').createBullMQWebhookQueue;

function makeJobInput(overrides: Partial<JobInput> = {}): JobInput {
  return {
    deliveryId: 'delivery-1',
    endpointId: 'endpoint-1',
    url: 'https://example.com/webhook',
    secret: 'super-secret-token',
    event: 'auth:login',
    eventId: 'event-1',
    occurredAt: '2026-04-27T00:00:00.000Z',
    subscriber: { ownerType: 'tenant', ownerId: 'tenant-a', tenantId: 'tenant-a' },
    payload: '{"userId":"user-1"}',
    attempts: 0,
    ...overrides,
  };
}

beforeAll(async () => {
  resetModuleExports();
  ({ createBullMQWebhookQueue } =
    await import('../../packages/slingshot-webhooks/src/queues/bullmq'));
});

beforeEach(() => {
  state.queues.length = 0;
  state.workers.length = 0;
  state.connections.length = 0;
  state.nextJobId = 0;
  MockQueue.addReturnsMissingId = false;
  MockQueue.closeError = null;
  MockWorker.throwOnConstruct = null;
  MockWorker.closeError = null;
  MockRedis.pingError = null;
  MockRedis.quitError = null;
  resetModuleExports();
});

describe('webhook BullMQ queue', () => {
  it('starts, enqueues, reports depth, and stops with mocked dependencies', async () => {
    const queue = createBullMQWebhookQueue({
      redis: { host: 'localhost', port: 6379 },
      queueName: 'webhooks-test',
      maxAttempts: 4,
      retryBaseDelayMs: 250,
    });

    await queue.start(async () => {});

    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]?.pingCalls).toBe(1);
    expect(state.queues).toHaveLength(1);
    expect(state.workers).toHaveLength(1);
    expect(state.queues[0]?.name).toBe('webhooks-test');

    const jobId = await queue.enqueue(makeJobInput());
    expect(jobId).toBe('job-1');
    expect(state.queues[0]?.addedJobs[0]?.opts).toMatchObject({
      attempts: 4,
      backoff: { type: 'exponential', delay: 250 },
    });

    state.queues[0]!.countValue = 7;
    expect(await queue.depth!()).toBe(7);

    await queue.stop();
    expect(state.workers[0]?.closed).toBe(true);
    expect(state.queues[0]?.closed).toBe(true);
    expect(state.connections[0]?.closed).toBe(true);
  });

  it('rejects enqueue before start', async () => {
    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
    });

    await expect(queue.enqueue(makeJobInput())).rejects.toThrow(
      'BullMQ webhook queue not started - call start() first',
    );
  });

  it('rejects duplicate start calls', async () => {
    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
    });

    await queue.start(async () => {});

    await expect(queue.start(async () => {})).rejects.toThrow(
      'BullMQ webhook queue already started',
    );
  });

  it('converts non-retryable delivery failures into UnrecoverableError', async () => {
    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
    });

    await queue.start(async () => {
      throw new WebhookDeliveryError('permanent failure', false, 400);
    });

    const worker = state.workers[0];
    expect(worker).toBeDefined();

    await expect(
      worker!.processor({
        id: 'job-1',
        data: makeJobInput(),
        attemptsMade: 0,
        timestamp: Date.now(),
      }),
    ).rejects.toBeInstanceOf(MockUnrecoverableError);
  });

  it('invokes onDeadLetter for exhausted failures', async () => {
    const deadLetterMock = mock(() => {});
    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
      maxAttempts: 2,
      onDeadLetter: deadLetterMock,
    });

    await queue.start(async () => {
      throw new Error('upstream unavailable');
    });

    const worker = state.workers[0];
    const job = {
      id: 'job-1',
      data: makeJobInput(),
      attemptsMade: 2,
      timestamp: Date.now(),
    } satisfies BullJobShape;

    worker?.emitFailed(job, new Error('final failure'));

    expect(deadLetterMock).toHaveBeenCalledTimes(1);
    const [deadLetterJob, err] = deadLetterMock.mock.calls[0] as unknown as [
      JobInput & { id: string; attempts: number },
      Error,
    ];
    expect(deadLetterJob.id).toBe('job-1');
    expect(deadLetterJob.attempts).toBe(2);
    expect(err.message).toBe('final failure');
  });

  it('does not dead-letter intermediate retry failures', async () => {
    const deadLetterMock = mock(() => {});
    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
      maxAttempts: 3,
      onDeadLetter: deadLetterMock,
    });

    await queue.start(async () => {});

    state.workers[0]?.emitFailed(
      {
        id: 'job-1',
        data: makeJobInput(),
        attemptsMade: 1,
        timestamp: Date.now(),
      },
      new Error('retry me'),
    );

    expect(deadLetterMock).not.toHaveBeenCalled();
  });

  it('rejects BullMQ mocks with missing required exports', async () => {
    moduleState.bullmqExports.Worker = undefined;

    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
    });

    await expect(queue.start(async () => {})).rejects.toThrow(
      'BullMQ webhook queue requires bullmq Queue, Worker, and UnrecoverableError exports',
    );
  });

  it('redacts Redis credentials from connection errors', async () => {
    MockRedis.pingError = new Error('connection refused');

    const queue = createBullMQWebhookQueue({
      redis: 'redis://user:super-secret@localhost:6379/0',
    });

    await expect(queue.start(async () => {})).rejects.toThrow(
      'BullMQ webhook queue: failed to connect to Redis (redis://***:***@localhost:6379/0): connection refused',
    );
  });

  it('redacts Redis object passwords from connection errors', async () => {
    MockRedis.pingError = new Error('connection refused');

    const queue = createBullMQWebhookQueue({
      redis: { host: 'localhost', port: 6379, password: 'super-secret' },
    });

    await expect(queue.start(async () => {})).rejects.toThrow(
      'BullMQ webhook queue: failed to connect to Redis ({"host":"localhost","port":6379,"password":"***"}): connection refused',
    );
  });

  it('falls back to raw Redis targets when URL parsing fails', async () => {
    MockRedis.pingError = new Error('connection refused');

    const queue = createBullMQWebhookQueue({
      redis: 'not a redis url',
    });

    await expect(queue.start(async () => {})).rejects.toThrow(
      'BullMQ webhook queue: failed to connect to Redis (not a redis url): connection refused',
    );
  });

  it('cleans up partially started resources when worker construction fails', async () => {
    MockWorker.throwOnConstruct = new Error('worker init failed');

    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
    });

    await expect(queue.start(async () => {})).rejects.toThrow('worker init failed');
    expect(state.queues).toHaveLength(1);
    expect(state.queues[0]?.closed).toBe(true);
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]?.closed).toBe(true);
  });

  it('throws when BullMQ returns an enqueue result without an id', async () => {
    MockQueue.addReturnsMissingId = true;

    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
    });

    await queue.start(async () => {});

    await expect(queue.enqueue(makeJobInput())).rejects.toThrow(
      'BullMQ returned a job without an id',
    );
  });

  it('throws when dead-letter jobs are missing an id', async () => {
    const deadLetterMock = mock(() => {});
    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
      maxAttempts: 1,
      onDeadLetter: deadLetterMock,
    });

    await queue.start(async () => {});

    expect(() =>
      state.workers[0]?.emitFailed(
        {
          id: undefined,
          data: makeJobInput(),
          attemptsMade: 1,
          timestamp: Date.now(),
        },
        new Error('final failure'),
      ),
    ).toThrow('BullMQ returned a job without an id');
    expect(deadLetterMock).not.toHaveBeenCalled();
  });

  it('still clears internal state when stop surfaces close errors', async () => {
    MockWorker.closeError = new Error('worker close failed');
    MockQueue.closeError = new Error('queue close failed');
    MockRedis.quitError = new Error('redis quit failed');

    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
    });

    await queue.start(async () => {});

    await expect(queue.stop()).rejects.toThrow('worker close failed');
    expect(await queue.depth!()).toBe(0);
    await expect(queue.start(async () => {})).resolves.toBeUndefined();
  });
});
