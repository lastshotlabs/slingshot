import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createOrchestrationRuntime,
  createSqliteAdapter,
  defineTask,
  defineWorkflow,
  step,
} from '../../packages/slingshot-orchestration/src/index.ts';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'slingshot-orchestration-node-'));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    tempDir = '';
  }
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe('orchestration sqlite adapter (node runtime)', () => {
  it('runs tasks, persists progress, and dedupes idempotent submissions', async () => {
    const adapter = createSqliteAdapter({
      path: join(tempDir, 'orchestration.sqlite'),
      concurrency: 1,
    });

    const echoTask = defineTask({
      name: 'sqlite-task',
      input: z.object({ value: z.string() }),
      output: z.object({ echoed: z.string() }),
      async handler(input, ctx) {
        ctx.reportProgress({ percent: 100, message: 'done' });
        return { echoed: input.value };
      },
    });

    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [echoTask],
    });

    await adapter.start();

    const first = await runtime.runTask(
      echoTask,
      { value: 'sqlite' },
      {
        tenantId: 'tenant-sqlite',
        idempotencyKey: 'task:sqlite',
      },
    );
    const second = await runtime.runTask(
      echoTask,
      { value: 'ignored' },
      {
        tenantId: 'tenant-sqlite',
        idempotencyKey: 'task:sqlite',
      },
    );
    const otherTenant = await runtime.runTask(
      echoTask,
      { value: 'other-tenant' },
      {
        tenantId: 'tenant-other',
        idempotencyKey: 'task:sqlite',
      },
    );

    expect(second.id).toBe(first.id);
    expect(otherTenant.id).not.toBe(first.id);
    await expect(first.result()).resolves.toEqual({ echoed: 'sqlite' });
    await expect(otherTenant.result()).resolves.toEqual({ echoed: 'other-tenant' });

    const run = await runtime.getRun(first.id);
    expect(run?.status).toBe('completed');
    expect(run?.tenantId).toBe('tenant-sqlite');
    expect(run?.progress).toEqual({ percent: 100, message: 'done' });

    const listed = await runtime.listRuns({ tenantId: 'tenant-sqlite' });
    expect(listed.total).toBe(1);
    expect(listed.runs[0]?.id).toBe(first.id);

    const otherTenantRuns = await runtime.listRuns({ tenantId: 'tenant-other' });
    expect(otherTenantRuns.total).toBe(1);
    expect(otherTenantRuns.runs[0]?.id).toBe(otherTenant.id);

    await adapter.shutdown();
  });

  it('does not re-scope already migrated idempotency keys after restart', async () => {
    const dbPath = join(tempDir, 'idempotency-restart.sqlite');
    const scopedKey = 'orch-idem:task:sqlite-restart-task:tenant-a:quote-123';
    const echoTask = defineTask({
      name: 'sqlite-restart-task',
      input: z.object({ value: z.string() }),
      output: z.object({ echoed: z.string() }),
      async handler(input) {
        return { echoed: input.value };
      },
    });

    const adapterA = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtimeA = createOrchestrationRuntime({
      adapter: adapterA,
      tasks: [echoTask],
    });

    const first = await runtimeA.runTask(
      echoTask,
      { value: 'first' },
      { tenantId: 'tenant-a', idempotencyKey: 'quote-123' },
    );
    await expect(first.result()).resolves.toEqual({ echoed: 'first' });

    const beforeRestartDb = new Database(dbPath, { readonly: true });
    expect(
      beforeRestartDb
        .prepare('select id, idempotency_key from orchestration_runs order by created_at asc')
        .all(),
    ).toEqual([{ id: first.id, idempotency_key: scopedKey }]);
    beforeRestartDb.close();

    await adapterA.shutdown();

    const adapterB = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtimeB = createOrchestrationRuntime({
      adapter: adapterB,
      tasks: [echoTask],
    });

    const afterRestartDb = new Database(dbPath, { readonly: true });
    expect(
      afterRestartDb
        .prepare('select id, idempotency_key from orchestration_runs order by created_at asc')
        .all(),
    ).toEqual([{ id: first.id, idempotency_key: scopedKey }]);
    afterRestartDb.close();

    const replay = await runtimeB.runTask(
      echoTask,
      { value: 'ignored' },
      { tenantId: 'tenant-a', idempotencyKey: 'quote-123' },
    );

    const afterReplayDb = new Database(dbPath, { readonly: true });
    expect(
      afterReplayDb
        .prepare('select id, idempotency_key from orchestration_runs order by created_at asc')
        .all(),
    ).toEqual([{ id: first.id, idempotency_key: scopedKey }]);
    afterReplayDb.close();

    await expect(replay.result()).resolves.toEqual({ echoed: 'first' });

    await adapterB.shutdown();
  });

  it('recovers delayed workflows after adapter restart', async () => {
    const dbPath = join(tempDir, 'recovery.sqlite');
    const processOrder = defineTask({
      name: 'process-order',
      input: z.object({ orderId: z.string() }),
      output: z.object({ processed: z.boolean(), orderId: z.string() }),
      async handler(input) {
        return { processed: true, orderId: input.orderId };
      },
    });

    const orderWorkflow = defineWorkflow({
      name: 'recover-workflow',
      input: z.object({ orderId: z.string() }),
      output: z.object({
        step: z.object({ processed: z.boolean(), orderId: z.string() }),
      }),
      outputMapper(results) {
        return {
          step: results['process-order-step'] as { processed: boolean; orderId: string },
        };
      },
      steps: [
        step('process-order-step', processOrder, {
          input: ({ workflowInput }: { workflowInput: { orderId: string } }) => workflowInput,
        }),
      ],
    });

    const adapterA = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtimeA = createOrchestrationRuntime({
      adapter: adapterA,
      tasks: [processOrder],
      workflows: [orderWorkflow],
    });

    await adapterA.start();
    const handle = await runtimeA.runWorkflow(
      orderWorkflow,
      { orderId: 'ord_123' },
      { delay: 200 },
    );
    void handle.result().catch(() => undefined);
    await adapterA.shutdown();

    const adapterB = createSqliteAdapter({ path: dbPath, concurrency: 1 });
    const runtimeB = createOrchestrationRuntime({
      adapter: adapterB,
      tasks: [processOrder],
      workflows: [orderWorkflow],
    });

    await adapterB.start();

    await waitFor(async () => {
      const run = await runtimeB.getRun(handle.id);
      return run?.status === 'completed';
    });

    const run = await runtimeB.getRun(handle.id);
    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({
      step: { processed: true, orderId: 'ord_123' },
    });

    await adapterB.shutdown();
  });

  it('recovers every delayed workflow across multiple recovery batches', async () => {
    const dbPath = join(tempDir, 'recovery-many.sqlite');
    const processOrder = defineTask({
      name: 'process-many-order',
      input: z.object({ orderId: z.string() }),
      output: z.object({ processed: z.boolean(), orderId: z.string() }),
      async handler(input) {
        return { processed: true, orderId: input.orderId };
      },
    });

    const orderWorkflow = defineWorkflow({
      name: 'recover-many-workflow',
      input: z.object({ orderId: z.string() }),
      output: z.object({
        step: z.object({ processed: z.boolean(), orderId: z.string() }),
      }),
      outputMapper(results) {
        return {
          step: results['process-many-order-step'] as { processed: boolean; orderId: string },
        };
      },
      steps: [
        step('process-many-order-step', processOrder, {
          input: ({ workflowInput }: { workflowInput: { orderId: string } }) => workflowInput,
        }),
      ],
    });

    const adapterA = createSqliteAdapter({ path: dbPath, concurrency: 8 });
    const runtimeA = createOrchestrationRuntime({
      adapter: adapterA,
      tasks: [processOrder],
      workflows: [orderWorkflow],
    });

    await adapterA.start();
    const handles = await Promise.all(
      Array.from({ length: 125 }, async (_, index) =>
        runtimeA.runWorkflow(orderWorkflow, { orderId: `ord_${index}` }, { delay: 200 }),
      ),
    );
    for (const handle of handles) {
      void handle.result().catch(() => undefined);
    }
    await adapterA.shutdown();

    const adapterB = createSqliteAdapter({ path: dbPath, concurrency: 8 });
    const runtimeB = createOrchestrationRuntime({
      adapter: adapterB,
      tasks: [processOrder],
      workflows: [orderWorkflow],
    });

    await adapterB.start();

    await waitFor(async () => {
      const runs = await Promise.all(handles.map(handle => runtimeB.getRun(handle.id)));
      return runs.every(run => run?.status === 'completed');
    }, 10_000);

    const runs = await Promise.all(handles.map(handle => runtimeB.getRun(handle.id)));
    expect(runs).toHaveLength(125);
    expect(runs.every(run => run?.status === 'completed')).toBe(true);

    await adapterB.shutdown();
  });
});
