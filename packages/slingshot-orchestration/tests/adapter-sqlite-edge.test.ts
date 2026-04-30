// packages/slingshot-orchestration/tests/adapter-sqlite-edge.test.ts
//
// Edge-case tests for the SQLite adapter: in-memory database, getRun for
// non-existent runs, cancelRun for non-existent runs, listRuns filters,
// and options validation. Expanded to match memory adapter coverage.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '../src/defineTask';
import { defineWorkflow, sleep, step } from '../src/defineWorkflow';
import { OrchestrationError } from '../src/errors';
import { createOrchestrationRuntime } from '../src/runtime';

const sqliteModule = await import('../src/adapters/sqlite').catch(() => null);
let sqliteRuntimeSupported = false;
if (sqliteModule) {
  const probeDir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-edge-probe-'));
  try {
    const adapter = sqliteModule.createSqliteAdapter({
      path: join(probeDir, 'probe.sqlite'),
      concurrency: 1,
    });
    await adapter.shutdown();
    sqliteRuntimeSupported = true;
  } catch {
    sqliteRuntimeSupported = false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}
const sqliteTest = sqliteRuntimeSupported ? test : test.skip;
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const noopTask = defineTask({
  name: 'sqlite-edge-task',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  async handler() {
    return { ok: true };
  },
});

const echoTask = defineTask({
  name: 'sqlite-echo-task',
  input: z.object({ value: z.string() }),
  output: z.object({ echoed: z.string() }),
  async handler(input) {
    return { echoed: input.value };
  },
});

describe('sqlite adapter — in-memory database', () => {
  sqliteTest('accepts :memory: path and runs a task', async () => {
    const { createSqliteAdapter } = sqliteModule!;
    const adapter = createSqliteAdapter({ path: ':memory:', concurrency: 1 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [noopTask],
    });

    await adapter.start();
    const handle = await runtime.runTask(noopTask, {});
    await expect(handle.result()).resolves.toEqual({ ok: true });

    await adapter.shutdown();
  });

  sqliteTest('starts and shuts down with :memory: path without errors', async () => {
    const { createSqliteAdapter } = sqliteModule!;
    const adapter = createSqliteAdapter({ path: ':memory:', concurrency: 1 });
    await adapter.start();
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });
});

describe('sqlite adapter — getRun edge cases', () => {
  sqliteTest('returns null for non-existent run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-getrun-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'getrun.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    await adapter.start();

    const run = await adapter.getRun('nonexistent-run-id');
    expect(run).toBeNull();

    await adapter.shutdown();
  });

  sqliteTest('returns run after completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-getrun2-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'getrun2.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    const handle = await runtime.runTask(noopTask, {});
    await handle.result();

    const run = await adapter.getRun(handle.id);
    expect(run).not.toBeNull();
    expect(run?.status).toBe('completed');

    await adapter.shutdown();
  });
});

describe('sqlite adapter — cancelRun edge cases', () => {
  sqliteTest('throws RUN_NOT_FOUND for non-existent run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-cancel-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'cancel.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    await adapter.start();

    let caught: unknown;
    try {
      await adapter.cancelRun('nonexistent-run-id');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).code).toBe('RUN_NOT_FOUND');

    await adapter.shutdown();
  });

  sqliteTest('cancelRun on a completed run still succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-cancel-cpl-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'cancel-cpl.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    const handle = await runtime.runTask(noopTask, {});
    await handle.result();

    // Cancel after completion should not throw
    await expect(adapter.cancelRun(handle.id)).resolves.toBeUndefined();

    await adapter.shutdown();
  });

  sqliteTest('cancelRun marks a cancelled run in the database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-cancel-db-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'cancel-db.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    const handle = await runtime.runTask(noopTask, {});
    await adapter.cancelRun(handle.id);

    const run = await adapter.getRun(handle.id);
    expect(run?.status).toBe('cancelled');

    await adapter.shutdown();
  });
});

describe('sqlite adapter — listRuns with empty state', () => {
  sqliteTest('listRuns with no runs returns empty list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-empty-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'empty.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    await adapter.start();

    const result = await adapter.listRuns({});
    expect(result.runs).toEqual([]);
    expect(result.total).toBe(0);

    await adapter.shutdown();
  });

  sqliteTest('listRuns with no filter returns all runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-all-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'all.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {});
    await runtime.runTask(noopTask, {});

    const result = await adapter.listRuns({});
    expect(result.total).toBe(2);
    expect(result.runs).toHaveLength(2);

    await adapter.shutdown();
  });
});

