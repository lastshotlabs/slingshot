// packages/slingshot-orchestration/tests/concurrency-stress.test.ts
//
// Stress tests for concurrent execution: multiple simultaneous task runs,
// concurrent workflow starts, and idempotency races. These tests verify
// that the adapter and runtime handle parallelism without data corruption.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createMemoryAdapter } from '../src/adapters/memory';
import { defineTask } from '../src/defineTask';
import { defineWorkflow, step } from '../src/defineWorkflow';
import { createOrchestrationRuntime } from '../src/runtime';

// ---------------------------------------------------------------------------
// Probe SQLite availability for the SQLite variants
// ---------------------------------------------------------------------------
const sqliteModule = await import('../src/adapters/sqlite').catch(() => null);
let sqliteAvailable = false;
if (sqliteModule) {
  const probeDir = mkdtempSync(join(tmpdir(), 'slingshot-orch-stress-probe-'));
  try {
    const adapter = sqliteModule.createSqliteAdapter({
      path: join(probeDir, 'probe.sqlite'),
      concurrency: 1,
    });
    await adapter.shutdown();
    sqliteAvailable = true;
  } catch {
    sqliteAvailable = false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}
const sqliteTest = sqliteAvailable ? test : test.skip;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const incrementTask = defineTask({
  name: 'increment-task',
  input: z.object({ start: z.number() }),
  output: z.object({ value: z.number() }),
  async handler(input) {
    // Simulate a small amount of work
    await new Promise(r => setTimeout(r, 1));
    return { value: input.start + 1 };
  },
});

const identityTask = defineTask({
  name: 'identity-task',
  input: z.object({ value: z.string() }),
  output: z.object({ echoed: z.string() }),
  async handler(input) {
    return { echoed: input.value };
  },
});

describe('memory adapter — concurrent task execution stress', () => {
  test('runs 50 concurrent tasks without error', async () => {
    const adapter = createMemoryAdapter({ concurrency: 20 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [incrementTask],
    });

    const handles = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        runtime.runTask(incrementTask, { start: i }),
      ),
    );

    const results = await Promise.all(handles.map(h => h.result()));
    const values = results.map(r => (r as { value: number }).value);
    values.sort((a, b) => a - b);

    // Each result should be start+1
    for (let i = 0; i < 50; i++) {
      expect(values[i]).toBe(i + 1);
    }

    const allRuns = await adapter.listRuns({});
    expect(allRuns.total).toBe(50);

    await adapter.shutdown();
  });

  test('concurrent idempotent task calls produce exactly one execution', async () => {
    let executions = 0;
    const expensiveTask = defineTask({
      name: 'expensive-task',
      input: z.object({}),
      output: z.object({ executed: z.boolean() }),
      async handler() {
        executions += 1;
        await new Promise(r => setTimeout(r, 5));
        return { executed: true };
      },
    });

    const adapter = createMemoryAdapter({ concurrency: 10 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [expensiveTask],
    });

    const CONCURRENCY = 20;
    const handles = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        runtime.runTask(expensiveTask, {}, { idempotencyKey: 'single-run-key' }),
      ),
    );

    // All handles must have the same run ID
    const ids = new Set(handles.map(h => h.id));
    expect(ids.size).toBe(1);

    const results = await Promise.all(handles.map(h => h.result()));
    expect(new Set(results.map(r => (r as { executed: boolean }).executed)).size).toBe(1);
    expect(executions).toBe(1);

    await adapter.shutdown();
  });

  test('concurrent tasks with different idempotency keys all execute', async () => {
    const adapter = createMemoryAdapter({ concurrency: 20 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [identityTask],
    });

    const CONCURRENCY = 30;
    const handles = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        runtime.runTask(
          identityTask,
          { value: `msg-${i}` },
          { idempotencyKey: `key-${i}` },
        ),
      ),
    );

    const ids = new Set(handles.map(h => h.id));
    expect(ids.size).toBe(CONCURRENCY);

    const results = await Promise.all(handles.map(h => h.result()));
    const values = results.map(r => (r as { echoed: string }).echoed)
      .sort((a, b) => {
        const numA = parseInt(a.replace('msg-', ''), 10);
        const numB = parseInt(b.replace('msg-', ''), 10);
        return numA - numB;
      });
    expect(values).toHaveLength(CONCURRENCY);
    expect(values[0]).toBe('msg-0');
    expect(values[CONCURRENCY - 1]).toBe(`msg-${CONCURRENCY - 1}`);

    await adapter.shutdown();
  });

  test('concurrent workflow executions run without interference', async () => {
    const task = defineTask({
      name: 'concurrent-wf-task',
      input: z.object({ id: z.number() }),
      output: z.object({ id: z.number() }),
      async handler(input) {
        await new Promise(r => setTimeout(r, 1));
        return { id: input.id };
      },
    });

    const workflow = defineWorkflow({
      name: 'concurrent-wf',
      input: z.object({ id: z.number() }),
      steps: [step('step-one', task)],
    });

    const adapter = createMemoryAdapter({ concurrency: 20 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [task],
      workflows: [workflow],
    });

    const CONCURRENCY = 20;
    const handles = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        runtime.runWorkflow(workflow, { id: i }),
      ),
    );

    const results = await Promise.all(handles.map(h => h.result()));
    // Each workflow result should contain the step output with the correct id
    for (let i = 0; i < CONCURRENCY; i++) {
      const stepResult = (results[i] as Record<string, unknown>)['step-one'] as { id: number };
      expect(stepResult.id).toBe(i);
    }

    const allRuns = await adapter.listRuns({ type: 'workflow' });
    expect(allRuns.total).toBe(CONCURRENCY);

    await adapter.shutdown();
  });
});

