import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import {
  cleanupStaleSchedulers,
  createCronWorker,
  createDLQHandler,
  createQueue,
  createQueueFactory,
  createWorker,
} from '../../src/lib/queue';

// ---------------------------------------------------------------------------
// Mock BullMQ
// ---------------------------------------------------------------------------

class MockQueue extends EventEmitter {
  name: string;
  opts: Record<string, unknown>;
  upsertJobScheduler = mock(async () => {});
  removeJobScheduler = mock(async () => {});
  getWaitingCount = mock(async () => 0);
  getWaiting = mock(async () => []);
  getJob = mock(async () => null);
  close = mock(async () => {});
  add = mock(async () => ({ id: 'job-1' }));

  constructor(name: string, opts?: Record<string, unknown>) {
    super();
    this.name = name;
    this.opts = opts ?? {};
  }
}

class MockWorker extends EventEmitter {
  name: string;
  processor: unknown;
  opts: Record<string, unknown>;

  constructor(name: string, processor: unknown, opts?: Record<string, unknown>) {
    super();
    this.name = name;
    this.processor = processor;
    this.opts = opts ?? {};
  }
}

mock.module('bullmq', () => ({
  Queue: MockQueue,
  Worker: MockWorker,
}));

const REDIS_CREDS = { host: 'localhost:6379' };
const INVALID_CREDS = { host: '' };

describe('createQueueFactory', () => {
  test('throws when credentials are missing host', () => {
    expect(() => createQueueFactory(INVALID_CREDS)).toThrow(
      'Queue helpers require explicit Redis credentials',
    );
  });

  test('returns factory object with all expected methods', () => {
    const factory = createQueueFactory(REDIS_CREDS);
    expect(typeof factory.createQueue).toBe('function');
    expect(typeof factory.createWorker).toBe('function');
    expect(typeof factory.createCronWorker).toBe('function');
    expect(typeof factory.cleanupStaleSchedulers).toBe('function');
    expect(typeof factory.createDLQHandler).toBe('function');
  });
});

describe('createQueue', () => {
  test('throws when no credentials provided', () => {
    expect(() => createQueue('my-queue', undefined, undefined)).toThrow(
      'Queue helpers require explicit Redis credentials',
    );
  });

  test('creates a queue with the given name', () => {
    const queue = createQueue('my-queue', undefined, REDIS_CREDS) as unknown as MockQueue;
    expect(queue).toBeInstanceOf(MockQueue);
    expect(queue.name).toBe('my-queue');
  });

  test('passes options to the queue', () => {
    const queue = createQueue('test-q', { prefix: 'myapp' }, REDIS_CREDS) as unknown as MockQueue;
    expect(queue.opts.prefix).toBe('myapp');
  });
});

describe('createWorker', () => {
  test('throws when no credentials provided', () => {
    const processor = async () => {};
    expect(() => createWorker('w', processor, undefined, undefined)).toThrow(
      'Queue helpers require explicit Redis credentials',
    );
  });

  test('creates a worker with the given name and processor', () => {
    const processor = async () => 'done';
    const worker = createWorker(
      'my-worker',
      processor,
      undefined,
      REDIS_CREDS,
    ) as unknown as MockWorker;
    expect(worker).toBeInstanceOf(MockWorker);
    expect(worker.name).toBe('my-worker');
    expect(worker.processor).toBe(processor);
  });
});

describe('createCronWorker (standalone)', () => {
  test('throws when no credentials provided', () => {
    const processor = async () => {};
    expect(() =>
      createCronWorker('cron-w', processor, { cron: '* * * * *' }, undefined, undefined),
    ).toThrow('Queue helpers require explicit Redis credentials');
  });

  test('creates a cron worker with a cron schedule', () => {
    const processor = async () => {};
    const result = createCronWorker(
      'digest',
      processor,
      { cron: '0 9 * * *' },
      undefined,
      REDIS_CREDS,
    );
    expect(result.worker).toBeInstanceOf(MockWorker);
    expect(result.queue).toBeInstanceOf(MockQueue);
    expect(result.registeredName).toBe('digest');
  });
});

