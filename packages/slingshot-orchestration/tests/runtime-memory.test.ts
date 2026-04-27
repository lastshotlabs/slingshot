import { describe, expect, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { createMemoryAdapter } from '../src/adapters/memory';
import { defineTask } from '../src/defineTask';
import { defineWorkflow, sleep, step } from '../src/defineWorkflow';
import { createOrchestrationRuntime } from '../src/runtime';
import type { OrchestrationEventMap, OrchestrationEventSink } from '../src/types';

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

describe('memory orchestration runtime', () => {
  test('replays completed idempotent task results after completion', async () => {
    let executions = 0;
    const echoTask = defineTask({
      name: 'idempotent-echo-task',
      input: z.object({ value: z.string() }),
      output: z.object({ echoed: z.string() }),
      async handler(input) {
        executions += 1;
        return { echoed: input.value };
      },
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [echoTask],
    });

    const first = await runtime.runTask(
      echoTask,
      { value: 'first' },
      { tenantId: 'tenant-a', idempotencyKey: 'quote-123' },
    );
    await expect(first.result()).resolves.toEqual({ echoed: 'first' });

    const replay = await runtime.runTask(
      echoTask,
      { value: 'ignored' },
      { tenantId: 'tenant-a', idempotencyKey: 'quote-123' },
    );

    expect(replay.id).toBe(first.id);
    await expect(replay.result()).resolves.toEqual({ echoed: 'first' });
    expect(executions).toBe(1);
  });

  test('scopes idempotency by tenant and definition name', async () => {
    const quoteTask = defineTask({
      name: 'quote-task',
      input: z.object({ value: z.string() }),
      output: z.object({ echoed: z.string() }),
      async handler(input) {
        return { echoed: `quote:${input.value}` };
      },
    });
    const orderTask = defineTask({
      name: 'order-task',
      input: z.object({ value: z.string() }),
      output: z.object({ echoed: z.string() }),
      async handler(input) {
        return { echoed: `order:${input.value}` };
      },
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [quoteTask, orderTask],
    });

    const tenantA = await runtime.runTask(
      quoteTask,
      { value: 'a' },
      { tenantId: 'tenant-a', idempotencyKey: 'shared-key' },
    );
    const tenantAReplay = await runtime.runTask(
      quoteTask,
      { value: 'ignored' },
      { tenantId: 'tenant-a', idempotencyKey: 'shared-key' },
    );
    const tenantB = await runtime.runTask(
      quoteTask,
      { value: 'b' },
      { tenantId: 'tenant-b', idempotencyKey: 'shared-key' },
    );
    const otherDefinition = await runtime.runTask(
      orderTask,
      { value: 'c' },
      { tenantId: 'tenant-a', idempotencyKey: 'shared-key' },
    );

    expect(tenantAReplay.id).toBe(tenantA.id);
    expect(tenantB.id).not.toBe(tenantA.id);
    expect(otherDefinition.id).not.toBe(tenantA.id);
  });

  test('delays task execution and emits task lifecycle events', async () => {
    const { eventSink, events } = createEventCollector();
    const echoTask = defineTask({
      name: 'echo-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string(), executedAt: z.number() }),
      async handler(input) {
        return { value: input.value, executedAt: Date.now() };
      },
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1, eventSink }),
      tasks: [echoTask],
    });

    const startedAt = Date.now();
    const handle = await runtime.runTask(
      'echo-task',
      { value: 'ok' },
      { delay: 40, tenantId: 'tenant-a' },
    );
    const output = (await handle.result()) as { value: string; executedAt: number };

    expect(output.value).toBe('ok');
    expect(output.executedAt - startedAt).toBeGreaterThanOrEqual(30);
    expect(events.map(event => event.name)).toEqual([
      'orchestration.task.started',
      'orchestration.task.completed',
    ]);
  });

  test('fails workflows on workflow timeout', async () => {
    const { eventSink, events } = createEventCollector();
    const timedWorkflow = defineWorkflow({
      name: 'timed-workflow',
      input: z.object({}),
      steps: [sleep('slow-step', 100)],
      timeout: 20,
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1, eventSink }),
      tasks: [],
      workflows: [timedWorkflow],
    });

    const timedHandle = await runtime.runWorkflow('timed-workflow', {});
    await expect(timedHandle.result()).rejects.toThrow('Workflow timed out');
    const timedRun = await runtime.getRun(timedHandle.id);
    expect(timedRun?.status).toBe('failed');
    expect(timedRun?.error?.message).toBe('Workflow timed out');
    expect(events.map(event => event.name)).toEqual([
      'orchestration.workflow.started',
      'orchestration.workflow.failed',
    ]);
  });

  test('logs workflow hook failures when no event sink is configured', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hookErrorWorkflow = defineWorkflow({
        name: 'hook-error-workflow',
        input: z.object({}),
        steps: [sleep('noop-step', 1)],
        onStart() {
          throw new Error('hook exploded');
        },
      });

      const runtime = createOrchestrationRuntime({
        adapter: createMemoryAdapter({ concurrency: 1 }),
        tasks: [],
        workflows: [hookErrorWorkflow],
      });

      const handle = await runtime.runWorkflow(hookErrorWorkflow, {});
      await expect(handle.result()).resolves.toEqual(
        expect.objectContaining({
          'noop-step': expect.objectContaining({ sleptMs: 1 }),
        }),
      );
      expect(consoleError).toHaveBeenCalledWith(
        '[orchestration] workflow onStart hook failed',
        expect.objectContaining({ message: 'hook exploded' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test('continueOnFailure: true allows workflow to complete when step fails', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failTask = defineTask({
        name: 'fail-task-cof',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        async handler() {
          await new Promise(r => setTimeout(r, 0));
          throw new Error('intentional failure');
        },
      });
      const succeedTask = defineTask({
        name: 'succeed-task-cof',
        input: z.object({}),
        output: z.object({ done: z.boolean() }),
        async handler() {
          return { done: true };
        },
      });
      const workflow = defineWorkflow({
        name: 'resilient-workflow-cof',
        input: z.object({}),
        steps: [
          step('failing-step', failTask, { continueOnFailure: true }),
          step('success-step', succeedTask),
        ],
      });

      const runtime = createOrchestrationRuntime({
        adapter: createMemoryAdapter({ concurrency: 1 }),
        tasks: [failTask, succeedTask],
        workflows: [workflow],
      });

      const handle = await runtime.runWorkflow(workflow, {});
      const result = (await handle.result()) as Record<string, unknown>;

      expect(result['failing-step']).toBeUndefined();
      expect(result['success-step']).toMatchObject({ done: true });
      const run = await runtime.getRun(handle.id);
      expect(run?.status).toBe('completed');
    } finally {
      consoleError.mockRestore();
    }
  });

  test('continueOnFailure: false (default) fails the workflow when a step fails', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const { eventSink, events } = createEventCollector();
    try {
      const failTask = defineTask({
        name: 'hard-fail-task-cof',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        async handler() {
          await new Promise(r => setTimeout(r, 0));
          throw new Error('step failed hard');
        },
      });
      const workflow = defineWorkflow({
        name: 'hard-fail-workflow-cof',
        input: z.object({}),
        steps: [step('hard-step', failTask)],
      });

      const runtime = createOrchestrationRuntime({
        adapter: createMemoryAdapter({ concurrency: 1, eventSink }),
        tasks: [failTask],
        workflows: [workflow],
      });

      const handle = await runtime.runWorkflow(workflow, {});
      // Attach the rejection handler BEFORE awaiting (same tick as runWorkflow return)
      const resultPromise = handle.result();
      let rejectedMessage: string | undefined;
      try {
        await resultPromise;
      } catch (err) {
        rejectedMessage = err instanceof Error ? err.message : String(err);
      }
      expect(rejectedMessage).toBe('step failed hard');
      const run = await runtime.getRun(handle.id);
      expect(run?.status).toBe('failed');
      expect(events.map(e => e.name)).toContain('orchestration.workflow.failed');
    } finally {
      consoleError.mockRestore();
    }
  });

  test('cancelRun marks a workflow as cancelled and handle.result() rejects', async () => {
    const workflow = defineWorkflow({
      name: 'cancellable-workflow-cof',
      input: z.object({}),
      steps: [sleep('wait-step', 60_000)],
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [],
      workflows: [workflow],
    });

    const handle = await runtime.runWorkflow(workflow, {});
    await runtime.cancelRun(handle.id);

    let error: Error | undefined;
    try {
      await handle.result();
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }
    expect(error?.message).toContain('cancelled');
    const run = await runtime.getRun(handle.id);
    expect(run?.status).toBe('cancelled');
  });
});
