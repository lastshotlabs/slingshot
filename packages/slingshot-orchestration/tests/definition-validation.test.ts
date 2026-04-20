import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createMemoryAdapter } from '../src/adapters/memory';
import { defineTask } from '../src/defineTask';
import { defineWorkflow, sleep, step } from '../src/defineWorkflow';
import { createOrchestrationRuntime } from '../src/runtime';

describe('orchestration definition validation', () => {
  test('rejects invalid task concurrency and retry policy values', () => {
    expect(() =>
      defineTask({
        name: 'fractional-concurrency-task',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        concurrency: 1.5,
        async handler() {
          return { ok: true };
        },
      }),
    ).toThrow(`Task 'fractional-concurrency-task' concurrency must be a positive integer.`);

    expect(() =>
      defineTask({
        name: 'invalid-retry-task',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        retry: { maxAttempts: 0, delayMs: -1 },
        async handler() {
          return { ok: true };
        },
      }),
    ).toThrow(`Task 'invalid-retry-task' retry maxAttempts must be a positive integer.`);
  });

  test('rejects invalid step timeout and retry overrides', () => {
    const task = defineTask({
      name: 'step-validation-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    });

    expect(() => step('bad-timeout-step', task, { timeout: 0 })).toThrow(
      `Step 'bad-timeout-step' timeout must be a positive number.`,
    );
    expect(() => step('bad-retry-step', task, { retry: { maxAttempts: 0 } })).toThrow(
      `Step 'bad-retry-step' retry maxAttempts must be a positive integer.`,
    );
  });

  test('fails workflows when dynamic sleep durations resolve to invalid values', async () => {
    const workflow = defineWorkflow({
      name: 'invalid-dynamic-sleep-workflow',
      input: z.object({}),
      steps: [sleep('invalid-sleep-step', () => -1)],
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [],
      workflows: [workflow],
    });

    const handle = await runtime.runWorkflow(workflow, {});
    await expect(handle.result()).rejects.toThrow(
      `Sleep step 'invalid-sleep-step' duration must be a non-negative finite number.`,
    );
  });
});