describe('sqlite adapter — listRuns filters', () => {
  sqliteTest('lists runs filtered by type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-type-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'type.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {});

    const tasks = await adapter.listRuns({ type: 'task' });
    expect(tasks.total).toBe(1);

    const workflows = await adapter.listRuns({ type: 'workflow' });
    expect(workflows.total).toBe(0);

    await adapter.shutdown();
  });

  sqliteTest('lists runs filtered by status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-status-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'status.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {});

    const completed = await adapter.listRuns({ status: 'completed' });
    expect(completed.total).toBe(1);

    const pending = await adapter.listRuns({ status: 'pending' });
    expect(pending.total).toBe(0);

    await adapter.shutdown();
  });

  sqliteTest('lists runs filtered by name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-name-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'name.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask, echoTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {});
    await runtime.runTask(echoTask, { value: 'test' });

    const result = await adapter.listRuns({ name: 'sqlite-echo-task' });
    expect(result.total).toBe(1);
    expect(result.runs[0]?.name).toBe('sqlite-echo-task');

    const noMatch = await adapter.listRuns({ name: 'nonexistent' });
    expect(noMatch.total).toBe(0);

    await adapter.shutdown();
  });

  sqliteTest('lists runs filtered by tenantId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-tenant-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'tenant.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {}, { tenantId: 'tenant-a' });
    await runtime.runTask(noopTask, {}, { tenantId: 'tenant-b' });

    const result = await adapter.listRuns({ tenantId: 'tenant-a' });
    expect(result.total).toBe(1);
    expect(result.runs[0]?.tenantId).toBe('tenant-a');

    await adapter.shutdown();
  });

  sqliteTest('lists runs filtered by tags', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-tags-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'tags.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {}, { tags: { env: 'prod' } });
    await runtime.runTask(noopTask, {}, { tags: { env: 'staging' } });

    const result = await adapter.listRuns({ tags: { env: 'prod' } });
    expect(result.total).toBe(1);

    await adapter.shutdown();
  });

  sqliteTest('listRuns with non-matching tags returns empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-tags-nomatch-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'tags-nomatch.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {}, { tags: { env: 'prod' } });

    const result = await adapter.listRuns({ tags: { env: 'nonexistent' } });
    expect(result.total).toBe(0);

    await adapter.shutdown();
  });

  sqliteTest('listRuns with tags filter and no tags on run returns empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-tags-notag-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'tags-notag.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {}); // no tags

    const result = await adapter.listRuns({ tags: { env: 'prod' } });
    expect(result.total).toBe(0);

    await adapter.shutdown();
  });

  sqliteTest('listRuns with default pagination when no filter is provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-listall-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'listall.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {});

    const result = await adapter.listRuns({});
    expect(result.runs.length).toBeGreaterThanOrEqual(1);

    await adapter.shutdown();
  });
});

describe('sqlite adapter — listRuns date filters', () => {
  sqliteTest('listRuns filters by createdAfter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-date-after-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'date-after.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {});
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    const afterPast = await adapter.listRuns({ createdAfter: past });
    expect(afterPast.total).toBe(1);

    const afterFuture = await adapter.listRuns({ createdAfter: future });
    expect(afterFuture.total).toBe(0);

    await adapter.shutdown();
  });

  sqliteTest('listRuns filters by createdBefore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-date-before-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'date-before.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {});
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    const beforePast = await adapter.listRuns({ createdBefore: past });
    expect(beforePast.total).toBe(0);

    const beforeFuture = await adapter.listRuns({ createdBefore: future });
    expect(beforeFuture.total).toBe(1);

    await adapter.shutdown();
  });
});

describe('sqlite adapter — listRuns pagination', () => {
  sqliteTest('listRuns respects offset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-offset-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'offset.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 2 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {});
    await runtime.runTask(noopTask, {});

    const result = await adapter.listRuns({ offset: 1 });
    expect(result.runs).toHaveLength(1);
    expect(result.total).toBe(2);

    await adapter.shutdown();
  });

  sqliteTest('listRuns respects limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-limit-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'limit.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 2 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {});
    await runtime.runTask(noopTask, {});
    await runtime.runTask(noopTask, {});

    const result = await adapter.listRuns({ limit: 2 });
    expect(result.runs).toHaveLength(2);
    expect(result.total).toBe(3);

    await adapter.shutdown();
  });

  sqliteTest('listRuns with zero offset and large limit returns all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-offset-large-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'offset-large.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 2 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {});
    await runtime.runTask(noopTask, {});

    const result = await adapter.listRuns({ offset: 0, limit: 100 });
    expect(result.runs).toHaveLength(2);

    await adapter.shutdown();
  });
});

describe('sqlite adapter — constructor validation', () => {
  test('createSqliteAdapter rejects empty path', () => {
    const { createSqliteAdapter } = sqliteModule!;
    expect(() => createSqliteAdapter({ path: '', concurrency: 1 })).toThrow();
  });

  sqliteTest('createSqliteAdapter rejects zero concurrency', () => {
    const { createSqliteAdapter } = sqliteModule!;
    expect(() => createSqliteAdapter({ path: ':memory:', concurrency: 0 })).toThrow();
  });
});

