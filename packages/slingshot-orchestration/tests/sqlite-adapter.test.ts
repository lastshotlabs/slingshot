import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { defineTask } from '../src/defineTask';
import { createOrchestrationRuntime } from '../src/runtime';

const sqliteModule = await import('../src/adapters/sqlite').catch(() => null);
let sqliteRuntimeSupported = false;
if (sqliteModule) {
  const probeDir = mkdtempSync(join(tmpdir(), 'slingshot-orchestration-probe-'));
  try {
    // Bun cannot load better-sqlite3 today, so probe actual adapter construction
    // instead of assuming support from the current platform name.
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

describe('sqlite orchestration adapter', () => {
  sqliteTest('runs tasks and lists persisted runs when better-sqlite3 is available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orchestration-'));
    tempDirs.push(dir);

    const dbPath = join(dir, 'orchestration.sqlite');
    const { createSqliteAdapter } = sqliteModule!;
    const task = defineTask({
      name: 'sqlite-task',
      input: z.object({ value: z.string() }),
      output: z.object({ echoed: z.string() }),
      async handler(input, ctx) {
        ctx.reportProgress({ percent: 100, message: 'done' });
        return { echoed: input.value };
      },
    });

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [task],
    });

    await adapter.start();
    const handle = await runtime.runTask('sqlite-task', { value: 'sqlite' }, { tenantId: 'tenant-sqlite' });
    await expect(handle.result()).resolves.toEqual({ echoed: 'sqlite' });

    const run = await runtime.getRun(handle.id);
    expect(run?.status).toBe('completed');
    expect(run?.tenantId).toBe('tenant-sqlite');
    expect(run?.progress).toEqual({ percent: 100, message: 'done' });

    const listed = await runtime.listRuns({ tenantId: 'tenant-sqlite' });
    expect(listed.total).toBe(1);
    expect(listed.runs[0]?.id).toBe(handle.id);

    await adapter.shutdown();
  });
});
