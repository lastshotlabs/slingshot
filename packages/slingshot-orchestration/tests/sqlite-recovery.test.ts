import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '../src/defineTask';
import { defineWorkflow, step } from '../src/defineWorkflow';
import { createOrchestrationRuntime } from '../src/runtime';

const sqliteModule = await import('../src/adapters/sqlite').catch(() => null);
let sqliteRuntimeSupported = false;
if (sqliteModule) {
  const probeDir = mkdtempSync(join(tmpdir(), 'slingshot-orch-recovery-probe-'));
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

describe('sqlite crash recovery', () => {
  sqliteTest('recovers an interrupted workflow and completes it on adapter restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-recovery-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'recovery.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    let step1Executions = 0;
    let step2Executions = 0;

    const step1Task = defineTask({
      name: 'recovery-step1-task',
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      async handler() {
        step1Executions += 1;
        return { done: true };
      },
    });

    const step2Task = defineTask({
      name: 'recovery-step2-task',
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      async handler() {
        step2Executions += 1;
        return { done: true };
      },
    });

    const workflow = defineWorkflow({
      name: 'recovery-workflow',
      input: z.object({}),
      steps: [step('step-one', step1Task), step('step-two', step2Task)],
    });

    // === First adapter instance: run the workflow to completion ===
    const adapter1 = createSqliteAdapter({ path: dbPath, concurrency: 2 });
    const runtime1 = createOrchestrationRuntime({
      adapter: adapter1,
      tasks: [step1Task, step2Task],
      workflows: [workflow],
    });

    await adapter1.start();
    const handle1 = await runtime1.runWorkflow(workflow, {});
    await handle1.result();

    // Reset counters before simulating crash recovery
    step1Executions = 0;
    step2Executions = 0;

    // Simulate a crash: forcibly update the workflow back to 'running' status
    // so the next adapter startup will pick it up for recovery.
    const Database = (await import('better-sqlite3')).default;
    const rawDb = new Database(dbPath);
    rawDb.pragma('journal_mode = WAL');
    rawDb
      .prepare(`UPDATE orchestration_runs SET status = 'running', completed_at = NULL WHERE id = ?`)
      .run(handle1.id);
    // Also reset both steps back to running so they get re-executed
    rawDb
      .prepare(
        `UPDATE orchestration_steps SET status = 'running', completed_at = NULL WHERE run_id = ?`,
      )
      .run(handle1.id);
    rawDb.close();

    // Shut down first adapter
    await adapter1.shutdown();

    // === Second adapter instance: recovery should pick up the run ===
    const adapter2 = createSqliteAdapter({ path: dbPath, concurrency: 2 });
    const runtime2 = createOrchestrationRuntime({
      adapter: adapter2,
      tasks: [step1Task, step2Task],
      workflows: [workflow],
    });

    await adapter2.start();

    // Poll until the run reaches a terminal state (recovery runs asynchronously)
    let recovered: { status: string } | null = null;
    for (let i = 0; i < 50; i++) {
      recovered = await runtime2.getRun(handle1.id);
      if (recovered?.status === 'completed' || recovered?.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    expect(recovered?.status).toBe('completed');
    // Steps should have been re-executed during recovery
    expect(step1Executions).toBeGreaterThanOrEqual(1);
    expect(step2Executions).toBeGreaterThanOrEqual(1);

    await adapter2.shutdown();
  });

  sqliteTest('preserves step attempt count across crash recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-recovery-attempts-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'attempts.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    let callCount = 0;
    const retryTask = defineTask({
      name: 'attempt-recovery-task',
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      retry: { maxAttempts: 3, delayMs: 10 },
      async handler() {
        callCount += 1;
        return { done: true };
      },
    });

    const workflow = defineWorkflow({
      name: 'attempt-recovery-workflow',
      input: z.object({}),
      steps: [step('retry-step', retryTask)],
    });

    // First run: complete the workflow
    const adapter1 = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime1 = createOrchestrationRuntime({
      adapter: adapter1,
      tasks: [retryTask],
      workflows: [workflow],
    });

    await adapter1.start();
    const handle = await runtime1.runWorkflow(workflow, {});
    await handle.result();

    const run1 = await runtime1.getRun(handle.id);
    expect(run1?.status).toBe('completed');

    // Simulate crash: reset run to running
    const Database = (await import('better-sqlite3')).default;
    const rawDb = new Database(dbPath);
    rawDb.pragma('journal_mode = WAL');
    rawDb
      .prepare(`UPDATE orchestration_runs SET status = 'running', completed_at = NULL WHERE id = ?`)
      .run(handle.id);
    // Persist the step with attempts=2 so we can verify it's preserved
    rawDb
      .prepare(
        `UPDATE orchestration_steps SET status = 'running', attempts = 2, completed_at = NULL WHERE run_id = ?`,
      )
      .run(handle.id);
    rawDb.close();

    callCount = 0;
    await adapter1.shutdown();

    // Second adapter: recovery
    const adapter2 = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtime2 = createOrchestrationRuntime({
      adapter: adapter2,
      tasks: [retryTask],
      workflows: [workflow],
    });
    await adapter2.start();

    // Wait for recovery
    let recovered: { status: string } | null = null;
    for (let i = 0; i < 50; i++) {
      recovered = await runtime2.getRun(handle.id);
      if (recovered?.status === 'completed' || recovered?.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    expect(recovered?.status).toBe('completed');

    // The step's attempt count in the DB should be > 2 (preserved + new attempt)
    const finalRun = await runtime2.getRun(handle.id);
    const workflowRun = finalRun as { steps?: Record<string, { attempts: number }> };
    const stepAttempts = workflowRun?.steps?.['retry-step']?.attempts ?? 0;
    expect(stepAttempts).toBeGreaterThanOrEqual(3);

    await adapter2.shutdown();
  });
});
