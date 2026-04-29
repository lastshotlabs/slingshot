// packages/slingshot-orchestration/tests/adapter-memory-edge.test.ts
//
// Edge-case tests for the memory adapter: listRuns with various filters,
// empty run lists, tag filtering, duplicate task registration, shutdown
// while tasks are running, and getRun for non-existent run IDs.
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createMemoryAdapter } from '../src/adapters/memory';
import { defineTask } from '../src/defineTask';
import { OrchestrationError } from '../src/errors';
import { createOrchestrationRuntime } from '../src/runtime';

const noopTask = defineTask({
  name: 'noop-task',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  async handler() {
    return { ok: true };
  },
});

const echoTask = defineTask({
  name: 'echo-task',
  input: z.object({ value: z.string() }),
  output: z.object({ echoed: z.string() }),
  async handler(input) {
    return { echoed: input.value };
  },
});

describe('memory adapter — listRuns with empty state', () => {
  test('listRuns with no runs returns empty list', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const result = await adapter.listRuns({});
    expect(result.runs).toEqual([]);
    expect(result.total).toBe(0);
  });

  test('listRuns with no filter returns all runs', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await runtime.runTask(noopTask, {});
    await runtime.runTask(noopTask, {});

    const result = await adapter.listRuns({});
    expect(result.total).toBe(2);
    expect(result.runs).toHaveLength(2);
  });
});

describe('memory adapter — listRuns filters', () => {
  test('listRuns filters by type', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await runtime.runTask(noopTask, {});

    const tasks = await adapter.listRuns({ type: 'task' });
    expect(tasks.total).toBe(1);

    const workflows = await adapter.listRuns({ type: 'workflow' });
    expect(workflows.total).toBe(0);
  });

  test('listRuns filters by status', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await runtime.runTask(noopTask, {});

    // After completion, status should be 'completed'
    const completed = await adapter.listRuns({ status: 'completed' });
    expect(completed.total).toBe(1);

    const pending = await adapter.listRuns({ status: 'pending' });
    expect(pending.total).toBe(0);
  });

  test('listRuns filters by name', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask, echoTask] });

    await runtime.runTask(noopTask, {});
    await runtime.runTask(echoTask, { value: 'test' });

    const result = await adapter.listRuns({ name: 'echo-task' });
    expect(result.total).toBe(1);
    expect(result.runs[0]?.name).toBe('echo-task');
  });

  test('listRuns filters by tenantId', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await runtime.runTask(noopTask, {}, { tenantId: 'tenant-a' });
    await runtime.runTask(noopTask, {}, { tenantId: 'tenant-b' });

    const result = await adapter.listRuns({ tenantId: 'tenant-a' });
    expect(result.total).toBe(1);
    expect(result.runs[0]?.tenantId).toBe('tenant-a');
  });

  test('listRuns filters by tags', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await runtime.runTask(noopTask, {}, { tags: { env: 'prod' } });
    await runtime.runTask(noopTask, {}, { tags: { env: 'staging' } });

    const result = await adapter.listRuns({ tags: { env: 'prod' } });
    expect(result.total).toBe(1);
  });

  test('listRuns with non-matching tags returns empty', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await runtime.runTask(noopTask, {}, { tags: { env: 'prod' } });

    const result = await adapter.listRuns({ tags: { env: 'nonexistent' } });
    expect(result.total).toBe(0);
  });

  test('listRuns with tags filter and no tags on run returns empty', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await runtime.runTask(noopTask, {}); // no tags

    const result = await adapter.listRuns({ tags: { env: 'prod' } });
    expect(result.total).toBe(0);
  });
});

describe('memory adapter — listRuns date filters', () => {
  test('listRuns filters by createdAfter', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await runtime.runTask(noopTask, {});
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    const afterPast = await adapter.listRuns({ createdAfter: past });
    expect(afterPast.total).toBe(1);

    const afterFuture = await adapter.listRuns({ createdAfter: future });
    expect(afterFuture.total).toBe(0);
  });

  test('listRuns filters by createdBefore', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await runtime.runTask(noopTask, {});
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    const beforePast = await adapter.listRuns({ createdBefore: past });
    expect(beforePast.total).toBe(0);

    const beforeFuture = await adapter.listRuns({ createdBefore: future });
    expect(beforeFuture.total).toBe(1);
  });
});

describe('memory adapter — listRuns pagination', () => {
  test('listRuns respects offset', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await runtime.runTask(noopTask, {});
    await runtime.runTask(noopTask, {});

    const result = await adapter.listRuns({ offset: 1 });
    expect(result.runs).toHaveLength(1);
    expect(result.total).toBe(2);
  });

  test('listRuns respects limit', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await runtime.runTask(noopTask, {});
    await runtime.runTask(noopTask, {});
    await runtime.runTask(noopTask, {});

    const result = await adapter.listRuns({ limit: 2 });
    expect(result.runs).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  test('listRuns with zero offset and large limit returns all', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await runtime.runTask(noopTask, {});
    await runtime.runTask(noopTask, {});

    const result = await adapter.listRuns({ offset: 0, limit: 100 });
    expect(result.runs).toHaveLength(2);
  });
});

describe('memory adapter — getRun and cancelRun edge cases', () => {
  test('getRun returns null for non-existent run', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const run = await adapter.getRun('does-not-exist');
    expect(run).toBeNull();
  });

  test('cancelRun throws RUN_NOT_FOUND for non-existent run', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    await expect(adapter.cancelRun('does-not-exist')).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
  });

  test('cancelRun on a completed run still succeeds', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    const handle = await runtime.runTask(noopTask, {});
    await handle.result();

    // Cancel after completion should not throw
    await expect(adapter.cancelRun(handle.id)).resolves.toBeUndefined();
  });
});

describe('memory adapter — duplicate registration', () => {
  test('registering the same task twice overwrites without error', () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    adapter.registerTask(noopTask);
    expect(() => adapter.registerTask(noopTask)).not.toThrow();
  });
});

describe('memory adapter — shutdown', () => {
  test('shutdown resolves even when no tasks have been run', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });

  test('shutdown is idempotent', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    await adapter.shutdown();
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });

  test('runTask rejects with ADAPTER_ERROR when shutting down', async () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    await adapter.shutdown();

    await expect(runtime.runTask(noopTask, {})).rejects.toMatchObject({
      code: 'ADAPTER_ERROR',
    });
  });
});

describe('memory adapter — maxPayloadBytes option', () => {
  test('accepts a custom maxPayloadBytes value', () => {
    const adapter = createMemoryAdapter({ concurrency: 1, maxPayloadBytes: 2048 });
    expect(adapter).toBeDefined();
    expect(typeof adapter.runTask).toBe('function');
  });
});
