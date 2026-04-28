import { afterEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '@lastshotlabs/slingshot-orchestration';
import { defineWorkflow, parallel, sleep, step } from '@lastshotlabs/slingshot-orchestration';
import type { ProviderTaskManifest } from '@lastshotlabs/slingshot-orchestration/provider';
import type { ExecuteSlingshotTaskArgs } from '../src/activities';

interface WorkflowHarness {
  readonly activityOptions: unknown[];
  readonly taskCalls: ExecuteSlingshotTaskArgs[];
  readonly hookCalls: unknown[];
  readonly eventCalls: Array<{ name: string; payload: unknown }>;
  readonly sleeps: number[];
  readonly handlers: Map<string, (payload?: unknown) => unknown>;
  importWorkflows(): Promise<typeof import('../src/workflows')>;
}

afterEach(() => {
  mock.restore();
});

function createWorkflowHarness(
  taskActivity: (args: ExecuteSlingshotTaskArgs) => Promise<{ output: unknown; attempts: number }>,
): WorkflowHarness {
  const activityOptions: unknown[] = [];
  const taskCalls: ExecuteSlingshotTaskArgs[] = [];
  const hookCalls: unknown[] = [];
  const eventCalls: Array<{ name: string; payload: unknown }> = [];
  const sleeps: number[] = [];
  const handlers = new Map<string, (payload?: unknown) => unknown>();

  mock.module('@temporalio/workflow', () => ({
    defineQuery: (name: string) => name,
    defineSignal: (name: string) => name,
    setHandler: (name: string, handler: (payload?: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    workflowInfo: () => ({ workflowId: 'temporal-workflow-id' }),
    sleep: async (duration: number) => {
      sleeps.push(duration);
    },
    proxyActivities: (options: unknown) => {
      activityOptions.push(options);
      return {
        async executeSlingshotTask(args: ExecuteSlingshotTaskArgs) {
          taskCalls.push(args);
          return taskActivity(args);
        },
        async executeWorkflowHook(args: unknown) {
          hookCalls.push(args);
        },
        async emitOrchestrationEvent(args: { name: string; payload: unknown }) {
          eventCalls.push(args);
        },
      };
    },
  }));

  return {
    activityOptions,
    taskCalls,
    hookCalls,
    eventCalls,
    sleeps,
    handlers,
    importWorkflows() {
      return import(`../src/workflows.ts?mocked=${Date.now()}-${Math.random()}`);
    },
  };
}

function manifest(
  name: string,
  overrides: Partial<ProviderTaskManifest> = {},
): ProviderTaskManifest {
  return {
    name,
    retry: { maxAttempts: 3, backoff: 'exponential', delayMs: 10, maxDelayMs: 100 },
    timeout: 500,
    queue: undefined,
    concurrency: undefined,
    ...overrides,
  };
}

describe('Temporal workflow implementations with mocked Temporal activities', () => {
  test('task workflow executes the registered activity with workflow identity and progress state', async () => {
    const harness = createWorkflowHarness(async args => {
      harness.handlers.get('slingshot-progress')?.({
        data: { percent: 50, message: `running ${args.taskName}` },
      });
      return { output: { ok: true, input: args.input }, attempts: 2 };
    });
    const { slingshotTaskWorkflowImpl } = await harness.importWorkflows();

    const result = await slingshotTaskWorkflowImpl(
      { 'send-email': manifest('send-email', { queue: 'email-activities' }) },
      {
        taskName: 'send-email',
        input: { to: 'user@example.com' },
        runId: 'run-task-1',
        tenantId: 'tenant-a',
      },
    );

    expect(result).toEqual({
      output: { ok: true, input: { to: 'user@example.com' } },
      progress: { percent: 50, message: 'running send-email' },
    });
    expect(harness.taskCalls[0]).toMatchObject({
      taskName: 'send-email',
      runId: 'run-task-1',
      tenantId: 'tenant-a',
      parentWorkflowId: 'temporal-workflow-id',
    });
    expect(harness.activityOptions).toContainEqual(
      expect.objectContaining({ taskQueue: 'email-activities', startToCloseTimeout: 500 }),
    );
  });

  test('task workflow wraps activity failures as non-retryable application failures', async () => {
    const harness = createWorkflowHarness(async () => {
      throw new Error('smtp unavailable');
    });
    const { slingshotTaskWorkflowImpl } = await harness.importWorkflows();

    await expect(
      slingshotTaskWorkflowImpl(
        { 'send-email': manifest('send-email') },
        { taskName: 'send-email', input: {}, runId: 'run-task-2' },
      ),
    ).rejects.toThrow('Slingshot task workflow failed');
  });

  test('workflow implementation runs hooks, sleeps, skipped steps, failed optional steps, and completion events', async () => {
    const prepareTask = defineTask({
      name: 'prepare-order',
      input: z.object({ orderId: z.string() }),
      output: z.object({ prepared: z.boolean(), orderId: z.string() }),
      async handler(input) {
        return { prepared: true, orderId: input.orderId };
      },
    });
    const optionalTask = defineTask({
      name: 'optional-fraud-check',
      input: z.object({}),
      output: z.object({ skipped: z.boolean() }),
      async handler() {
        return { skipped: false };
      },
    });
    const failingTask = defineTask({
      name: 'optional-notify',
      input: z.object({}),
      output: z.object({ notified: z.boolean() }),
      async handler() {
        return { notified: true };
      },
    });
    const finishTask = defineTask({
      name: 'finish-order',
      input: z.object({ orderId: z.string() }),
      output: z.object({ done: z.boolean(), orderId: z.string() }),
      async handler(input) {
        return { done: true, orderId: input.orderId };
      },
    });

    const workflow = defineWorkflow({
      name: 'order-workflow',
      input: z.object({ orderId: z.string() }),
      output: z.object({
        finish: z.object({ done: z.boolean(), orderId: z.string() }),
        optionalNotify: z.undefined(),
      }),
      steps: [
        step('prepare-step', prepareTask),
        sleep('wait-step', ({ results }) => (results['prepare-step'] ? 5 : 1)),
        parallel([
          step('skip-fraud-step', optionalTask, { condition: () => false }),
          step('finish-step', finishTask),
        ]),
        step('optional-notify-step', failingTask, { continueOnFailure: true }),
      ],
      outputMapper(results) {
        return {
          finish: results['finish-step'] as { done: boolean; orderId: string },
          optionalNotify: results['optional-notify-step'] as undefined,
        };
      },
    });

    const harness = createWorkflowHarness(async args => {
      if (args.stepName === 'optional-notify-step') {
        throw new Error('notification endpoint down');
      }
      return {
        output:
          args.taskName === 'finish-order'
            ? { done: true, orderId: 'ord_123' }
            : { prepared: true, orderId: 'ord_123' },
        attempts: 1,
      };
    });
    const { slingshotWorkflowImpl } = await harness.importWorkflows();

    const result = await slingshotWorkflowImpl(
      {
        'order-workflow': {
          workflow,
          tasks: {
            'prepare-order': manifest('prepare-order'),
            'optional-fraud-check': manifest('optional-fraud-check'),
            'optional-notify': manifest('optional-notify'),
            'finish-order': manifest('finish-order'),
          },
          hooks: { onStart: true, onComplete: true, onFail: false },
        },
      },
      { workflowName: 'order-workflow', input: { orderId: 'ord_123' }, runId: 'run-wf-1' },
    );

    expect(result.output).toEqual({
      finish: { done: true, orderId: 'ord_123' },
      optionalNotify: undefined,
    });
    expect(harness.sleeps).toEqual([5]);
    expect(result.steps['wait-step']).toMatchObject({ status: 'completed', attempts: 1 });
    expect(result.steps['skip-fraud-step']).toMatchObject({ status: 'skipped', attempts: 0 });
    expect(result.steps['optional-notify-step']).toMatchObject({ status: 'failed', attempts: 3 });
    expect(result.steps['finish-step']).toMatchObject({ status: 'completed', attempts: 1 });
    expect(harness.hookCalls).toEqual([
      expect.objectContaining({ workflowName: 'order-workflow', hook: 'onStart' }),
      expect.objectContaining({ workflowName: 'order-workflow', hook: 'onComplete' }),
    ]);
    expect(harness.eventCalls.map(event => event.name)).toEqual(
      expect.arrayContaining([
        'orchestration.workflow.started',
        'orchestration.step.skipped',
        'orchestration.step.completed',
        'orchestration.step.failed',
        'orchestration.workflow.completed',
      ]),
    );
  });

  test('workflow implementation records fatal step failures and invokes onFail hook', async () => {
    const failTask = defineTask({
      name: 'fatal-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    });
    const workflow = defineWorkflow({
      name: 'fatal-workflow',
      input: z.object({}),
      steps: [step('fatal-step', failTask)],
    });
    const harness = createWorkflowHarness(async () => {
      throw new Error('fatal failure');
    });
    const { slingshotWorkflowImpl } = await harness.importWorkflows();

    await expect(
      slingshotWorkflowImpl(
        {
          'fatal-workflow': {
            workflow,
            tasks: { 'fatal-task': manifest('fatal-task', { retry: { maxAttempts: 2 } as never }) },
            hooks: { onStart: false, onComplete: false, onFail: true },
          },
        },
        { workflowName: 'fatal-workflow', input: {}, runId: 'run-wf-2' },
      ),
    ).rejects.toThrow('Slingshot workflow failed');
    expect(harness.hookCalls).toEqual([
      expect.objectContaining({ workflowName: 'fatal-workflow', hook: 'onFail' }),
    ]);
    expect(harness.eventCalls.map(event => event.name)).toContain('orchestration.workflow.failed');
  });
});
