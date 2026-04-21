import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineTask, defineWorkflow, step } from '@lastshotlabs/slingshot-orchestration';
import {
  discoverOrchestrationDefinitions,
  selectOrchestrationDefinitions,
} from '../src/discovery';

describe('Temporal orchestration discovery', () => {
  test('discovers task/workflow exports and closes workflow task dependencies', () => {
    const resizeImage = defineTask({
      name: 'resize-image',
      input: z.object({ path: z.string() }),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    });
    const sendWelcome = defineTask({
      name: 'send-welcome',
      input: z.object({ email: z.string() }),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    });
    const onboardUser = defineWorkflow<{ email: string }, Record<string, unknown>>({
      name: 'onboard-user',
      input: z.object({ email: z.string() }),
      steps: [
        step('resize', resizeImage),
        step('welcome', sendWelcome, {
          input: ctx => ({ email: ctx.workflowInput.email }),
        }),
      ],
    });

    const discovered = discoverOrchestrationDefinitions({
      resizeImage,
      tasks: { sendWelcome },
      workflows: { onboardUser },
    });
    const selected = selectOrchestrationDefinitions(discovered, {
      workflowNames: ['onboard-user'],
    });

    expect(discovered.tasks.map(task => task.name).sort()).toEqual([
      'resize-image',
      'send-welcome',
    ]);
    expect(selected.workflows.map(workflow => workflow.name)).toEqual(['onboard-user']);
    expect(selected.tasks.map(task => task.name).sort()).toEqual(['resize-image', 'send-welcome']);
  });
});
