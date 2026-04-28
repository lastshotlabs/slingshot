import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createBullMQMailQueue } from '../../src/queues/bullmq.js';
import { MailSendError } from '../../src/types/provider.js';
import type { MailProvider } from '../../src/types/provider.js';

// ---------------------------------------------------------------------------
// Mocks MUST come before any imports of the module under test.
// Bun evaluates mock.module() at call time, affecting future dynamic imports.
// ---------------------------------------------------------------------------

// Track worker event handlers and processor so tests can trigger them
let workerFailedHandler: ((job: unknown, err: Error) => void) | null = null;
let capturedProcessor: ((job: { data: unknown }) => Promise<void>) | null = null;

const mockQueueAdd = mock(async () => ({
  id: 'job-123',
}));
const mockQueueClose = mock(async () => {});
const mockQueueCount = mock(async () => 5);

const mockWorkerClose = mock(async () => {});
const mockWorkerOn = mock((event: string, handler: (...args: unknown[]) => void) => {
  if (event === 'failed') {
    workerFailedHandler = handler as (job: unknown, err: Error) => void;
  }
});

function MockQueue(this: unknown) {
  return {
    add: mockQueueAdd,
    close: mockQueueClose,
    count: mockQueueCount,
  };
}

function MockWorker(this: unknown, _name: string, processor: unknown) {
  capturedProcessor = processor as (job: { data: unknown }) => Promise<void>;
  return {
    close: mockWorkerClose,
    on: mockWorkerOn,
  };
}

class MockUnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

const mockPing = mock(async () => 'PONG');
const mockQuit = mock(async () => {});

function MockIORedis(this: unknown) {
  return {
    ping: mockPing,
    quit: mockQuit,
  };
}

mock.module('bullmq', () => ({
  Queue: MockQueue,
  Worker: MockWorker,
  UnrecoverableError: MockUnrecoverableError,
}));

mock.module('ioredis', () => ({
  default: MockIORedis,
  Redis: MockIORedis,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(sendImpl?: MailProvider['send']): MailProvider {
  return {
    name: 'test',
    send: mock(sendImpl ?? (async () => ({ status: 'sent' as const }))),
  };
}

function resetMocks() {
  workerFailedHandler = null;
  capturedProcessor = null;
  mockQueueAdd.mockReset();
  mockQueueClose.mockReset();
  mockQueueCount.mockReset();
  mockWorkerClose.mockReset();
  mockWorkerOn.mockReset();
  mockPing.mockReset();
  mockQuit.mockReset();

  mockQueueAdd.mockImplementation(async () => ({ id: 'job-123' }));
  mockQueueClose.mockImplementation(async () => {});
  mockQueueCount.mockImplementation(async () => 5);
  mockWorkerClose.mockImplementation(async () => {});
  mockWorkerOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'failed') {
      workerFailedHandler = handler as (job: unknown, err: Error) => void;
    }
  });
  mockPing.mockImplementation(async () => 'PONG');
  mockQuit.mockImplementation(async () => {});
}