describe('memory adapter — interleaved task and workflow stress', () => {
  test('interleaves tasks and workflows without data corruption', async () => {
    const task = defineTask({
      name: 'interleave-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return { value: input.value };
      },
    });

    const workflow = defineWorkflow({
      name: 'interleave-wf',
      input: z.object({ label: z.string() }),
      steps: [
        step('echo', task, {
          // Map workflow input shape { label } to task input shape { value }
          input: ctx => ({ value: ctx.workflowInput.label }),
        }),
      ],
    });

    const adapter = createMemoryAdapter({ concurrency: 10 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [task],
      workflows: [workflow],
    });

    // Launch a mix of tasks and workflows concurrently
    const COUNT = 15;
    const handles = await Promise.all([
      ...Array.from({ length: COUNT }, (_, i) =>
        runtime.runTask(task, { value: `task-${i}` }),
      ),
      ...Array.from({ length: COUNT }, (_, i) =>
        runtime.runWorkflow(workflow, { label: `wf-${i}` }),
      ),
    ]);

    const results = await Promise.all(handles.map(h => h.result()));

    // Total runs should be 2 * COUNT
    const allRuns = await adapter.listRuns({});
    expect(allRuns.total).toBe(2 * COUNT);

    // Task results should be strings, workflow results should be objects with an echo step
    let taskCount = 0;
    let wfCount = 0;
    for (const r of results) {
      if (typeof r === 'object' && r !== null && 'value' in r) {
        taskCount++;
      } else if (typeof r === 'object' && r !== null && 'echo' in (r as Record<string, unknown>)) {
        wfCount++;
      }
    }
    expect(taskCount).toBe(COUNT);
    expect(wfCount).toBe(COUNT);

    await adapter.shutdown();
  });
});

describe('sqlite adapter — concurrent task execution stress', () => {
  sqliteTest('runs 30 concurrent tasks without error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-stress-sqlite-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'stress.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 10 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [incrementTask],
    });
    await adapter.start();

    const handles = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        runtime.runTask(incrementTask, { start: i }),
      ),
    );

    const results = await Promise.all(handles.map(h => h.result()));
    const values = results.map(r => (r as { value: number }).value).sort((a, b) => a - b);
    for (let i = 0; i < 30; i++) {
      expect(values[i]).toBe(i + 1);
    }

    const allRuns = await adapter.listRuns({});
    expect(allRuns.total).toBe(30);

    await adapter.shutdown();
  });

  sqliteTest('concurrent idempotent task calls with SQLite produce exactly one execution', async () => {
    let executions = 0;
    const expensiveTask = defineTask({
      name: 'sqlite-stress-expensive',
      input: z.object({}),
      output: z.object({ executed: z.boolean() }),
      async handler() {
        executions += 1;
        await new Promise(r => setTimeout(r, 5));
        return { executed: true };
      },
    });

    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-stress-sqlite-idem-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'idem.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 10 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [expensiveTask],
    });
    await adapter.start();

    const CONCURRENCY = 15;
    const handles = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        runtime.runTask(expensiveTask, {}, { idempotencyKey: 'stress-single-key' }),
      ),
    );

    const ids = new Set(handles.map(h => h.id));
    expect(ids.size).toBe(1);
    expect(executions).toBe(1);

    await adapter.shutdown();
  });

  sqliteTest('concurrent workflow executions with SQLite run without interference', async () => {
    const task = defineTask({
      name: 'sqlite-stress-wf-task',
      input: z.object({ id: z.number() }),
      output: z.object({ id: z.number() }),
      async handler(input) {
        await new Promise(r => setTimeout(r, 1));
        return { id: input.id };
      },
    });

    const workflow = defineWorkflow({
      name: 'sqlite-stress-wf',
      input: z.object({ id: z.number() }),
      steps: [step('identify', task)],
    });

    const dir = mkdtempSync(join(tmpdir(), 'slingshot-orch-stress-sqlite-wf-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'wf.sqlite');
    const { createSqliteAdapter } = sqliteModule!;

    const adapter = createSqliteAdapter({ path: dbPath, concurrency: 10 });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [task],
      workflows: [workflow],
    });
    await adapter.start();

    const CONCURRENCY = 10;
    const handles = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        runtime.runWorkflow(workflow, { id: i }),
      ),
    );

    const results = await Promise.all(handles.map(h => h.result()));
    for (let i = 0; i < CONCURRENCY; i++) {
      const stepResult = (results[i] as Record<string, unknown>)['identify'] as { id: number };
      expect(stepResult.id).toBe(i);
    }

    await adapter.shutdown();
  });
});
