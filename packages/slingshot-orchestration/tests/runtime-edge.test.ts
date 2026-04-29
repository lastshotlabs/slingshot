// packages/slingshot-orchestration/tests/runtime-edge.test.ts
//
// Edge-case tests for createOrchestrationRuntime: empty tasks/workflows,
// runTask/runWorkflow with object ref vs string name, supports() for
// capabilities that the adapter does/doesn't have, and onProgress.
import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { createMemoryAdapter } from '../src/adapters/memory';
import { defineTask } from '../src/defineTask';
import { defineWorkflow, sleep, step } from '../src/defineWorkflow';
import { OrchestrationError } from '../src/errors';
import { createOrchestrationRuntime } from '../src/runtime';
import type { OrchestrationAdapter, OrchestrationRuntime } from '../src/types';

const noopTask = defineTask({
  name: 'noop-task',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  async handler() {
    return { ok: true };
  },
});

describe('createOrchestrationRuntime — empty registries', () => {
  test('accepts empty tasks array', () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [] });
    expect(typeof runtime.runTask).toBe('function');
  });

  test('defaults workflows to empty when not provided', () => {
    // Internally, `options.workflows ?? []` handles this
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    expect(typeof runtime.runWorkflow).toBe('function');
  });

  test('runTask on unregistered task throws TASK_NOT_FOUND', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [] });

    await expect(runtime.runTask('unknown-task', {})).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  test('runWorkflow on unregistered workflow throws WORKFLOW_NOT_FOUND', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [] });

    await expect(runtime.runWorkflow('unknown-wf', {})).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_FOUND',
    });
  });
});

describe('createOrchestrationRuntime — runTask with object ref vs string', () => {
  test('runTask accepts a task object and resolves the name', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    const handle = await runtime.runTask(noopTask, {});
    const result = await handle.result();
    expect(result).toEqual({ ok: true });
  });

  test('runTask accepts a task name string', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    const handle = await runtime.runTask('noop-task', {});
    const result = await handle.result();
    expect(result).toEqual({ ok: true });
  });
});

describe('createOrchestrationRuntime — runWorkflow with object ref vs string', () => {
  const simpleWf = defineWorkflow({
    name: 'simple-wf',
    input: z.object({}),
    steps: [sleep('s1', 0)],
  });

  test('runWorkflow accepts a workflow object', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [],
      workflows: [simpleWf],
    });

    const handle = await runtime.runWorkflow(simpleWf, {});
    const result = await handle.result();
    expect(result).toBeDefined();
  });

  test('runWorkflow accepts a workflow name string', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [],
      workflows: [simpleWf],
    });

    const handle = await runtime.runWorkflow('simple-wf', {});
    const result = await handle.result();
    expect(result).toBeDefined();
  });
});

describe('createOrchestrationRuntime — supports()', () => {
  test('memory adapter does not support signals', () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });
    expect(runtime.supports('signals')).toBe(false);
  });

  test('memory adapter does not support scheduling', () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });
    expect(runtime.supports('scheduling')).toBe(false);
  });

  test('memory adapter supports observability', () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });
    expect(runtime.supports('observability')).toBe(true);
  });

  test('memory adapter supports progress', () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });
    expect(runtime.supports('progress')).toBe(true);
  });

  test('unknown capability returns undefined', () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });
    expect(runtime.supports('nonexistent' as never)).toBeUndefined();
  });
});

describe('createOrchestrationRuntime — signal, schedule reject when unsupported', () => {
  test('signal rejects with unsupported error', async () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });

    let caught: unknown;
    try {
      await runtime.signal('run-1', 'pause', {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).code).toBe('CAPABILITY_NOT_SUPPORTED');
  });

  test('schedule rejects with unsupported error', async () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });

    let caught: unknown;
    try {
      await runtime.schedule({ type: 'task', name: 'noop-task' }, '* * * * *');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).code).toBe('CAPABILITY_NOT_SUPPORTED');
  });

  test('unschedule rejects with unsupported error', async () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });

    let caught: unknown;
    try {
      await runtime.unschedule('sched-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
  });

  test('listSchedules rejects with unsupported error', async () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });

    let caught: unknown;
    try {
      await runtime.listSchedules();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
  });

  test('listRuns rejects with unsupported error when adapter lacks observability', async () => {
    // Build an adapter without observability capability
    const minimalAdapter: OrchestrationAdapter = {
      registerTask() {},
      registerWorkflow() {},
      async runTask() {
        return { id: 'r', result: async () => ({}) };
      },
      async runWorkflow() {
        return { id: 'r', result: async () => ({}) };
      },
      async getRun() {
        return null;
      },
      async cancelRun() {},
      async start() {},
      async shutdown() {},
    };

    const runtime = createOrchestrationRuntime({
      adapter: minimalAdapter,
      tasks: [noopTask],
    });

    let caught: unknown;
    try {
      await runtime.listRuns({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).code).toBe('CAPABILITY_NOT_SUPPORTED');
  });
});

describe('createOrchestrationRuntime — onProgress', () => {
  test('onProgress returns an unsubscribe function', () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });

    const unsub = runtime.onProgress('run-id', () => {});
    expect(typeof unsub).toBe('function');
  });

  test('onProgress rejects when adapter lacks progress capability', () => {
    const minimalAdapter: OrchestrationAdapter = {
      registerTask() {},
      registerWorkflow() {},
      async runTask() {
        return { id: 'r', result: async () => ({}) };
      },
      async runWorkflow() {
        return { id: 'r', result: async () => ({}) };
      },
      async getRun() {
        return null;
      },
      async cancelRun() {},
      async start() {},
      async shutdown() {},
    };

    const runtime = createOrchestrationRuntime({
      adapter: minimalAdapter,
      tasks: [noopTask],
    });

    expect(() => runtime.onProgress('run-id', () => {})).toThrow(OrchestrationError);
  });
});

describe('createOrchestrationRuntime — getRun and cancelRun', () => {
  test('getRun returns null for non-existent run', async () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });

    const run = await runtime.getRun('nonexistent-run-id');
    expect(run).toBeNull();
  });

  test('cancelRun throws RUN_NOT_FOUND for non-existent run', async () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });

    await expect(runtime.cancelRun('nonexistent-run-id')).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
  });
});
