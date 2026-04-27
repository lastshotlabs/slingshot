/**
 * Unit tests for createBullMQWebhookQueue.
 *
 * This file must run in isolation because mock.module() intercepts the dynamic
 * import() calls inside loadBullMQModule() and loadIORedisModule(). Mixing this
 * with other test files that use the real modules would cause interference.
 */
import { describe, expect, it, mock } from 'bun:test';
import { WebhookDeliveryError } from '../../src/types/queue';
import type { WebhookJob } from '../../src/types/queue';

// ---------------------------------------------------------------------------
// Fake Redis
// ---------------------------------------------------------------------------

class MockRedis {
  readonly host: string;
  private _shouldFailPing = false;

  constructor(
    hostOrUrl: string | { host: string; port?: number; password?: string },
    _opts?: Record<string, unknown>,
  ) {
    if (typeof hostOrUrl === 'string') {
      // URL form — extract host for error messages
      try {
        const url = new URL(hostOrUrl);
        this.host = url.hostname;
      } catch {
        this.host = hostOrUrl;
      }
    } else {
      this.host = hostOrUrl.host;
    }
  }

  /** Configure this instance to throw on ping() */
  failPing(err: Error) {
    this._shouldFailPing = true;
    this._pingError = err;
    return this;
  }

  private _pingError: Error = new Error('ping failed');

  async ping() {
    if (this._shouldFailPing) {
      throw this._pingError;
    }
    return 'PONG';
  }

  async quit() {}
}

// ---------------------------------------------------------------------------
// Fake BullMQ Queue / Worker
// ---------------------------------------------------------------------------

type FailedHandler = (job: FakeBullJob | undefined, err: Error) => void;

interface FakeBullJob {
  id: string;
  data: Record<string, unknown>;
  attemptsMade: number;
  timestamp: number;
}

class FakeQueue {
  readonly name: string;
  readonly addCalls: Array<{ name: string; data: unknown; opts: unknown }> = [];
  closed = false;

  constructor(name: string, _opts?: unknown) {
    this.name = name;
  }

  async add(name: string, data: unknown, opts?: unknown) {
    this.addCalls.push({ name, data, opts });
    return { id: `job-${this.addCalls.length}` };
  }

  async close() {
    this.closed = true;
  }
}

class FakeWorker {
  readonly queueName: string;
  processor: ((job: FakeBullJob) => Promise<void>) | null;
  readonly failedHandlers: FailedHandler[] = [];
  closed = false;

  constructor(queueName: string, processor: (job: FakeBullJob) => Promise<void>, _opts?: unknown) {
    this.queueName = queueName;
    this.processor = processor;
    lastCreatedWorker = this;
  }

  on(event: string, handler: FailedHandler) {
    if (event === 'failed') this.failedHandlers.push(handler);
    return this;
  }

  async close() {
    this.closed = true;
  }

  /** Test helper: fire the 'failed' event on all registered handlers. */
  fireFailedEvent(job: FakeBullJob | undefined, err: Error) {
    for (const h of this.failedHandlers) h(job, err);
  }
}

class FakeUnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

let lastCreatedWorker: FakeWorker | null = null;
let nextRedisFailPingError: Error | null = null;

// ---------------------------------------------------------------------------
// mock.module — must be called before any dynamic import of the source
// ---------------------------------------------------------------------------

mock.module('bullmq', () => ({
  Queue: FakeQueue,
  Worker: FakeWorker,
  UnrecoverableError: FakeUnrecoverableError,
}));

mock.module('ioredis', () => ({
  default: class ControlledMockRedis extends MockRedis {
    constructor(
      hostOrUrl: string | { host: string; port?: number; password?: string },
      opts?: Record<string, unknown>,
    ) {
      super(hostOrUrl, opts);
      if (nextRedisFailPingError) {
        const err = nextRedisFailPingError;
        nextRedisFailPingError = null;
        this.failPing(err);
      }
    }
  },
}));

// Dynamic import AFTER mock.module() so the mocks intercept the lazy imports
const { createBullMQWebhookQueue } = await import('../../src/queues/bullmq');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJobInput(): Omit<WebhookJob, 'id' | 'createdAt'> {
  return {
    deliveryId: 'del-1',
    endpointId: 'ep-1',
    url: 'https://example.com/hook',
    secret: 'secret',
    event: 'auth:login' as WebhookJob['event'],
    eventId: 'evt-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    subscriber: { ownerType: 'user', ownerId: 'user-1', tenantId: 'tenant-a' },
    payload: '{"userId":"u1"}',
    attempts: 0,
  };
}