beforeEach(resetMocks);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createBullMQMailQueue', () => {
  describe('start()', () => {
    it('creates IORedis connection → calls connection.ping() → creates Queue + Worker', async () => {
      const q = createBullMQMailQueue({ redis: { host: 'localhost', port: 6379 } });
      await q.start(makeProvider());

      expect(mockPing).toHaveBeenCalledTimes(1);
    });

    it('Redis ping throws → throws descriptive error with connection string', async () => {
      mockPing.mockRejectedValue(new Error('Connection refused'));

      const q = createBullMQMailQueue({
        redis: { host: 'localhost', port: 6379 },
        queueName: 'my-mail-queue',
      });

      const err = await q.start(makeProvider()).catch(e => e);

      expect(err).toBeInstanceOf(Error);
      // Source error format: "BullMQ mail queue: failed to connect to Redis ({connStr}): {err.message}"
      expect(err.message).toContain('BullMQ mail queue');
      expect(err.message).toContain('Connection refused');
    });
  });

  describe('enqueue()', () => {
    it('enqueue() before start() → throws containing "not started"', async () => {
      const q = createBullMQMailQueue({ redis: { host: 'localhost' } });

      const err = await q
        .enqueue({ to: 'r@example.com', subject: 'X', html: '<p>X</p>' })
        .catch(e => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message.toLowerCase()).toContain('not started');
    });

    it('enqueue() after start() → calls queue.add("send", ...) with correct attempts/backoff config; returns job ID', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'enqueue-job-id' });

      const q = createBullMQMailQueue({
        redis: { host: 'localhost' },
        maxAttempts: 5,
        retryBaseDelayMs: 2000,
      });
      await q.start(makeProvider());

      const msg = { to: 'user@example.com', subject: 'Test', html: '<p>test</p>' };
      const jobId = await q.enqueue(msg, { sourceEvent: 'auth:welcome' });

      expect(jobId).toBe('enqueue-job-id');
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);

      const [jobName, data, opts] = mockQueueAdd.mock.calls[0] as unknown as [
        string,
        unknown,
        { attempts: number; backoff: { type: string; delay: number } },
      ];
      expect(jobName).toBe('send');
      expect((data as { message: typeof msg }).message).toEqual(msg);
      expect((data as { sourceEvent: string }).sourceEvent).toBe('auth:welcome');
      expect(opts.attempts).toBe(5);
      expect(opts.backoff.type).toBe('exponential');
      expect(opts.backoff.delay).toBe(2000);
    });
  });

  describe('stop()', () => {
    it('stop() → closes worker, queue, connection (all three called)', async () => {
      const q = createBullMQMailQueue({ redis: { host: 'localhost' } });
      await q.start(makeProvider());
      await q.stop();

      expect(mockWorkerClose).toHaveBeenCalledTimes(1);
      expect(mockQueueClose).toHaveBeenCalledTimes(1);
      expect(mockQuit).toHaveBeenCalledTimes(1);
    });
  });

  describe('depth()', () => {
    it('depth() → returns queue.count()', async () => {
      mockQueueCount.mockResolvedValue(42);

      const q = createBullMQMailQueue({ redis: { host: 'localhost' } });
      await q.start(makeProvider());

      const d = await q.depth!();
      expect(d).toBe(42);
      expect(mockQueueCount).toHaveBeenCalledTimes(1);
    });
  });

  describe('drain()', () => {
    it('drain() before start() resolves immediately without error', async () => {
      const q = createBullMQMailQueue({ redis: { host: 'localhost' } });
      await expect(q.drain?.()).resolves.toBeUndefined();
    });

    it('drain() after start() calls queue.drain() on the underlying BullMQ queue', async () => {
      const mockQueueDrain = mock(async () => {});
      // Override MockQueue to include drain
      const originalMockQueueAdd = mockQueueAdd;
      void originalMockQueueAdd;

      // Patch the mock queue to expose drain
      const patchedQueue = {
        add: mockQueueAdd,
        close: mockQueueClose,
        count: mockQueueCount,
        drain: mockQueueDrain,
      };

      mock.module('bullmq', () => ({
        Queue: function MockQueueWithDrain() {
          return patchedQueue;
        },
        Worker: MockWorker,
        UnrecoverableError: MockUnrecoverableError,
      }));

      // Re-import after mock patch
      const { createBullMQMailQueue: freshCreate } = await import('../../src/queues/bullmq.js');
      const q = freshCreate({ redis: { host: 'localhost' } });
      await q.start(makeProvider());

      await q.drain?.();

      expect(mockQueueDrain).toHaveBeenCalledTimes(1);

      // Restore original mock
      mock.module('bullmq', () => ({
        Queue: MockQueue,
        Worker: MockWorker,
        UnrecoverableError: MockUnrecoverableError,
      }));
    });

    it('drain() is defined on the returned MailQueue object', async () => {
      const q = createBullMQMailQueue({ redis: { host: 'localhost' } });
      expect(typeof q.drain).toBe('function');
    });
  });

  describe('Worker processor', () => {
    it('successful send → processor resolves without throwing', async () => {
      const q = createBullMQMailQueue({ redis: { host: 'localhost' } });
      await q.start(makeProvider());

      expect(capturedProcessor).not.toBeNull();

      const msg = { to: 'u@example.com', subject: 'S', html: '<p>S</p>' };
      await expect(capturedProcessor!({ data: { message: msg } })).resolves.toBeUndefined();
    });

    it('retryable MailSendError → processor rethrows original error (BullMQ retries)', async () => {
      const retryableErr = new MailSendError('Service unavailable', true, 503);
      const provider = makeProvider(async () => {
        throw retryableErr;
      });

      const q = createBullMQMailQueue({ redis: { host: 'localhost' } });
      await q.start(provider);

      const msg = { to: 'u@example.com', subject: 'S', html: '<p>S</p>' };
      const thrown = await capturedProcessor!({ data: { message: msg } }).catch(e => e);

      // Retryable errors are rethrown as-is so BullMQ can retry them
      expect(thrown).toBe(retryableErr);
      expect(thrown.name).not.toBe('UnrecoverableError');
    });

    it('non-retryable MailSendError → processor throws UnrecoverableError (no retries)', async () => {
      const permanentErr = new MailSendError('Invalid recipient', false, 422);
      const provider = makeProvider(async () => {
        throw permanentErr;
      });

      const q = createBullMQMailQueue({ redis: { host: 'localhost' } });
      await q.start(provider);

      const msg = { to: 'u@example.com', subject: 'S', html: '<p>S</p>' };
      const thrown = await capturedProcessor!({ data: { message: msg } }).catch(e => e);

      expect(thrown.name).toBe('UnrecoverableError');
      expect(thrown.message).toBe('Invalid recipient');
    });

    it('provider returns rejected status → processor throws UnrecoverableError', async () => {
      const provider = makeProvider(async () => ({ status: 'rejected' as const }));

      const q = createBullMQMailQueue({ redis: { host: 'localhost' } });
      await q.start(provider);

      const msg = { to: 'u@example.com', subject: 'S', html: '<p>S</p>' };
      const thrown = await capturedProcessor!({ data: { message: msg } }).catch(e => e);

      expect(thrown.name).toBe('UnrecoverableError');
    });

    it('hung provider send times out as retryable MailSendError', async () => {
      const provider = makeProvider(async () => new Promise<never>(() => {}));
      const q = createBullMQMailQueue({ redis: { host: 'localhost' }, sendTimeoutMs: 10 });
      await q.start(provider);

      const msg = { to: 'u@example.com', subject: 'S', html: '<p>S</p>' };
      const thrown = await capturedProcessor!({ data: { message: msg } }).catch(e => e);

      expect(thrown).toBeInstanceOf(MailSendError);
      expect(thrown.retryable).toBe(true);
      expect(thrown.message).toContain('timed out');
    });
  });

  describe('Worker failed handler', () => {
    it('attemptsMade >= maxAttempts → config.onDeadLetter called', async () => {
      const onDeadLetter = mock(() => {});

      const q = createBullMQMailQueue({
        redis: { host: 'localhost' },
        maxAttempts: 3,
        onDeadLetter,
      });
      await q.start(makeProvider());

      expect(workerFailedHandler).not.toBeNull();

      const failedJob = {
        id: 'job-456',
        data: {
          message: { to: 'u@example.com', subject: 'S', html: '<p>S</p>' },
          sourceEvent: 'auth:welcome',
        },
        attemptsMade: 3,
        timestamp: Date.now(),
      };
      const failErr = new Error('Delivery failed permanently');

      workerFailedHandler!(failedJob, failErr);

      expect(onDeadLetter).toHaveBeenCalledTimes(1);
      const [deadJob, deadErr] = onDeadLetter.mock.calls[0] as unknown as [
        { id: string; attempts: number },
        Error,
      ];
      expect(deadJob.id).toBe('job-456');
      expect(deadJob.attempts).toBe(3);
      expect(deadErr).toBe(failErr);
    });

    it('attemptsMade < maxAttempts → onDeadLetter NOT called', async () => {
      const onDeadLetter = mock(() => {});

      const q = createBullMQMailQueue({
        redis: { host: 'localhost' },
        maxAttempts: 3,
        onDeadLetter,
      });
      await q.start(makeProvider());

      const failedJob = {
        id: 'job-789',
        data: { message: { to: 'u@example.com', subject: 'S', html: '<p>S</p>' } },
        attemptsMade: 2,
        timestamp: Date.now(),
      };

      workerFailedHandler!(failedJob, new Error('Transient error'));

      expect(onDeadLetter).not.toHaveBeenCalled();
    });

    it('non-retryable error → onDeadLetter receives original MailSendError with full context', async () => {
      const onDeadLetter = mock(() => {});
      const originalErr = new MailSendError('Invalid recipient', false, 422, 'provider data');
      const provider = makeProvider(async () => {
        throw originalErr;
      });

      const q = createBullMQMailQueue({
        redis: { host: 'localhost' },
        maxAttempts: 1,
        onDeadLetter,
      });
      await q.start(provider);

      // Run the processor to get the UnrecoverableError that BullMQ would propagate
      const msg = { to: 'u@example.com', subject: 'S', html: '<p>S</p>' };
      const thrownErr = await capturedProcessor!({ data: { message: msg } }).catch(e => e);
      expect(thrownErr.name).toBe('UnrecoverableError');

      // Simulate BullMQ calling the failed handler after 1 attempt (maxAttempts reached)
      const failedJob = {
        id: 'job-perm',
        data: { message: msg },
        attemptsMade: 1,
        timestamp: Date.now(),
      };
      workerFailedHandler!(failedJob, thrownErr);

      expect(onDeadLetter).toHaveBeenCalledTimes(1);
      const [, receivedErr] = onDeadLetter.mock.calls[0] as unknown as [unknown, MailSendError];
      // Original MailSendError with statusCode and providerError is preserved
      expect(receivedErr).toBe(originalErr);
      expect((receivedErr as MailSendError).statusCode).toBe(422);
      expect((receivedErr as MailSendError).retryable).toBe(false);
    });

    it('non-retryable error with maxAttempts > 1 → onDeadLetter called on first attempt (not after all retries)', async () => {
      const onDeadLetter = mock(() => {});
      const originalErr = new MailSendError('Invalid recipient', false, 422);
      const provider = makeProvider(async () => {
        throw originalErr;
      });

      // maxAttempts is 3 — without the nonRetryableOrigins.has(err) check,
      // onDeadLetter would never fire at attemptsMade=1
      const q = createBullMQMailQueue({
        redis: { host: 'localhost' },
        maxAttempts: 3,
        onDeadLetter,
      });
      await q.start(provider);

      const msg = { to: 'u@example.com', subject: 'S', html: '<p>S</p>' };
      const thrownErr = await capturedProcessor!({ data: { message: msg } }).catch(e => e);
      expect(thrownErr.name).toBe('UnrecoverableError');

      // BullMQ fires failed with attemptsMade=1 — still below maxAttempts=3
      const failedJob = {
        id: 'job-unrecoverable',
        data: { message: msg },
        attemptsMade: 1,
        timestamp: Date.now(),
      };
      workerFailedHandler!(failedJob, thrownErr);

      // onDeadLetter must still be called via the nonRetryableOrigins.has(err) branch
      expect(onDeadLetter).toHaveBeenCalledTimes(1);
      const [, receivedErr] = onDeadLetter.mock.calls[0] as unknown as [unknown, MailSendError];
      expect(receivedErr).toBe(originalErr);
    });
  });
});
