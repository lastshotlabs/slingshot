import { describe, expect, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { createMemoryAdapter } from '../src/adapters/memory';
import { defineTask } from '../src/defineTask';
import { defineWorkflow, sleep } from '../src/defineWorkflow';
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
});
