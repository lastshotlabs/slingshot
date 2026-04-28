import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '@lastshotlabs/slingshot-orchestration';
import {
  bullmqBackoffStrategy,
  computeRetryDelay,
  createJobRetryOptions,
  readTaskRuntimeConfig,
  resolveTaskRuntimeConfig,
} from '../src/taskRuntime';

describe('BullMQ task runtime helpers', () => {
  test('reads only valid task runtime overrides from job data', () => {
    expect(readTaskRuntimeConfig({})).toBeUndefined();
    expect(readTaskRuntimeConfig({ taskRuntime: null })).toBeUndefined();
    expect(readTaskRuntimeConfig({ taskRuntime: { retry: { backoff: 'fixed' } } })).toBeUndefined();

    expect(
      readTaskRuntimeConfig({
        taskRuntime: {
          retry: { maxAttempts: 3, backoff: 'exponential', delayMs: 25, maxDelayMs: 100 },
          timeout: 500,
        },
      }),
    ).toEqual({
      retry: { maxAttempts: 3, backoff: 'exponential', delayMs: 25, maxDelayMs: 100 },
      timeout: 500,
    });
  });

  test('merges runtime overrides onto task defaults', () => {
    const task = defineTask({
      name: 'retryable-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      retry: { maxAttempts: 2, backoff: 'fixed', delayMs: 10, maxDelayMs: 100 },
      timeout: 1_000,
      async handler() {
        return { ok: true };
      },
    });

    expect(
      resolveTaskRuntimeConfig(task, {
        retry: { maxAttempts: 4, backoff: 'exponential' },
      }),
    ).toEqual({
      retry: {
        maxAttempts: 4,
        backoff: 'exponential',
        delayMs: 10,
        maxDelayMs: 100,
      },
      timeout: 1_000,
    });
  });

  test('computes fixed and capped exponential retry delays', () => {
    expect(computeRetryDelay({ maxAttempts: 2 }, 1)).toBe(1_000);
    expect(computeRetryDelay({ maxAttempts: 2, backoff: 'fixed', delayMs: 50 }, 3)).toBe(50);
    expect(
      computeRetryDelay(
        { maxAttempts: 5, backoff: 'exponential', delayMs: 100, maxDelayMs: 250 },
        4,
      ),
    ).toBe(250);
  });

  test('creates BullMQ retry options only when retries are enabled', () => {
    expect(createJobRetryOptions({ retry: { maxAttempts: 1 } })).toEqual({
      attempts: 1,
      backoff: undefined,
    });
    expect(createJobRetryOptions({ retry: { maxAttempts: 3, delayMs: 75 } })).toEqual({
      attempts: 3,
      backoff: { type: 'slingshot', delay: 75 },
    });
  });

  test('BullMQ backoff strategy reads serialized task runtime from the job payload', () => {
    expect(bullmqBackoffStrategy(1, 'slingshot', new Error('missing'), undefined)).toBe(0);
    expect(
      bullmqBackoffStrategy(2, 'slingshot', new Error('retry'), {
        attemptsMade: 3,
        data: {
          taskRuntime: {
            retry: { maxAttempts: 4, backoff: 'exponential', delayMs: 10, maxDelayMs: 50 },
          },
        },
      } as never),
    ).toBe(40);
  });
});