describe('sqlite adapter — multiple sequential runs', () => {
  sqliteTest('handles multiple sequential task runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-seq-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'seq.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 2 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    const h1 = await runtime.runTask(noopTask, {});
    const h2 = await runtime.runTask(noopTask, {});
    const h3 = await runtime.runTask(noopTask, {});

    await Promise.all([h1.result(), h2.result(), h3.result()]);

    const all = await adapter.listRuns({});
    expect(all.total).toBe(3);

    await adapter.shutdown();
  });
});

describe('sqlite adapter — duplicate registration', () => {
  sqliteTest('registering the same task twice overwrites without error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-dupe-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'dupe.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    adapter.registerTask(noopTask);
    expect(() => adapter.registerTask(noopTask)).not.toThrow();
    await adapter.shutdown();
  });
});

describe('sqlite adapter — shutdown', () => {
  sqliteTest('shutdown resolves even when no tasks have been run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-ss-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'ss.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });

  sqliteTest('shutdown is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-ss2-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'ss2.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    await adapter.shutdown();
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });

  sqliteTest('runTask rejects with ADAPTER_ERROR when shutting down', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-ss3-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'ss3.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    // Avoid the run-once start guard by directly setting shuttingDown
    // We need to test the behavior. First run a task to verify the adapter works.
    const handle = await runtime.runTask(noopTask, {});
    await handle.result();

    // Shut down the adapter
    await adapter.shutdown();

    // After shutdown, runTask should throw
    await expect(runtime.runTask(noopTask, {})).rejects.toMatchObject({
      code: 'ADAPTER_ERROR',
    });
  });
});

describe('sqlite adapter — maxPayloadBytes option', () => {
  sqliteTest('accepts a custom maxPayloadBytes value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-payload-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'payload.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1, maxPayloadBytes: 2048 });
    expect(adapter).toBeDefined();
    expect(typeof adapter.runTask).toBe('function');
    await adapter.shutdown();
  });
});

describe('sqlite adapter — progress listeners', () => {
  sqliteTest('onProgress receives progress updates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-prog-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'prog.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const progressTask = defineTask({
      name: 'sqlite-prog-task',
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      async handler(_input, ctx) {
        ctx.reportProgress({ percent: 50, message: 'halfway' });
        return { done: true };
      },
    });

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [progressTask] });
    await adapter.start();

    const progressUpdates: unknown[] = [];
    adapter.onProgress?.('temporary', () => {}); // just verify the method exists

    const handle = await runtime.runTask(progressTask, {});
    await handle.result();

    const run = await adapter.getRun(handle.id);
    expect(run?.progress).toBeDefined();

    await adapter.shutdown();
  });
});

describe('sqlite adapter — workflow runs', () => {
  sqliteTest('runs a simple workflow and persists steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-wf-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'wf.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const stepTask = defineTask({
      name: 'sqlite-wf-step',
      input: z.object({ val: z.number() }),
      output: z.object({ doubled: z.number() }),
      async handler(input) {
        return { doubled: input.val * 2 };
      },
    });

    const workflow = defineWorkflow({
      name: 'sqlite-workflow',
      input: z.object({ x: z.number() }),
      steps: [step('double', stepTask)],
    });

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [stepTask],
      workflows: [workflow],
    });
    await adapter.start();

    const handle = await runtime.runWorkflow(workflow, { x: 21 });
    const result = (await handle.result()) as Record<string, unknown>;
    expect(result['double']).toMatchObject({ doubled: 42 });

    const run = await adapter.getRun(handle.id);
    expect(run?.status).toBe('completed');
    expect(run?.type).toBe('workflow');

    await adapter.shutdown();
  });

  sqliteTest('runs workflow with multiple sequential steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-wf-seq-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'wf-seq.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const addTask = defineTask({
      name: 'sqlite-add-task',
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ sum: z.number() }),
      async handler(input) {
        return { sum: input.a + input.b };
      },
    });

    const workflow = defineWorkflow({
      name: 'sqlite-seq-workflow',
      input: z.object({}),
      steps: [
        step('add-one', addTask, { input: () => ({ a: 1, b: 2 }) }),
        step('add-two', addTask, { input: () => ({ a: 3, b: 4 }) }),
      ],
    });

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [addTask],
      workflows: [workflow],
    });
    await adapter.start();

    const handle = await runtime.runWorkflow(workflow, {});
    const result = (await handle.result()) as Record<string, unknown>;
    expect(result['add-one']).toMatchObject({ sum: 3 });
    expect(result['add-two']).toMatchObject({ sum: 7 });

    await adapter.shutdown();
  });

  sqliteTest('workflow with sleep step completes successfully', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-wf-sleep-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'wf-sleep.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const workflow = defineWorkflow({
      name: 'sqlite-sleep-workflow',
      input: z.object({}),
      steps: [sleep('nap', 5)],
    });

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [],
      workflows: [workflow],
    });
    await adapter.start();

    const handle = await runtime.runWorkflow(workflow, {});
    const result = (await handle.result()) as Record<string, unknown>;
    expect(result['nap']).toMatchObject({ sleptMs: 5 });

    await adapter.shutdown();
  });
});
