import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { type ProgressCapability, defineTask } from '@lastshotlabs/slingshot-orchestration';
import {
  FakeJob,
  FakeQueue,
  FakeQueueEvents,
  FakeRedisClient,
  FakeWorker,
  createFakeBullMQModule,
  resetFakeBullMQState,
} from '../src/testing';

const mockRedis = new FakeRedisClient();

mock.module('bullmq', () => createFakeBullMQModule(mockRedis));

let createBullMQOrchestrationAdapter: (typeof import('../src/adapter'))['createBullMQOrchestrationAdapter'];

beforeAll(async () => {
  const mod = await import('../src/adapter');
  createBullMQOrchestrationAdapter = mod.createBullMQOrchestrationAdapter;
});

describe('bullmq orchestration adapter', () => {
  beforeEach(() => {
    resetFakeBullMQState();
    // Re-establish the custom client so adapter reads from mockRedis
    FakeQueue.customClient = mockRedis;
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

    const queueEventsBefore = FakeQueueEvents.instances.length;
    const workersBefore = FakeWorker.instances.length;

    const handle = await adapter.runTask(task.name, { value: 'ok' });
    await expect(handle.result()).resolves.toEqual({ value: 'ok' });

    expect(FakeQueueEvents.instances.length).toBeGreaterThan(queueEventsBefore);
    expect(FakeWorker.instances.length).toBeGreaterThan(workersBefore);
  });

  test('retains failure state until reset() then retries startup (P-OBULLMQ-5)', async () => {
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

    FakeWorker.failOnConstruction = new Error('worker failed');
    await expect(adapter.runTask(task.name, { value: 'ok' })).rejects.toThrow('worker failed');

    // Failed state is retained: a subsequent call returns the same error,
    // even after FakeWorker.failOnConstruction has been cleared.
    FakeWorker.failOnConstruction = null;
    await expect(adapter.runTask(task.name, { value: 'ok' })).rejects.toThrow('worker failed');

    // reset() is required to allow another initialization attempt.
    (adapter as unknown as { reset(): void }).reset();
    const handle = await adapter.runTask(task.name, { value: 'ok' });
    await expect(handle.result()).resolves.toEqual({ value: 'ok' });
  });

  test('listRuns maps BullMQ job states to portable run statuses', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'status-map',
    });

    const taskQueue = FakeQueue.instances.find(queue => queue.name === 'status-map_tasks');
    const workflowQueue = FakeQueue.instances.find(queue => queue.name === 'status-map_workflows');

    if (taskQueue) {
      taskQueue.jobs.push(
        new FakeJob({
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
        new FakeJob({
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

    expect(FakeQueueEvents.instances.length).toBeGreaterThan(0);
    expect(
      FakeQueueEvents.instances.every(
        queueEvents => (queueEvents.listeners.get('progress')?.size ?? 0) === 0,
      ),
    ).toBe(true);
  });

  test('cancelRun returns best-effort outcome when job.remove leaves the job present (P-OBULLMQ-1)', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'cancel-best-effort',
    });
    const task = defineTask({
      name: 'cancel-best-effort-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    const handle = await adapter.runTask(task.name, { value: 'pending' });

    // Patch FakeJob.remove on the live instance so the call resolves but the
    // job is NOT removed from the queue. This mirrors the production race
    // where job.remove() returns without throwing while the underlying Redis
    // op was a no-op (lock contention, partial delete, etc.).
    const taskQueue = FakeQueue.instances.find(queue => queue.name === 'cancel-best-effort_tasks');
    expect(taskQueue).toBeDefined();
    const job = taskQueue!.jobs[0];
    expect(job).toBeDefined();
    job!.remove = async () => {
      // Intentionally a no-op so the verification poll sees the job still present.
    };

    const outcome = await adapter.cancelRun(handle.id);
    expect(outcome).toBeDefined();
    expect((outcome as { cancelStatus: string }).cancelStatus).toBe('best-effort');
    expect((outcome as { message?: string }).message).toMatch(/still visible/);

    await adapter.shutdown();
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

  test('quarantines a stored run snapshot with invalid JSON (P-OBULLMQ-2)', async () => {
    const corruptRunId = 'corrupt-run-id';
    const prefix = 'corrupt-snapshot';
    await mockRedis.set(`${prefix}:cancelled:run:${corruptRunId}`, '{not valid json');
    await mockRedis.zadd(`${prefix}:cancelled:runs`, Date.now(), corruptRunId);

    const logs: Array<{ msg: string }> = [];
    const events: Array<{ name: string }> = [];
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix,
      structuredLogger: {
        debug() {},
        info() {},
        warn() {},
        error(msg) {
          logs.push({ msg });
        },
        child() {
          return this as never;
        },
      },
      eventSink: {
        emit(name) {
          events.push({ name });
        },
      },
    });

    const result = await adapter.listRuns({ status: 'cancelled' });
    expect(result.total).toBe(0);
    expect(logs.some(l => l.msg === 'orchestration.bullmq.snapshotMalformed')).toBe(true);
    expect(events.some(e => e.name === 'orchestration.bullmq.snapshotMalformed')).toBe(true);

    // Snapshot is preserved under :malformed for forensics.
    const preserved = await mockRedis.get(`${prefix}:cancelled:run:${corruptRunId}:malformed`);
    expect(preserved).toBe('{not valid json');

    await adapter.shutdown();
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
    const queue = FakeQueue.instances.find(instance => instance.name === 'cancelled-failure_tasks');
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

// ---------------------------------------------------------------------------
// Schedule persistence (mock-based)
// ---------------------------------------------------------------------------

describe('bullmq orchestration adapter – schedule management', () => {
  beforeEach(() => {
    resetFakeBullMQState();
  });

  test('schedule() adds a repeatable job with correct cron pattern', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'sched-add',
    });
    const task = defineTask({
      name: 'sched-task',
      input: z.object({ run: z.boolean() }),
      output: z.object({ run: z.boolean() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    const handle = await adapter.schedule({ type: 'task', name: task.name }, '0 * * * *', {
      run: true,
    });

    expect(handle.id).toMatch(/^slingshot-schedule-task-sched-task-/);
    expect(handle.cron).toBe('0 * * * *');
    expect(handle.target).toEqual({ type: 'task', name: task.name });

    const taskQueue = FakeQueue.instances.find(q => q.name === 'sched-add_tasks');
    expect(taskQueue).toBeDefined();
    const scheduler = taskQueue!.schedulers[0];
    expect(scheduler).toBeDefined();
    expect(scheduler!.key).toBe(handle.id);
    expect(scheduler!.pattern).toBe('0 * * * *');

    await adapter.shutdown();
  });

  test('unschedule() removes the repeatable job', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'sched-remove',
    });
    const task = defineTask({
      name: 'sched-remove-task',
      input: z.object({ run: z.boolean() }),
      output: z.object({ run: z.boolean() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    const handle = await adapter.schedule({ type: 'task', name: task.name }, '*/5 * * * *', {
      run: true,
    });

    const taskQueue = FakeQueue.instances.find(q => q.name === 'sched-remove_tasks');
    expect(taskQueue!.schedulers).toHaveLength(1);

    await adapter.unschedule(handle.id);

    expect(taskQueue!.schedulers).toHaveLength(0);

    await adapter.shutdown();
  });

  test('unschedule() on a non-existent ID does not throw', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'sched-noop',
    });
    // No tasks registered, no schedules created
    await expect(adapter.unschedule('nonexistent-schedule-id')).resolves.toBeUndefined();
    await adapter.shutdown();
  });

  test('listSchedules() returns entries with correct shape', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'sched-list',
    });
    const task = defineTask({
      name: 'sched-list-task',
      input: z.object({ run: z.boolean() }),
      output: z.object({ run: z.boolean() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    await adapter.schedule({ type: 'task', name: task.name }, '0 9 * * 1', { run: true });

    const schedules = await adapter.listSchedules();
    expect(schedules).toHaveLength(1);
    const sched = schedules[0];
    expect(sched).toBeDefined();
    expect(typeof sched!.id).toBe('string');
    expect(sched!.target.type).toBe('task');
    expect(sched!.target.name).toBe(task.name);
    expect(sched!.cron).toBe('0 9 * * 1');

    await adapter.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Stalled job event logging
// ---------------------------------------------------------------------------

describe('bullmq orchestration adapter – stalled job logging', () => {
  beforeEach(() => {
    resetFakeBullMQState();
  });

  test('stalled event on the task worker triggers console.error with the job ID', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'stalled-log',
    });
    const task = defineTask({
      name: 'stalled-task',
      input: z.object({ x: z.number() }),
      output: z.object({ x: z.number() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);

    // Trigger lazy start
    await adapter.start();

    const taskWorker = FakeWorker.instances.find(w => w.name === 'stalled-log_tasks');
    expect(taskWorker).toBeDefined();

    let consoleErrorSpy: ReturnType<typeof spyOn> | undefined;
    try {
      consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

      // Simulate BullMQ emitting a 'stalled' event
      taskWorker!.emit('stalled', 'job-42');

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('job-42'));
    } finally {
      consoleErrorSpy?.mockRestore();
    }

    await adapter.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown: pause + drain + force-close
// ---------------------------------------------------------------------------

describe('bullmq orchestration adapter – shutdown drain', () => {
  beforeEach(() => {
    resetFakeBullMQState();
  });

  test('shutdown pauses workers and waits for active jobs to drain to zero', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'drain-success',
      shutdownDrainTimeoutMs: 2_000,
    });
    const task = defineTask({
      name: 'drain-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);
    await adapter.start();

    const taskWorker = FakeWorker.instances.find(w => w.name === 'drain-success_tasks');
    expect(taskWorker).toBeDefined();
    // Simulate 2 jobs in flight, then 1, then 0
    taskWorker!.activeCounts = [2, 1, 0];

    await adapter.shutdown();

    expect(taskWorker!.pauseCalls).toBeGreaterThan(0);
    expect(taskWorker!.paused).toBe(true);
    expect(taskWorker!.closed).toBe(true);
    // Drained successfully → close should NOT be forced
    expect(taskWorker!.closedForce).toBe(false);
    expect(taskWorker!.activeCountCalls).toBeGreaterThanOrEqual(3);
  });

  test('shutdown force-closes workers when drain timeout elapses with active jobs', async () => {
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'drain-timeout',
      // Very short timeout so the polling loop bails immediately
      shutdownDrainTimeoutMs: 50,
    });
    const task = defineTask({
      name: 'drain-timeout-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);
    await adapter.start();

    const taskWorker = FakeWorker.instances.find(w => w.name === 'drain-timeout_tasks');
    expect(taskWorker).toBeDefined();
    // Always reports a non-zero active count → drain never reaches zero
    taskWorker!.activeCounts = [3];

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await adapter.shutdown();

      expect(taskWorker!.pauseCalls).toBeGreaterThan(0);
      expect(taskWorker!.closed).toBe(true);
      // Timed out → forced close
      expect(taskWorker!.closedForce).toBe(true);

      // Should have logged the drain-timeout warning. The structured logger
      // emits a JSON line per call; parse and match on msg + errorCode.
      const warnedDrainTimeout = consoleWarnSpy.mock.calls.some(call => {
        const line = call[0];
        if (typeof line !== 'string') return false;
        try {
          const record = JSON.parse(line) as { msg?: string; errorCode?: string };
          return (
            record.errorCode === 'WORKER_DRAIN_TIMEOUT' &&
            typeof record.msg === 'string' &&
            record.msg.includes('drain') &&
            record.msg.includes('timeout')
          );
        } catch {
          return false;
        }
      });
      expect(warnedDrainTimeout).toBe(true);
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// TLS enforcement
// ---------------------------------------------------------------------------

describe('bullmq orchestration adapter – requireTls', () => {
  beforeEach(() => {
    resetFakeBullMQState();
  });

  test('throws synchronously when requireTls=true and no TLS config provided', () => {
    expect(() =>
      createBullMQOrchestrationAdapter({
        connection: { host: '127.0.0.1', port: 6379 },
        prefix: 'require-tls-missing',
        requireTls: true,
      }),
    ).toThrow(/requireTls=true/);
  });

  test('throws when requireTls=true and tls is an empty object', () => {
    expect(() =>
      createBullMQOrchestrationAdapter({
        connection: { host: '127.0.0.1', port: 6379, tls: {} },
        prefix: 'require-tls-empty',
        requireTls: true,
      }),
    ).toThrow(/requireTls=true/);
  });

  test('does not throw when requireTls=true and structured tls options provided', () => {
    expect(() =>
      createBullMQOrchestrationAdapter({
        connection: {
          host: '127.0.0.1',
          port: 6379,
          tls: { rejectUnauthorized: true, ca: '<pem>' },
        },
        prefix: 'require-tls-ok',
        requireTls: true,
      }),
    ).not.toThrow();
  });

  test('does not throw when requireTls is omitted (default behavior)', () => {
    expect(() =>
      createBullMQOrchestrationAdapter({
        connection: { host: '127.0.0.1', port: 6379 },
        prefix: 'require-tls-default',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Job retention defaults flow through to queue construction
// ---------------------------------------------------------------------------

describe('bullmq orchestration adapter – job retention defaults', () => {
  beforeEach(() => {
    resetFakeBullMQState();
  });

  test('queues are constructed with sensible default removeOnComplete/removeOnFail', () => {
    createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'retention-default',
    });

    const taskQueue = FakeQueue.instances.find(q => q.name === 'retention-default_tasks');
    const workflowQueue = FakeQueue.instances.find(q => q.name === 'retention-default_workflows');
    expect(taskQueue?.options).toBeDefined();
    expect(workflowQueue?.options).toBeDefined();

    const defaultJobOptions = taskQueue!.options!['defaultJobOptions'] as {
      removeOnComplete: { age: number; count: number };
      removeOnFail: { age: number; count?: number };
    };
    expect(defaultJobOptions.removeOnComplete.age).toBe(3600);
    expect(defaultJobOptions.removeOnComplete.count).toBe(1000);
    expect(defaultJobOptions.removeOnFail.age).toBe(86400);
    expect(defaultJobOptions.removeOnFail.count).toBeUndefined();

    expect(
      (workflowQueue!.options!['defaultJobOptions'] as { removeOnComplete: { age: number } })
        .removeOnComplete.age,
    ).toBe(3600);
  });

  test('jobRetention overrides flow through to queue options', () => {
    createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix: 'retention-custom',
      jobRetention: {
        removeOnCompleteAge: 60,
        removeOnCompleteCount: 50,
        removeOnFailAge: 7 * 24 * 60 * 60,
        removeOnFailCount: 250,
      },
    });

    const taskQueue = FakeQueue.instances.find(q => q.name === 'retention-custom_tasks');
    expect(taskQueue?.options).toBeDefined();
    const defaultJobOptions = taskQueue!.options!['defaultJobOptions'] as {
      removeOnComplete: { age: number; count: number };
      removeOnFail: { age: number; count?: number };
    };
    expect(defaultJobOptions.removeOnComplete.age).toBe(60);
    expect(defaultJobOptions.removeOnComplete.count).toBe(50);
    expect(defaultJobOptions.removeOnFail.age).toBe(7 * 24 * 60 * 60);
    expect(defaultJobOptions.removeOnFail.count).toBe(250);
  });
});
