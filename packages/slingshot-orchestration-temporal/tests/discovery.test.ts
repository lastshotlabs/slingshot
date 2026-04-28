import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineTask, defineWorkflow, parallel, step } from '@lastshotlabs/slingshot-orchestration';
import { discoverOrchestrationDefinitions, selectOrchestrationDefinitions } from '../src/discovery';

describe('Temporal orchestration discovery', () => {
  function testTask(name: string) {
    return defineTask({
      name,
      input: z.object({ value: z.string() }).optional(),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    });
  }

  test('discovers task/workflow exports and closes workflow task dependencies', () => {
    const resizeImage = testTask('resize-image');
    const sendWelcome = testTask('send-welcome');
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

  test('selects explicit tasks when no workflows are requested', () => {
    const resizeImage = testTask('resize-image');
    const sendWelcome = testTask('send-welcome');
    const discovered = discoverOrchestrationDefinitions({
      tasks: { resizeImage, ignored: null },
      sendWelcome,
      workflows: null,
    });

    expect(
      selectOrchestrationDefinitions(discovered, { taskNames: ['send-welcome'] }).tasks.map(
        task => task.name,
      ),
    ).toEqual(['send-welcome']);
    expect(
      selectOrchestrationDefinitions(discovered, {})
        .tasks.map(task => task.name)
        .sort(),
    ).toEqual(['resize-image', 'send-welcome']);
  });

  test('closes dependencies from parallel workflow steps', () => {
    const resizeImage = testTask('resize-image');
    const sendWelcome = testTask('send-welcome');
    const onboardUser = defineWorkflow({
      name: 'parallel-onboard',
      input: z.object({ email: z.string() }),
      steps: [parallel([step('resize', resizeImage), step('welcome', sendWelcome)])],
    });

    const selected = selectOrchestrationDefinitions(
      { tasks: [resizeImage, sendWelcome], workflows: [onboardUser] },
      { workflowNames: ['parallel-onboard'] },
    );

    expect(selected.tasks.map(task => task.name).sort()).toEqual(['resize-image', 'send-welcome']);
  });

  test('rejects duplicate discovered task and workflow names', () => {
    const resizeImage = testTask('resize-image');
    const duplicateResizeImage = { ...resizeImage };
    const workflow = defineWorkflow({
      name: 'onboard-user',
      input: z.object({ email: z.string() }),
      steps: [step('resize', resizeImage)],
    });
    const duplicateWorkflow = { ...workflow };

    expect(() =>
      discoverOrchestrationDefinitions({ resizeImage, tasks: { duplicateResizeImage } }),
    ).toThrow("Duplicate discovered orchestration task 'resize-image'.");
    expect(() =>
      discoverOrchestrationDefinitions({ workflow, workflows: { duplicateWorkflow } }),
    ).toThrow("Duplicate discovered orchestration workflow 'onboard-user'.");
  });

  test('rejects missing requested definitions and workflow task dependencies', () => {
    const resizeImage = testTask('resize-image');
    const workflow = defineWorkflow({
      name: 'onboard-user',
      input: z.object({ email: z.string() }),
      steps: [step('missing-task', 'send-welcome')],
    });
    const discovered = { tasks: [resizeImage], workflows: [workflow] };

    expect(() =>
      selectOrchestrationDefinitions(discovered, { workflowNames: ['missing-flow'] }),
    ).toThrow("Workflow 'missing-flow' not found in definitions module.");
    expect(() =>
      selectOrchestrationDefinitions(discovered, { taskNames: ['missing-task'] }),
    ).toThrow("Workflow task dependency 'send-welcome' was not found in definitions module.");
    expect(() =>
      selectOrchestrationDefinitions(
        { tasks: [resizeImage], workflows: [] },
        {
          taskNames: ['missing-task'],
        },
      ),
    ).toThrow("Task 'missing-task' not found in definitions module.");
  });
});
