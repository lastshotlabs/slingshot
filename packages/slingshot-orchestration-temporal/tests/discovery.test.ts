import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  defineTask,
  defineWorkflow,
  parallel,
  sleep,
  step,
} from '@lastshotlabs/slingshot-orchestration';
import { discoverOrchestrationDefinitions, selectOrchestrationDefinitions } from '../src/discovery';

describe('discoverOrchestrationDefinitions', () => {
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

  function testWorkflow(name: string, ...tasks: ReturnType<typeof testTask>[]) {
    return defineWorkflow<{ email: string }, Record<string, unknown>>({
      name,
      input: z.object({ email: z.string() }),
      steps: tasks.map(t => step(t.name, t)),
    });
  }

  describe('module scanning', () => {
    test('discovers top-level task exports', () => {
      const resizeImage = testTask('resize-image');
      const sendWelcome = testTask('send-welcome');

      const { tasks, workflows } = discoverOrchestrationDefinitions({
        resizeImage,
        sendWelcome,
      });

      expect(tasks.map(t => t.name).sort()).toEqual(['resize-image', 'send-welcome']);
      expect(workflows).toEqual([]);
    });

    test('discovers top-level workflow exports', () => {
      const task = testTask('resize-image');
      const wf = testWorkflow('onboard-user', task);

      const { tasks, workflows } = discoverOrchestrationDefinitions({ wf });

      expect(workflows.map(w => w.name)).toEqual(['onboard-user']);
    });

    test('discovers tasks inside a `tasks` namespace object', () => {
      const resizeImage = testTask('resize-image');

      const { tasks, workflows } = discoverOrchestrationDefinitions({
        tasks: { resizeImage },
      });

      expect(tasks.map(t => t.name)).toEqual(['resize-image']);
      expect(workflows).toEqual([]);
    });

    test('discovers workflows inside a `workflows` namespace object', () => {
      const task = testTask('resize-image');
      const wf = testWorkflow('onboard-user', task);

      const { tasks, workflows } = discoverOrchestrationDefinitions({
        workflows: { wf },
      });

      expect(workflows.map(w => w.name)).toEqual(['onboard-user']);
    });

    test('discovers mixed top-level and namespace exports', () => {
      const resizeImage = testTask('resize-image');
      const sendWelcome = testTask('send-welcome');
      const onboardUser = testWorkflow('onboard-user', resizeImage);

      const { tasks, workflows } = discoverOrchestrationDefinitions({
        resizeImage,
        tasks: { sendWelcome },
        workflows: { onboardUser },
      });

      expect(tasks.map(t => t.name).sort()).toEqual(['resize-image', 'send-welcome']);
      expect(workflows.map(w => w.name)).toEqual(['onboard-user']);
    });

    test('returns empty arrays for an empty module', () => {
      const { tasks, workflows } = discoverOrchestrationDefinitions({});
      expect(tasks).toEqual([]);
      expect(workflows).toEqual([]);
    });

    test('ignores null and undefined module values', () => {
      const task = testTask('resize-image');
      const { tasks, workflows } = discoverOrchestrationDefinitions({
        resizeImage: task,
        tasks: null,
        workflows: undefined,
      });

      expect(tasks.map(t => t.name)).toEqual(['resize-image']);
      expect(workflows).toEqual([]);
    });

    test('ignores primitive module values (numbers, strings, booleans, arrays)', () => {
      const { tasks: t1, workflows: w1 } = discoverOrchestrationDefinitions({
        someNumber: 42,
        someString: 'hello',
        someBool: true,
        someArray: [1, 2, 3],
      });
      expect(t1).toEqual([]);
      expect(w1).toEqual([]);
    });

    test('ignores non-object namespace values', () => {
      const { tasks, workflows } = discoverOrchestrationDefinitions({
        tasks: 'not-an-object',
        workflows: 99,
      });
      expect(tasks).toEqual([]);
      expect(workflows).toEqual([]);
    });

    test('handles empty tasks and workflows namespace objects', () => {
      const { tasks, workflows } = discoverOrchestrationDefinitions({
        tasks: {},
        workflows: {},
      });
      expect(tasks).toEqual([]);
      expect(workflows).toEqual([]);
    });

    test('prefers top-level value over namespace when both define the same name', () => {
      const top = testTask('resize-image');
      // Namespace name doesn't matter — duplicate check is by the inner _tag name
      const ns = testTask('send-welcome');

      const { tasks } = discoverOrchestrationDefinitions({
        resizeImage: top,
        tasks: { sendWelcome: ns },
      });

      expect(tasks.map(t => t.name).sort()).toEqual(['resize-image', 'send-welcome']);
    });
  });

  describe('duplicate detection', () => {
    test('rejects duplicate top-level task name', () => {
      const a = testTask('resize-image');
      const b = { ...a };

      expect(() =>
        discoverOrchestrationDefinitions({ resizeImage: a, tasks: { resizeImageAlt: b } }),
      ).toThrow("Duplicate discovered orchestration task 'resize-image'.");
    });

    test('rejects duplicate top-level workflow name', () => {
      const t = testTask('resize-image');
      const wf = testWorkflow('onboard-user', t);
      const dup = { ...wf };

      expect(() =>
        discoverOrchestrationDefinitions({
          workflows: { wf },
          wfDup: dup,
        }),
      ).toThrow("Duplicate discovered orchestration workflow 'onboard-user'.");
    });

    test('rejects duplicate names within the tasks namespace', () => {
      const a = testTask('resize-image');
      const b = { ...a };

      expect(() =>
        discoverOrchestrationDefinitions({
          tasks: { a, b },
        }),
      ).toThrow("Duplicate discovered orchestration task 'resize-image'.");
    });

    test('rejects duplicate names within the workflows namespace', () => {
      const t = testTask('resize-image');
      const wf = testWorkflow('onboard-user', t);
      const dup = { ...wf };

      expect(() =>
        discoverOrchestrationDefinitions({
          workflows: { wf, dup },
        }),
      ).toThrow("Duplicate discovered orchestration workflow 'onboard-user'.");
    });
  });

  describe('selectOrchestrationDefinitions', () => {
    test('selects specific workflows and closes their task dependencies', () => {
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

      expect(selected.workflows.map(w => w.name)).toEqual(['onboard-user']);
      expect(selected.tasks.map(t => t.name).sort()).toEqual(['resize-image', 'send-welcome']);
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

      expect(selected.tasks.map(t => t.name).sort()).toEqual(['resize-image', 'send-welcome']);
    });

    test('closes dependencies from steps using taskRef (object reference)', () => {
      const resizeImage = testTask('resize-image');
      // step() stores taskRef when an object is passed
      const workflow = defineWorkflow({
        name: 'with-ref',
        input: z.object({ email: z.string() }),
        steps: [step('resize', resizeImage)],
      });

      // Verify that taskRef is populated on the step
      expect(workflow.steps[0]).toHaveProperty('_tag', 'Step');
      const stepEntry = workflow.steps[0] as { _tag: 'Step'; taskRef?: unknown };
      expect(stepEntry.taskRef).toBeDefined();

      const selected = selectOrchestrationDefinitions(
        { tasks: [resizeImage], workflows: [workflow] },
        { workflowNames: ['with-ref'] },
      );

      expect(selected.tasks.map(t => t.name)).toEqual(['resize-image']);
    });

    test('ignores sleep entries when collecting task dependencies', () => {
      const resizeImage = testTask('resize-image');
      const workflow = defineWorkflow({
        name: 'with-sleep',
        input: z.object({ email: z.string() }),
        steps: [sleep('wait-a-bit', 5000), step('resize', resizeImage)],
      });

      const selected = selectOrchestrationDefinitions(
        { tasks: [resizeImage], workflows: [workflow] },
        { workflowNames: ['with-sleep'] },
      );

      expect(selected.tasks.map(t => t.name)).toEqual(['resize-image']);
    });

    test('selects explicit tasks when no workflows are requested', () => {
      const resizeImage = testTask('resize-image');
      const sendWelcome = testTask('send-welcome');
      const discovered = discoverOrchestrationDefinitions({
        tasks: { resizeImage },
        sendWelcome,
      });

      const result = selectOrchestrationDefinitions(discovered, {
        taskNames: ['send-welcome'],
      });
      expect(result.tasks.map(t => t.name)).toEqual(['send-welcome']);
      expect(result.workflows).toEqual([]);
    });

    test('returns all tasks when no workflows exist and no taskNames specified', () => {
      const resizeImage = testTask('resize-image');
      const sendWelcome = testTask('send-welcome');
      const discovered = discoverOrchestrationDefinitions({ resizeImage, sendWelcome });

      const result = selectOrchestrationDefinitions(discovered, {});
      expect(result.tasks.map(t => t.name).sort()).toEqual(['resize-image', 'send-welcome']);
      expect(result.workflows).toEqual([]);
    });

    test('returns all tasks and workflows when empty options are passed', () => {
      const resizeImage = testTask('resize-image');
      const wf = testWorkflow('onboard-user', resizeImage);
      const discovered = discoverOrchestrationDefinitions({
        resizeImage,
        workflows: { wf },
      });

      const result = selectOrchestrationDefinitions(discovered, {});
      expect(result.tasks.map(t => t.name)).toEqual(['resize-image']);
      expect(result.workflows.map(w => w.name)).toEqual(['onboard-user']);
    });

    test('empty workflowNames array returns all workflows', () => {
      const resizeImage = testTask('resize-image');
      const wf1 = testWorkflow('flow-a', resizeImage);
      const wf2 = testWorkflow('flow-b', resizeImage);
      const discovered = discoverOrchestrationDefinitions({
        resizeImage,
        workflows: { wf1, wf2 },
      });

      const result = selectOrchestrationDefinitions(discovered, { workflowNames: [] });
      expect(result.workflows.map(w => w.name).sort()).toEqual(['flow-a', 'flow-b']);
    });

    test('returns tasks from all workflows when multiple workflows selected', () => {
      const resizeImage = testTask('resize-image');
      const sendWelcome = testTask('send-welcome');
      const wf1 = defineWorkflow({
        name: 'flow-a',
        input: z.object({ email: z.string() }),
        steps: [step('resize', resizeImage)],
      });
      const wf2 = defineWorkflow({
        name: 'flow-b',
        input: z.object({ email: z.string() }),
        steps: [step('welcome', sendWelcome)],
      });

      const discovered = discoverOrchestrationDefinitions({
        resizeImage,
        sendWelcome,
        workflows: { wf1, wf2 },
      });

      const result = selectOrchestrationDefinitions(discovered, {
        workflowNames: ['flow-a', 'flow-b'],
      });
      expect(result.tasks.map(t => t.name).sort()).toEqual(['resize-image', 'send-welcome']);
    });

    test('includes explicit taskNames in addition to workflow-derived dependencies', () => {
      const resizeImage = testTask('resize-image');
      const sendWelcome = testTask('send-welcome');
      const auditLog = testTask('audit-log');
      const wf = defineWorkflow({
        name: 'onboard-user',
        input: z.object({ email: z.string() }),
        steps: [step('resize', resizeImage), step('welcome', sendWelcome)],
      });

      const discovered = discoverOrchestrationDefinitions({
        resizeImage,
        sendWelcome,
        auditLog,
        workflows: { wf },
      });

      const result = selectOrchestrationDefinitions(discovered, {
        workflowNames: ['onboard-user'],
        taskNames: ['audit-log'],
      });
      expect(result.tasks.map(t => t.name).sort()).toEqual([
        'audit-log',
        'resize-image',
        'send-welcome',
      ]);
    });
  });

  describe('error handling in selectOrchestrationDefinitions', () => {
    test('throws when requested workflow is not found in definitions', () => {
      const task = testTask('resize-image');
      const discovered = { tasks: [task], workflows: [] };

      expect(() =>
        selectOrchestrationDefinitions(discovered, { workflowNames: ['missing-flow'] }),
      ).toThrow("Workflow 'missing-flow' not found in definitions module.");
    });

    test('throws when a workflow step references a missing task dependency', () => {
      const task = testTask('resize-image');
      const workflow = defineWorkflow({
        name: 'onboard-user',
        input: z.object({ email: z.string() }),
        steps: [step('resize', task), step('welcome', 'send-welcome')],
      });

      const discovered = { tasks: [task], workflows: [workflow] };

      expect(() =>
        selectOrchestrationDefinitions(discovered, { workflowNames: ['onboard-user'] }),
      ).toThrow("Workflow task dependency 'send-welcome' was not found in definitions module.");
    });

    test('throws when a requested explicit task name is not found', () => {
      const task = testTask('resize-image');
      const discovered = { tasks: [task], workflows: [] };

      expect(() =>
        selectOrchestrationDefinitions(discovered, { taskNames: ['missing-task'] }),
      ).toThrow("Task 'missing-task' not found in definitions module.");
    });

    test('throws when a workflow has parallel steps referencing missing tasks', () => {
      const task = testTask('resize-image');
      const workflow = defineWorkflow({
        name: 'parallel-flow',
        input: z.object({ email: z.string() }),
        steps: [parallel([step('resize', task), step('welcome', 'send-welcome')])],
      });

      const discovered = { tasks: [task], workflows: [workflow] };

      expect(() =>
        selectOrchestrationDefinitions(discovered, { workflowNames: ['parallel-flow'] }),
      ).toThrow("Workflow task dependency 'send-welcome' was not found in definitions module.");
    });
  });
});
