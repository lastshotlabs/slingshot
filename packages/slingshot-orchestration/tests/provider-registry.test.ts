import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '../src/defineTask';
import { defineWorkflow, parallel, sleep, step } from '../src/defineWorkflow';
import { createOrchestrationProviderRegistry } from '../src/provider';

describe('orchestration provider registry', () => {
  test('builds workflow manifests without taskRef and preserves task defaults', () => {
    const resizeImage = defineTask({
      name: 'resize-image',
      input: z.object({ path: z.string() }),
      output: z.object({ ok: z.boolean() }),
      retry: { maxAttempts: 5, backoff: 'exponential', delayMs: 50, maxDelayMs: 2000 },
      timeout: 1_000,
      queue: 'media',
      concurrency: 3,
      async handler() {
        return { ok: true };
      },
    });

    const sendEmail = defineTask({
      name: 'send-email',
      input: z.object({ to: z.string() }),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    });

    const workflow = defineWorkflow<{ email: string; avatar: string }, Record<string, unknown>>({
      name: 'onboard-user',
      input: z.object({ email: z.string(), avatar: z.string() }),
      steps: [
        step('resize', resizeImage, {
          input: ctx => ({ path: ctx.workflowInput.avatar }),
          timeout: 400,
        }),
        parallel([
          step('welcome', sendEmail, {
            input: ctx => ({ to: ctx.workflowInput.email }),
          }),
        ]),
        sleep('cooldown', 10),
      ],
      onStart() {},
      onComplete() {},
    });

    const registry = createOrchestrationProviderRegistry({
      tasks: [resizeImage, sendEmail],
      workflows: [workflow],
    });

    const manifest = registry.getWorkflowManifest('onboard-user');
    expect(manifest.tasks['resize-image']).toEqual({
      name: 'resize-image',
      retry: { maxAttempts: 5, backoff: 'exponential', delayMs: 50, maxDelayMs: 2000 },
      timeout: 1_000,
      queue: 'media',
      concurrency: 3,
    });
    expect(manifest.steps[0]).toEqual(
      expect.objectContaining({
        _tag: 'Step',
        name: 'resize',
        task: 'resize-image',
      }),
    );
    expect('taskRef' in manifest.steps[0]).toBe(false);
    expect(manifest.hooks).toEqual({
      onStart: true,
      onComplete: true,
      onFail: false,
    });
  });

  test('fails fast on duplicate names', () => {
    const task = defineTask({
      name: 'duplicate-task',
      input: z.object({}),
      output: z.object({}),
      async handler() {
        return {};
      },
    });

    expect(() =>
      createOrchestrationProviderRegistry({
        tasks: [task, task],
        workflows: [],
      }),
    ).toThrow("Duplicate orchestration task 'duplicate-task'");
  });
});
