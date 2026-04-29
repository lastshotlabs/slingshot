// packages/slingshot-orchestration/tests/adapter-sqlite-edge.test.ts
//
// Edge-case tests for the SQLite adapter: in-memory database, getRun for
// non-existent runs, cancelRun for non-existent runs, listRuns filters,
// and options validation.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '../src/defineTask';
import { createOrchestrationRuntime } from '../src/runtime';
import { OrchestrationError } from '../src/errors';

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
});

describe('sqlite adapter — listRuns filters', () => {
  sqliteTest('lists runs filtered by name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-sqlite-list-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'list.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    await adapter.start();

    await runtime.runTask(noopTask, {});

    const result = await adapter.listRuns({ name: 'sqlite-edge-task' });
    expect(result.total).toBe(1);

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

    await runtime.runTask(noopTask, {}, { tenantId: 'tenant-sqlite' });

    const result = await adapter.listRuns({ tenantId: 'tenant-sqlite' });
    expect(result.total).toBe(1);

    await adapter.shutdown();
  });

  sqliteTest('lists runs with default pagination when no filter is provided', async () => {
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

describe('sqlite adapter — constructor validation', () => {
  test('createSqliteAdapter rejects empty path', () => {
    const { createSqliteAdapter } = sqliteModule!;
    // The schema requires a non-empty path
    expect(() => createSqliteAdapter({ path: '', concurrency: 1 })).toThrow();
  });

  sqliteTest('createSqliteAdapter rejects zero concurrency', () => {
    const { createSqliteAdapter } = sqliteModule!;
    // Negative test: concurrency must be positive
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