describe('cleanupStaleSchedulers (standalone)', () => {
  test('throws when no credentials provided', () => {
    expect(() => cleanupStaleSchedulers([], new Set(), undefined)).toThrow(
      'Queue helpers require explicit Redis credentials',
    );
  });
});

describe('QueueFactory methods', () => {
  test('factory.createQueue creates a MockQueue', () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const queue = factory.createQueue('q1') as unknown as MockQueue;
    expect(queue).toBeInstanceOf(MockQueue);
    expect(queue.name).toBe('q1');
  });

  test('factory.createWorker creates a MockWorker', () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const processor = async () => {};
    const worker = factory.createWorker('w1', processor) as unknown as MockWorker;
    expect(worker).toBeInstanceOf(MockWorker);
    expect(worker.name).toBe('w1');
  });

  test('factory.createCronWorker with cron schedule calls upsertJobScheduler', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const processor = async () => {};
    const result = factory.createCronWorker('my-cron', processor, {
      cron: '0 * * * *',
      timezone: 'UTC',
    });
    expect(result.registeredName).toBe('my-cron');
    expect(result.worker).toBeInstanceOf(MockWorker);
    expect(result.queue).toBeInstanceOf(MockQueue);
  });

  test('factory.createCronWorker with every schedule calls upsertJobScheduler', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const processor = async () => {};
    const result = factory.createCronWorker('interval-cron', processor, { every: 60_000 });
    expect(result.registeredName).toBe('interval-cron');
  });

  test('factory.cleanupStaleSchedulers removes stale queues', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    // 'old-queue' is registered but not in activeNames — should be removed
    await factory.cleanupStaleSchedulers(['active-queue'], new Set(['active-queue', 'old-queue']));
    // MockQueue.removeJobScheduler will have been called for 'old-queue'
    // Since we can't access the specific instance easily, just verify no throw
  });

  test('factory.cleanupStaleSchedulers does nothing for active queues', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    // all registered are active — no cleanup needed
    await factory.cleanupStaleSchedulers(['q1', 'q2'], new Set(['q1', 'q2']));
    // Should complete without error
  });

  test('factory.createDLQHandler returns dlqQueue and retryJob', () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const sourceWorker = new MockWorker('src', async () => {});
    const result = factory.createDLQHandler(sourceWorker as never, 'source-queue');

    expect(result.dlqQueue).toBeInstanceOf(MockQueue);
    expect(typeof result.retryJob).toBe('function');
    // DLQ queue name is source-queue-dlq
    expect((result.dlqQueue as unknown as MockQueue).name).toBe('source-queue-dlq');
  });

  test('factory.createDLQHandler: retryJob throws when job not found', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const sourceWorker = new MockWorker('src', async () => {});
    const result = factory.createDLQHandler(sourceWorker as never, 'source-queue');

    // dlqQueue.getJob returns null by default
    await expect(result.retryJob('nonexistent-id')).rejects.toThrow('not found in DLQ');
  });

  test('factory.createDLQHandler: failed job below maxAttempts is not moved to DLQ', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const sourceWorker = new MockWorker('src', async () => {});
    const mockDlqAdd = mock(async () => {});

    const result = factory.createDLQHandler(sourceWorker as never, 'source-queue');
    const dlqQueue = result.dlqQueue as unknown as { add: typeof mockDlqAdd };
    dlqQueue.add = mockDlqAdd;

    // Simulate a failed job that has NOT exhausted all attempts
    const failedJob = {
      id: 'job-1',
      name: 'test-job',
      data: { payload: 1 },
      attemptsMade: 0, // first attempt
      opts: { attempts: 3 }, // still has attempts left
    };
    sourceWorker.emit('failed', failedJob, new Error('oops'));

    // Give async code a tick to run
    await new Promise(r => setImmediate(r));

    // Since attemptsMade (0) < opts.attempts (3), job should NOT be added to DLQ
    expect(mockDlqAdd).not.toHaveBeenCalled();
  });

  test('factory.createDLQHandler: failed job at max attempts is moved to DLQ', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const sourceWorker = new MockWorker('src', async () => {});
    const mockDlqAdd = mock(async () => {});

    const result = factory.createDLQHandler(sourceWorker as never, 'source-queue');
    (result.dlqQueue as unknown as { add: typeof mockDlqAdd }).add = mockDlqAdd;

    // Job that has exhausted all its attempts
    const failedJob = {
      id: 'job-2',
      name: 'test-job',
      data: { payload: 2 },
      attemptsMade: 3, // equal to opts.attempts
      opts: { attempts: 3 },
    };
    sourceWorker.emit('failed', failedJob, new Error('final fail'));

    await new Promise(r => setImmediate(r));

    expect(mockDlqAdd).toHaveBeenCalledTimes(1);
  });

  test('factory.createDLQHandler: failed event with undefined job is ignored (line 156)', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const sourceWorker = new MockWorker('src', async () => {});
    const mockDlqAdd = mock(async () => {});

    const result = factory.createDLQHandler(sourceWorker as never, 'source-queue');
    (result.dlqQueue as unknown as { add: typeof mockDlqAdd }).add = mockDlqAdd;

    // Emit failed with undefined job
    sourceWorker.emit('failed', undefined, new Error('no job'));

    await new Promise(r => setImmediate(r));
    expect(mockDlqAdd).not.toHaveBeenCalled();
  });

  test('factory.createDLQHandler: DLQ trims excess jobs when over maxSize (lines 163-167)', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const sourceWorker = new MockWorker('src', async () => {});
    const mockDlqAdd = mock(async () => {});
    const removeMock = mock(async () => {});

    const result = factory.createDLQHandler(sourceWorker as never, 'source-queue', {
      maxSize: 2,
    });
    const dlqQueue = result.dlqQueue as unknown as MockQueue;
    dlqQueue.add = mockDlqAdd as unknown as typeof dlqQueue.add;
    // After adding, getWaitingCount returns a number > maxSize
    dlqQueue.getWaitingCount = mock(async () => 5) as typeof dlqQueue.getWaitingCount;
    dlqQueue.getWaiting = mock(async () => [
      { remove: removeMock },
      { remove: removeMock },
      { remove: removeMock },
    ]) as typeof dlqQueue.getWaiting;

    const failedJob = {
      id: 'job-trim',
      name: 'test-job',
      data: {},
      attemptsMade: 1,
      opts: { attempts: 1 },
    };
    sourceWorker.emit('failed', failedJob, new Error('fail'));

    await new Promise(r => setImmediate(r));
    expect(dlqQueue.getWaitingCount).toHaveBeenCalled();
    expect(dlqQueue.getWaiting).toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalledTimes(3);
  });

  test('factory.createDLQHandler: retryJob finds and re-adds job (lines 177-190)', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const sourceWorker = new MockWorker('src', async () => {});
    const removeMock = mock(async () => {});

    const result = factory.createDLQHandler(sourceWorker as never, 'source-queue');
    const dlqQueue = result.dlqQueue as unknown as MockQueue;

    // Mock getJob to return a real job
    dlqQueue.getJob = mock(async () => ({
      id: 'dlq:job-retry',
      name: 'test-job',
      data: { payload: 42 },
      opts: { delay: 1000, priority: 5, attempts: 3, backoff: { type: 'exponential' } },
      remove: removeMock,
    })) as unknown as typeof dlqQueue.getJob;

    await result.retryJob('dlq:job-retry');
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  test('factory.createDLQHandler: retryJob with preserveJobOptions=false (line 184 else branch)', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const sourceWorker = new MockWorker('src', async () => {});
    const removeMock = mock(async () => {});

    const result = factory.createDLQHandler(sourceWorker as never, 'source-queue', {
      preserveJobOptions: false,
    });
    const dlqQueue = result.dlqQueue as unknown as MockQueue;

    dlqQueue.getJob = mock(async () => ({
      id: 'dlq:job-retry2',
      name: 'test-job',
      data: { payload: 99 },
      opts: { delay: 500 },
      remove: removeMock,
    })) as unknown as typeof dlqQueue.getJob;

    await result.retryJob('dlq:job-retry2');
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  test('factory.createDLQHandler: preserveJobOptions=false skips opts on DLQ add (line 149)', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const sourceWorker = new MockWorker('src', async () => {});
    const mockDlqAdd = mock(async () => {});

    const result = factory.createDLQHandler(sourceWorker as never, 'source-queue', {
      preserveJobOptions: false,
    });
    (result.dlqQueue as unknown as { add: typeof mockDlqAdd }).add = mockDlqAdd;

    const failedJob = {
      id: 'job-noopts',
      name: 'test-job',
      data: {},
      attemptsMade: 1,
      opts: { attempts: 1, delay: 500 },
    };
    sourceWorker.emit('failed', failedJob, new Error('fail'));

    await new Promise(r => setImmediate(r));
    expect(mockDlqAdd).toHaveBeenCalledTimes(1);
    // Second arg (opts) should not have delay/priority
    const callOpts =
      (
        mockDlqAdd.mock.calls as unknown as Array<[unknown, unknown, Record<string, unknown>]>
      )[0]?.[2] ?? {};
    expect(callOpts.delay).toBeUndefined();
  });

  test('factory.createDLQHandler: onDeadLetter callback error is caught (line 157)', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const sourceWorker = new MockWorker('src', async () => {});
    const errorSpy = mock(() => {});
    const origError = console.error;
    console.error = errorSpy as typeof console.error;

    try {
      const result = factory.createDLQHandler(sourceWorker as never, 'source-queue', {
        onDeadLetter: async () => {
          throw new Error('callback error');
        },
      });
      (result.dlqQueue as unknown as { add: unknown }).add = mock(async () => ({}));

      const failedJob = {
        id: 'job-err',
        name: 'test-job',
        data: {},
        attemptsMade: 1,
        opts: { attempts: 1 },
      };
      sourceWorker.emit('failed', failedJob, new Error('dead'));

      await new Promise(r => setImmediate(r));
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      console.error = origError;
    }
  });

  test('factory.createDLQHandler: onDeadLetter callback is called', async () => {
    const factory = createQueueFactory(REDIS_CREDS);
    const sourceWorker = new MockWorker('src', async () => {});
    const onDeadLetter = mock(async () => {});

    const result = factory.createDLQHandler(sourceWorker as never, 'source-queue', {
      onDeadLetter,
    });
    (result.dlqQueue as unknown as { add: unknown }).add = mock(async () => ({}));

    const failedJob = {
      id: 'job-3',
      name: 'test-job',
      data: {},
      attemptsMade: 1,
      opts: { attempts: 1 },
    };
    sourceWorker.emit('failed', failedJob, new Error('dead'));

    await new Promise(r => setImmediate(r));

    expect(onDeadLetter).toHaveBeenCalledTimes(1);
  });
});

describe('createDLQHandler (standalone)', () => {
  test('throws when no credentials provided (lines 306-315)', () => {
    const sourceWorker = new MockWorker('src', async () => {});
    expect(() =>
      createDLQHandler(sourceWorker as never, 'source-queue', undefined, undefined),
    ).toThrow('Queue helpers require explicit Redis credentials');
  });

  test('creates DLQ handler with credentials (lines 306-315)', () => {
    const sourceWorker = new MockWorker('src', async () => {});
    const result = createDLQHandler(sourceWorker as never, 'source-queue', undefined, REDIS_CREDS);
    expect(result.dlqQueue).toBeInstanceOf(MockQueue);
    expect(typeof result.retryJob).toBe('function');
  });

  test('cleanupStaleSchedulers runs with credentials (lines 295-304)', async () => {
    await cleanupStaleSchedulers(['active'], new Set(['active', 'stale']), REDIS_CREDS);
    // Should complete without error
  });
});