function makeFakeBullJob(overrides?: Partial<FakeBullJob>): FakeBullJob {
  return {
    id: 'job-1',
    data: {
      deliveryId: 'del-1',
      endpointId: 'ep-1',
      url: 'https://example.com/hook',
      secret: 'secret',
      event: 'auth:login',
      eventId: 'evt-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      subscriber: { ownerType: 'user', ownerId: 'user-1', tenantId: 'tenant-a' },
      payload: '{"userId":"u1"}',
    },
    attemptsMade: 5,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: enqueue before start throws
// ---------------------------------------------------------------------------

describe('createBullMQWebhookQueue — enqueue before start', () => {
  it('throws when enqueue is called before start()', async () => {
    const queue = createBullMQWebhookQueue({
      redis: { host: 'localhost', port: 6379 },
    });

    await expect(queue.enqueue(makeJobInput())).rejects.toThrow(/not started/i);
  });
});

// ---------------------------------------------------------------------------
// Test 2: start with Redis ping failure
// ---------------------------------------------------------------------------

describe('createBullMQWebhookQueue — start with Redis ping failure', () => {
  it('rejects with a message containing the target hostname and the reason', async () => {
    const pingError = new Error('Connection refused');
    nextRedisFailPingError = pingError;

    const queue = createBullMQWebhookQueue({
      redis: { host: 'redis.example.com', port: 6379 },
    });

    await expect(queue.start(async () => {})).rejects.toThrow(
      /redis\.example\.com.*Connection refused|Connection refused.*redis\.example\.com/,
    );
  });
});

// ---------------------------------------------------------------------------
// Test 3: stop is safe when not started
// ---------------------------------------------------------------------------

describe('createBullMQWebhookQueue — stop when not started', () => {
  it('resolves without error when stop() is called before start()', async () => {
    const queue = createBullMQWebhookQueue({
      redis: { host: 'localhost', port: 6379 },
    });

    await expect(queue.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 4: onDeadLetter called for exhausted jobs
// ---------------------------------------------------------------------------

describe('createBullMQWebhookQueue — onDeadLetter for exhausted jobs', () => {
  it('calls onDeadLetter when a job has exhausted its attempts', async () => {
    lastCreatedWorker = null;

    const deadLetterCalls: Array<{ job: WebhookJob; err: Error }> = [];

    const queue = createBullMQWebhookQueue({
      redis: { host: 'localhost', port: 6379 },
      maxAttempts: 5,
      onDeadLetter(job, err) {
        deadLetterCalls.push({ job, err });
      },
    });

    await queue.start(async () => {});

    const worker = lastCreatedWorker!;
    expect(worker).not.toBeNull();

    const bullJob = makeFakeBullJob({ attemptsMade: 5 });
    const failureErr = new Error('Max attempts exceeded');

    worker.fireFailedEvent(bullJob, failureErr);

    // onDeadLetter is invoked via void Promise.resolve() — tick the microtask queue
    await new Promise(r => setTimeout(r, 0));

    expect(deadLetterCalls).toHaveLength(1);
    expect(deadLetterCalls[0]!.job.deliveryId).toBe('del-1');
    expect(deadLetterCalls[0]!.err).toBe(failureErr);

    await queue.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 5: non-retryable WebhookDeliveryError triggers UnrecoverableError
// ---------------------------------------------------------------------------

describe('createBullMQWebhookQueue — non-retryable WebhookDeliveryError', () => {
  it('wraps a non-retryable WebhookDeliveryError in UnrecoverableError inside the processor', async () => {
    lastCreatedWorker = null;

    const nonRetryableErr = new WebhookDeliveryError('Bad request', false, 400);

    const queue = createBullMQWebhookQueue({
      redis: { host: 'localhost', port: 6379 },
      maxAttempts: 5,
    });

    await queue.start(async () => {
      throw nonRetryableErr;
    });

    const worker = lastCreatedWorker!;
    expect(worker).not.toBeNull();
    expect(worker.processor).not.toBeNull();

    const bullJob = makeFakeBullJob({ attemptsMade: 1 });

    await expect(worker.processor!(bullJob)).rejects.toThrow(FakeUnrecoverableError);

    await queue.stop();
  });
});
