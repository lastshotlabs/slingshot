import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '@lastshotlabs/slingshot-orchestration';
import type {
  OrchestrationEventMap,
  OrchestrationEventSink,
} from '@lastshotlabs/slingshot-orchestration';
import { createBullMQTaskProcessor } from '../src/taskWorker';

function createFakeJob(data: Record<string, unknown>): Job<Record<string, unknown>> {
  const partial = {
    name: String(data['taskName'] ?? 'fake-task'),
    data,
    attemptsMade: 0,
    processedOn: Date.now() - 5,
    updateProgress: mock(async () => {}),
  } satisfies Partial<Job<Record<string, unknown>>>;

  return partial as unknown as Job<Record<string, unknown>>;
}

describe('bullmq task processor error handling', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('logs and does not crash when job.updateProgress rejects', async () => {
    const task = defineTask({
      name: 'progress-error-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input, ctx) {
        ctx.reportProgress({ percent: 50 });
        return input;
      },
    });

    const job = createFakeJob({
      taskName: task.name,
      input: { value: 'ok' },
      runId: 'run_prog_err',
    });
    job.updateProgress = mock(async () => {
      throw new Error('redis connection lost');
    });

    const processor = createBullMQTaskProcessor({
      taskRegistry: new Map([[task.name, task]]),
    });

    // Task should still complete successfully despite updateProgress throwing
    await expect(processor(job)).resolves.toEqual({ value: 'ok' });

    // Give the rejected promise a chance to settle and call .catch
    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[slingshot-orchestration-bullmq] Failed to update job progress:',
      expect.any(Error),
    );
  });
});

describe('bullmq task processor', () => {
  test('emits started, progress, and completed events', async () => {
    const task = defineTask({
      name: 'worker-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input, ctx) {
        ctx.reportProgress({ percent: 50 });
        return input;
      },
    });

    const events: Array<{
      name: keyof OrchestrationEventMap;
      payload: OrchestrationEventMap[keyof OrchestrationEventMap];
    }> = [];
    const eventSink: OrchestrationEventSink = {
      emit(name, payload) {
        events.push({ name, payload });
      },
    };

    const processor = createBullMQTaskProcessor({
      taskRegistry: new Map([[task.name, task]]),
      eventSink,
    });

    const result = await processor(
      createFakeJob({
        taskName: task.name,
        input: { value: 'ok' },
        runId: 'run_test',
        tenantId: 'tenant-bullmq',
      }),
    );

    expect(result).toEqual({ value: 'ok' });
    expect(events.map(event => event.name)).toEqual([
      'orchestration.task.started',
      'orchestration.task.progress',
      'orchestration.task.completed',
    ]);
  });

  test('emits failed events when task execution throws', async () => {
    const failingTask = defineTask({
      name: 'failing-worker-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler() {
        throw new Error('boom');
      },
    });

    const events: Array<{
      name: keyof OrchestrationEventMap;
      payload: OrchestrationEventMap[keyof OrchestrationEventMap];
    }> = [];
    const eventSink: OrchestrationEventSink = {
      emit(name, payload) {
        events.push({ name, payload });
      },
    };

    const processor = createBullMQTaskProcessor({
      taskRegistry: new Map([[failingTask.name, failingTask]]),
      eventSink,
    });

    await expect(
      processor(
        createFakeJob({
          taskName: failingTask.name,
          input: { value: 'nope' },
          runId: 'run_failed',
        }),
      ),
    ).rejects.toThrow('boom');

    expect(events.map(event => event.name)).toEqual([
      'orchestration.task.started',
      'orchestration.task.failed',
    ]);
  });

  test('uses taskRuntime timeout overrides carried on the BullMQ job payload', async () => {
    const task = defineTask({
      name: 'timeout-worker-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(_input, ctx) {
        await new Promise((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
        });
        return { value: 'never' };
      },
    });

    const events: Array<{
      name: keyof OrchestrationEventMap;
      payload: OrchestrationEventMap[keyof OrchestrationEventMap];
    }> = [];
    const eventSink: OrchestrationEventSink = {
      emit(name, payload) {
        events.push({ name, payload });
      },
    };

    const processor = createBullMQTaskProcessor({
      taskRegistry: new Map([[task.name, task]]),
      eventSink,
    });

    await expect(
      processor(
        createFakeJob({
          taskName: task.name,
          input: { value: 'slow' },
          runId: 'run_timeout',
          taskRuntime: {
            retry: { maxAttempts: 1, backoff: 'fixed', delayMs: 1 },
            timeout: 5,
          },
        }),
      ),
    ).rejects.toThrow('Task timed out');

    expect(events.map(event => event.name)).toEqual([
      'orchestration.task.started',
      'orchestration.task.failed',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Job data corruption handling
// ---------------------------------------------------------------------------

describe('bullmq task processor – job data corruption', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('missing taskName field throws a clear error (not undefined access)', async () => {
    const task = defineTask({
      name: 'corruption-test-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });

    const processor = createBullMQTaskProcessor({
      taskRegistry: new Map([[task.name, task]]),
    });

    // Job with no taskName field — only job.name is set (but it's the wrong task)
    const job = createFakeJob({ input: { value: 'ok' }, runId: 'run_corrupt_1' });

    await expect(processor(job)).rejects.toThrow(
      /BullMQ job .* has invalid data: missing 'taskName' field/,
    );

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("missing 'taskName' field"),
      expect.anything(),
    );
  });

  test('null input field causes graceful failure without cryptic type error', async () => {
    const task = defineTask({
      name: 'null-input-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });

    const processor = createBullMQTaskProcessor({
      taskRegistry: new Map([[task.name, task]]),
    });

    // Provide a valid taskName but null input — Zod parse will fail gracefully
    const job = createFakeJob({ taskName: task.name, input: null, runId: 'run_null_input' });

    // The processor should throw (Zod validation error), but not an unhandled
    // "Cannot read properties of null" TypeError.
    await expect(processor(job)).rejects.toThrow();
    // Crucially, it must NOT be an undefined-access TypeError
    let caught: unknown;
    try {
      await processor(job);
    } catch (err) {
      caught = err;
    }
    // Should be a ZodError (or similar validation error), not a raw TypeError from undefined access
    expect(
      caught instanceof TypeError && (caught as TypeError).message.includes('Cannot read'),
    ).toBe(false);
  });
});
