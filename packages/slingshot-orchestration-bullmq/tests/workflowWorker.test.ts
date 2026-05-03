import { describe, expect, spyOn, test } from 'bun:test';
import { z } from 'zod';
import {
  defineTask,
  defineWorkflow,
  parallel,
  sleep,
  step,
} from '@lastshotlabs/slingshot-orchestration';
import type {
  OrchestrationEventMap,
  OrchestrationEventSink,
} from '@lastshotlabs/slingshot-orchestration';
import { createBullMQWorkflowProcessor } from '../src/workflowWorker';

/**
 * Assert a console.error spy received a structured-logger line whose decoded
 * `msg` matches the given substring.
 */
function expectStructuredErrorLogged(
  spy: { mock: { calls: unknown[][] } },
  msgIncludes: string,
  fields?: Record<string, unknown>,
): void {
  const lines = spy.mock.calls
    .map(args => (typeof args[0] === 'string' ? args[0] : ''))
    .filter(Boolean);
  const matched = lines.some(line => {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const msg = String(record['msg'] ?? '');
      if (!msg.includes(msgIncludes)) return false;
      if (fields) {
        for (const [k, v] of Object.entries(fields)) {
          if (record[k] !== v) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  });
  expect(matched).toBe(true);
}

class FakeTaskJob {
  constructor(
    public id: string,
    private readonly result: unknown,
    private readonly shouldFail = false,
  ) {}

  async waitUntilFinished(_queueEvents: unknown) {
    if (this.shouldFail) {
      throw this.result instanceof Error ? this.result : new Error(String(this.result));
    }
    return this.result;
  }
}

type QueueEntry = { type: 'success'; value: unknown } | { type: 'failure'; error: Error };

class FakeQueue {
  addCalls: Array<{ name: string; data: Record<string, unknown>; opts?: Record<string, unknown> }> =
    [];
  entries: QueueEntry[] = [];

  /** Queue a successful result for the next add() call. */
  pushSuccess(value: unknown) {
    this.entries.push({ type: 'success', value });
  }

  /** Queue a failure for the next add() call. */
  pushFailure(error: Error) {
    this.entries.push({ type: 'failure', error });
  }

  // Legacy support: allow callers to set results[] directly (existing tests)
  results: unknown[] = [];

  async add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) {
    this.addCalls.push({ name, data, opts });
    const entry = this.entries.shift();
    if (entry) {
      const id = String(data['runId'] ?? `${name}-${this.addCalls.length}`);
      return new FakeTaskJob(
        id,
        entry.type === 'success' ? entry.value : entry.error,
        entry.type === 'failure',
      );
    }
    // legacy fallback
    const result = this.results.shift() ?? data['input'];
    return new FakeTaskJob(String(data['runId'] ?? `${name}-${this.addCalls.length}`), result);
  }
}

function createEventCollector() {
  const events: Array<{
    name: keyof OrchestrationEventMap;
    payload: OrchestrationEventMap[keyof OrchestrationEventMap];
  }> = [];

  const eventSink: OrchestrationEventSink = {
    emit(name, payload) {
      events.push({ name, payload });
    },
  };

  return { eventSink, events };
}

describe('bullmq workflow processor', () => {
  test('rejects jobs with missing workflowName without logging job data', async () => {
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map(),
      taskRegistry: new Map(),
      getTaskQueue() {
        return new FakeQueue() as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
    });

    try {
      await expect(
        processor({
          id: 'workflow-corrupt-1',
          name: 'unknown',
          data: { input: { email: 'secret@example.com' }, runId: 'workflow-corrupt-1' },
          opts: {},
          async updateData() {},
        } as never),
      ).rejects.toThrow(/missing 'workflowName' field/);

      expectStructuredErrorLogged(consoleErrorSpy, 'workflowName', {
        runId: 'workflow-corrupt-1',
        errorCode: 'WORKFLOW_DATA_MISSING_WORKFLOW_NAME',
      });
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  test('rejects jobs for workflows that are not registered', async () => {
    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map(),
      taskRegistry: new Map(),
      getTaskQueue() {
        return new FakeQueue() as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
    });

    await expect(processor(makeWorkflowJob('missing-workflow', {}) as never)).rejects.toMatchObject(
      {
        code: 'WORKFLOW_NOT_FOUND',
        message: "Workflow 'missing-workflow' not registered",
      },
    );
  });

  test('runs sleep steps, applies outputMapper, and forwards priority plus adapter hints', async () => {
    const { eventSink, events } = createEventCollector();
    const queue = new FakeQueue();
    queue.pushSuccess({ sleptMs: 25 });
    queue.pushSuccess({ done: true });

    const finishTask = defineTask({
      name: 'finish-after-sleep-task',
      input: z.object({ sleptMs: z.number() }),
      output: z.object({ done: z.boolean() }),
      async handler() {
        return { done: true };
      },
    });
    const workflow = defineWorkflow({
      name: 'sleep-then-finish-workflow',
      input: z.object({}),
      output: z.object({ finished: z.boolean(), sleptMs: z.number() }),
      steps: [
        sleep('wait-step', () => 25),
        step('finish-step', finishTask, {
          input: ctx => ctx.results['wait-step'],
          timeout: 5_000,
          retry: { maxAttempts: 3, backoff: 'fixed', delayMs: 10 },
        }),
      ],
      outputMapper(results) {
        return {
          finished: Boolean((results['finish-step'] as { done?: boolean }).done),
          sleptMs: (results['wait-step'] as { sleptMs: number }).sleptMs,
        };
      },
    });
    const job = makeWorkflowJob(workflow.name, {}, 'workflow-sleep-1');
    job.opts.priority = 7;
    job.data['tenantId'] = 'tenant-a';
    job.data['adapterHints'] = { removeOnComplete: 12 };

    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map([[finishTask.name, finishTask]]),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
      eventSink,
    });

    await expect(processor(job as never)).resolves.toEqual({ finished: true, sleptMs: 25 });
    expect(queue.addCalls[0]).toMatchObject({
      name: '__slingshot_sleep',
      data: { runId: 'workflow-sleep-1', durationMs: 25 },
      opts: { jobId: 'workflow-sleep-1:sleep:wait-step', delay: 25 },
    });
    expect(queue.addCalls[1]?.opts).toMatchObject({
      priority: 7,
      attempts: 3,
      backoff: { type: 'slingshot', delay: 10 },
      removeOnComplete: 12,
    });
    expect(events.map(event => event.name)).toContain('orchestration.workflow.completed');
    expect(job.data['_childJobIds']).toHaveLength(2);
  });

  test('logs onStart hook failures when no event sink is configured and continues', async () => {
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const queue = new FakeQueue();
    queue.pushSuccess({ delivered: true });
    const task = defineTask({
      name: 'onstart-task',
      input: z.object({}),
      output: z.object({ delivered: z.boolean() }),
      async handler() {
        return { delivered: true };
      },
    });
    const workflow = defineWorkflow({
      name: 'onstart-hook-workflow',
      input: z.object({}),
      steps: [step('deliver-step', task)],
      onStart() {
        throw new Error('onStart failed');
      },
    });
    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map([[task.name, task]]),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
    });

    try {
      await expect(processor(makeWorkflowJob(workflow.name, {}) as never)).resolves.toEqual({
        'deliver-step': { delivered: true },
      });
      expectStructuredErrorLogged(consoleErrorSpy, 'onStart hook');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  test('emits hookError after workflow.completed when onComplete throws', async () => {
    const { eventSink, events } = createEventCollector();
    const queue = new FakeQueue();
    queue.results.push({ delivered: true });

    const task = defineTask({
      name: 'deliver-email-task',
      input: z.object({ email: z.string() }),
      output: z.object({ delivered: z.boolean() }),
      async handler(input) {
        return { delivered: Boolean(input.email) };
      },
    });
    const workflow = defineWorkflow({
      name: 'deliver-email-workflow',
      input: z.object({ email: z.string() }),
      output: z.object({
        'deliver-email-step': z.object({ delivered: z.boolean() }),
      }),
      steps: [step('deliver-email-step', task)],
      onComplete() {
        throw new Error('hook exploded');
      },
    });

    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map([[task.name, task]]),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
      eventSink,
    });

    const job: {
      id: string;
      name: string;
      data: Record<string, unknown>;
      opts: Record<string, unknown>;
      updateData(nextData: Record<string, unknown>): Promise<void>;
    } = {
      id: 'workflow-run-1',
      name: workflow.name,
      data: {
        workflowName: workflow.name,
        runId: 'workflow-run-1',
        input: { email: 'user@example.com' },
      },
      opts: {},
      async updateData(nextData: Record<string, unknown>) {
        this.data = nextData;
      },
    };

    await expect(processor(job as never)).resolves.toEqual({
      'deliver-email-step': { delivered: true },
    });
    expect(events.map(event => event.name)).toEqual([
      'orchestration.workflow.started',
      'orchestration.step.completed',
      'orchestration.workflow.completed',
      'orchestration.workflow.hookError',
    ]);
    expect(events[3]?.payload).toMatchObject({
      runId: 'workflow-run-1',
      workflow: workflow.name,
      hook: 'onComplete',
      error: { message: 'hook exploded' },
    });
  });

  test('string hook failures are converted to portable run errors', async () => {
    const { eventSink, events } = createEventCollector();
    const queue = new FakeQueue();
    queue.pushSuccess({ ok: true });
    const task = defineTask({
      name: 'string-hook-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    });
    const workflow = defineWorkflow({
      name: 'string-hook-workflow',
      input: z.object({}),
      steps: [step('ok-step', task)],
      onComplete() {
        throw 'string hook failed';
      },
    });
    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map([[task.name, task]]),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
      eventSink,
    });

    await expect(processor(makeWorkflowJob(workflow.name, {}) as never)).resolves.toEqual({
      'ok-step': { ok: true },
    });
    expect(events.at(-1)).toEqual({
      name: 'orchestration.workflow.hookError',
      payload: expect.objectContaining({
        workflow: workflow.name,
        hook: 'onComplete',
        error: { message: 'string hook failed' },
      }),
    });
  });

  test('rejects invalid dynamic sleep durations before scheduling a sleep job', async () => {
    const queue = new FakeQueue();
    const workflow = defineWorkflow({
      name: 'invalid-sleep-bullmq-workflow',
      input: z.object({}),
      steps: [sleep('wait-step', () => Number.NaN)],
    });

    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map(),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
    });

    const job: {
      id: string;
      name: string;
      data: Record<string, unknown>;
      opts: Record<string, unknown>;
      updateData(nextData: Record<string, unknown>): Promise<void>;
    } = {
      id: 'workflow-run-2',
      name: workflow.name,
      data: {
        workflowName: workflow.name,
        runId: 'workflow-run-2',
        input: {},
      },
      opts: {},
      async updateData(nextData: Record<string, unknown>) {
        this.data = nextData;
      },
    };

    await expect(processor(job as never)).rejects.toThrow(
      `Sleep step 'wait-step' duration must be a non-negative finite number.`,
    );
    expect(queue.addCalls).toHaveLength(0);
  });

  test('continues after sequential step failure when continueOnFailure is true', async () => {
    const { eventSink, events } = createEventCollector();
    const queue = new FakeQueue();
    queue.pushFailure(new Error('optional failed'));
    queue.pushSuccess({ ok: true });
    const optionalTask = defineTask({
      name: 'optional-sequential-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: false };
      },
    });
    const finalTask = defineTask({
      name: 'final-sequential-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    });
    const workflow = defineWorkflow({
      name: 'sequential-continue-workflow',
      input: z.object({}),
      steps: [
        step('optional-step', optionalTask, { continueOnFailure: true }),
        step('final-step', finalTask),
      ],
    });
    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map([
        [optionalTask.name, optionalTask],
        [finalTask.name, finalTask],
      ]),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
      eventSink,
    });

    const result = (await processor(makeWorkflowJob(workflow.name, {}) as never)) as Record<
      string,
      unknown
    >;

    expect(result['optional-step']).toBeUndefined();
    expect(result['final-step']).toEqual({ ok: true });
    expect(events.map(event => event.name)).toEqual([
      'orchestration.workflow.started',
      'orchestration.step.failed',
      'orchestration.step.completed',
      'orchestration.workflow.completed',
    ]);
  });

  test('reports failed sequential steps and logs onFail hook failures without an event sink', async () => {
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const queue = new FakeQueue();
    queue.pushFailure(new Error('hard sequential failure'));
    const task = defineTask({
      name: 'hard-sequential-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: false };
      },
    });
    const workflow = defineWorkflow({
      name: 'sequential-fail-workflow',
      input: z.object({}),
      steps: [step('hard-step', task)],
      onFail(ctx) {
        expect(ctx.failedStep).toBe('hard-step');
        throw new Error('onFail failed');
      },
    });
    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map([[task.name, task]]),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
    });

    try {
      await expect(processor(makeWorkflowJob(workflow.name, {}) as never)).rejects.toThrow(
        'hard sequential failure',
      );
      expectStructuredErrorLogged(consoleErrorSpy, 'onFail hook');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Helper to build a minimal fake workflow job
// ---------------------------------------------------------------------------

function makeWorkflowJob(workflowName: string, input: Record<string, unknown>, id = 'wf-run-1') {
  const job = {
    id,
    name: workflowName,
    data: {
      workflowName,
      runId: id,
      input,
    } as Record<string, unknown>,
    opts: {} as Record<string, unknown>,
    async updateData(nextData: Record<string, unknown>) {
      job.data = nextData;
    },
  };
  return job;
}

// ---------------------------------------------------------------------------
// Parallel steps
// ---------------------------------------------------------------------------

describe('bullmq workflow processor – parallel steps', () => {
  test('all parallel steps succeed → all results captured and step.completed events emitted', async () => {
    const { eventSink, events } = createEventCollector();

    const taskA = defineTask({
      name: 'par-task-a',
      input: z.object({}),
      output: z.object({ letter: z.string() }),
      async handler() {
        return { letter: 'A' };
      },
    });
    const taskB = defineTask({
      name: 'par-task-b',
      input: z.object({}),
      output: z.object({ letter: z.string() }),
      async handler() {
        return { letter: 'B' };
      },
    });

    const workflow = defineWorkflow({
      name: 'parallel-success-workflow',
      input: z.object({}),
      steps: [parallel([step('step-a', taskA), step('step-b', taskB)])],
    });

    const queue = new FakeQueue();
    queue.pushSuccess({ letter: 'A' });
    queue.pushSuccess({ letter: 'B' });

    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map([
        [taskA.name, taskA],
        [taskB.name, taskB],
      ]),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
      eventSink,
    });

    const result = (await processor(makeWorkflowJob(workflow.name, {}) as never)) as Record<
      string,
      unknown
    >;

    expect(result['step-a']).toEqual({ letter: 'A' });
    expect(result['step-b']).toEqual({ letter: 'B' });

    const completedSteps = events
      .filter(e => e.name === 'orchestration.step.completed')
      .map(e => (e.payload as { step: string }).step);
    expect(completedSteps).toContain('step-a');
    expect(completedSteps).toContain('step-b');
  });

  test('one parallel step fails with continueOnFailure:true → others complete and workflow resolves', async () => {
    const { eventSink, events } = createEventCollector();

    const taskOk = defineTask({
      name: 'par-ok-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    });
    const taskFail = defineTask({
      name: 'par-fail-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        throw new Error('step exploded');
      },
    });

    const workflow = defineWorkflow({
      name: 'parallel-continue-on-failure-workflow',
      input: z.object({}),
      steps: [
        parallel([
          step('ok-step', taskOk),
          step('fail-step', taskFail, { continueOnFailure: true }),
        ]),
      ],
    });

    const queue = new FakeQueue();
    queue.pushSuccess({ ok: true });
    queue.pushFailure(new Error('step exploded'));

    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map([
        [taskOk.name, taskOk],
        [taskFail.name, taskFail],
      ]),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
      eventSink,
    });

    // Workflow should resolve (not throw) because continueOnFailure:true
    const result = (await processor(makeWorkflowJob(workflow.name, {}) as never)) as Record<
      string,
      unknown
    >;

    expect(result['ok-step']).toEqual({ ok: true });
    expect(result['fail-step']).toBeUndefined();

    const eventNames = events.map(e => e.name);
    expect(eventNames).toContain('orchestration.step.completed');
    expect(eventNames).toContain('orchestration.step.failed');
    expect(eventNames).toContain('orchestration.workflow.completed');
    expect(eventNames).not.toContain('orchestration.workflow.failed');
  });

  test('one parallel step fails with continueOnFailure:false → workflow fails', async () => {
    const { eventSink, events } = createEventCollector();

    const taskOk = defineTask({
      name: 'par-hard-ok-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    });
    const taskFail = defineTask({
      name: 'par-hard-fail-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        throw new Error('hard failure');
      },
    });

    const workflow = defineWorkflow({
      name: 'parallel-hard-failure-workflow',
      input: z.object({}),
      steps: [
        parallel([
          step('ok-step', taskOk),
          step('fail-step', taskFail /* continueOnFailure defaults to false */),
        ]),
      ],
    });

    const queue = new FakeQueue();
    queue.pushSuccess({ ok: true });
    queue.pushFailure(new Error('hard failure'));

    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map([
        [taskOk.name, taskOk],
        [taskFail.name, taskFail],
      ]),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
      eventSink,
    });

    await expect(processor(makeWorkflowJob(workflow.name, {}) as never)).rejects.toThrow(
      'hard failure',
    );

    const eventNames = events.map(e => e.name);
    expect(eventNames).toContain('orchestration.step.failed');
    expect(eventNames).toContain('orchestration.workflow.failed');
    expect(eventNames).not.toContain('orchestration.workflow.completed');
  });

  test('step whose condition returns false is skipped and workflow continues', async () => {
    const { eventSink, events } = createEventCollector();

    const alwaysTask = defineTask({
      name: 'always-run-task',
      input: z.object({}),
      output: z.object({ ran: z.boolean() }),
      async handler() {
        return { ran: true };
      },
    });
    const conditionalTask = defineTask({
      name: 'conditional-task',
      input: z.object({}),
      output: z.object({ ran: z.boolean() }),
      async handler() {
        return { ran: true };
      },
    });

    const workflow = defineWorkflow({
      name: 'condition-skip-workflow',
      input: z.object({}),
      steps: [
        step('always-step', alwaysTask),
        step('skipped-step', conditionalTask, { condition: () => false }),
      ],
    });

    const queue = new FakeQueue();
    queue.pushSuccess({ ran: true });

    const processor = createBullMQWorkflowProcessor({
      workflowRegistry: new Map([[workflow.name, workflow]]),
      taskRegistry: new Map([
        [alwaysTask.name, alwaysTask],
        [conditionalTask.name, conditionalTask],
      ]),
      getTaskQueue() {
        return queue as never;
      },
      getTaskQueueEvents() {
        return {} as never;
      },
      eventSink,
    });

    const result = (await processor(makeWorkflowJob(workflow.name, {}) as never)) as Record<
      string,
      unknown
    >;

    // Skipped step result is undefined
    expect(result['skipped-step']).toBeUndefined();
    // The always-run step did execute
    expect(result['always-step']).toEqual({ ran: true });

    // Only one task job was dispatched (the skipped step was not enqueued)
    expect(queue.addCalls).toHaveLength(1);
    expect(queue.addCalls[0]?.name).toBe('always-run-task');

    const eventNames = events.map(e => e.name);
    expect(eventNames).toContain('orchestration.step.skipped');
    expect(eventNames).toContain('orchestration.step.completed');
    expect(eventNames).toContain('orchestration.workflow.completed');
  });
});
