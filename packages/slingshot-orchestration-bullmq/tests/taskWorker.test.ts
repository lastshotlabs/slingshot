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
