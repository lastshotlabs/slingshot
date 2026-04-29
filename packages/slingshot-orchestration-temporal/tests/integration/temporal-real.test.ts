/**
 * Integration tests against a real Temporal server (P-TEMPORAL-1, P-TEMPORAL-2).
 *
 * These tests require a Temporal Test Environment which spins up an in-process
 * Java dev server. Set `TEMPORAL_TEST_ENV=1` to run them. Without the env var
 * the suite is skipped so package-default `bun test` stays hermetic.
 *
 * To run locally:
 *   TEMPORAL_TEST_ENV=1 bun test packages/slingshot-orchestration-temporal/tests/integration
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type AnyResolvedTask,
  type AnyResolvedWorkflow,
  defineTask,
  defineWorkflow,
  step,
} from '@lastshotlabs/slingshot-orchestration';

const REAL_TEMPORAL_ENABLED = process.env['TEMPORAL_TEST_ENV'] === '1';
const itReal = REAL_TEMPORAL_ENABLED ? test : test.skip;

// We import Temporal SDK pieces lazily inside the describe block so the
// package suite that runs without TEMPORAL_TEST_ENV does not have to load the
// full Temporal worker bridge — that would slow startup and pull in native
// dependencies just to skip the suite.

interface TestEnv {
  shutdown(): Promise<void>;
  taskQueue: string;
  client: import('@temporalio/client').Client;
  connection: import('@temporalio/client').Connection;
  nativeConnection: import('@temporalio/worker').NativeConnection;
  worker: import('@temporalio/worker').Worker;
  workerPromise: Promise<void>;
  tasks: AnyResolvedTask[];
  workflows: AnyResolvedWorkflow[];
}

let env: TestEnv | null = null;

const echoTask = defineTask({
  name: 'temporal-echo-task',
  input: z.object({ value: z.string() }),
  output: z.object({ echoed: z.string() }),
  async handler(input) {
    return { echoed: input.value };
  },
});

const greetWorkflow = defineWorkflow({
  name: 'temporal-greet-workflow',
  input: z.object({ value: z.string() }),
  steps: [step('greet', echoTask)],
});

beforeAll(async () => {
  if (!REAL_TEMPORAL_ENABLED) return;

  const { TestWorkflowEnvironment } = await import('@temporalio/testing');
  const { Worker } = await import('@temporalio/worker');
  const path = await import('node:path');

  const testEnv = await TestWorkflowEnvironment.createLocal();
  const taskQueue = `slingshot-test-${Date.now()}`;

  // The worker must be configured with our generated workflow module and the
  // task activities. The package's worker supervisor handles the standard
  // bootstrap; for this targeted integration test we use the lower-level
  // Worker API directly so we can keep the test self-contained.
  const { createTemporalActivities } = await import('../../src/activities');
  const { installWorkerRegistries } = await import('../../src/workerRegistry');

  installWorkerRegistries({
    tasks: [echoTask],
    workflows: [greetWorkflow],
  });

  const activities = createTemporalActivities({
    connection: testEnv.nativeConnection,
  });

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue,
    workflowsPath: path.resolve(__dirname, '../fixtures/workflowsModule.ts'),
    activities,
  });

  const workerPromise = worker.run();

  env = {
    async shutdown() {
      worker.shutdown();
      await workerPromise.catch(() => undefined);
      await testEnv.teardown();
    },
    taskQueue,
    client: testEnv.client,
    connection: testEnv.connection,
    nativeConnection: testEnv.nativeConnection,
    worker,
    workerPromise,
    tasks: [echoTask],
    workflows: [greetWorkflow],
  };
}, 60_000);

afterAll(async () => {
  if (env) {
    await env.shutdown();
    env = null;
  }
});

describe('temporal real-server integration (P-TEMPORAL-1)', () => {
  itReal(
    'runTask: starts a task workflow and surfaces the result',
    async () => {
      const { createTemporalOrchestrationAdapter } = await import('../../src/adapter');
      const adapter = createTemporalOrchestrationAdapter({
        client: env!.client,
        connection: env!.connection,
        workflowTaskQueue: env!.taskQueue,
      });
      adapter.registerTask(echoTask);

      const handle = await adapter.runTask(echoTask.name, { value: 'hello' });
      const result = (await handle.result()) as { echoed: string };
      expect(result.echoed).toBe('hello');

      const run = await adapter.getRun(handle.id);
      expect(run?.status).toBe('completed');
    },
    60_000,
  );

  itReal(
    'runWorkflow: starts a workflow and surfaces the workflow result',
    async () => {
      const { createTemporalOrchestrationAdapter } = await import('../../src/adapter');
      const adapter = createTemporalOrchestrationAdapter({
        client: env!.client,
        connection: env!.connection,
        workflowTaskQueue: env!.taskQueue,
      });
      adapter.registerTask(echoTask);
      adapter.registerWorkflow(greetWorkflow);

      const handle = await adapter.runWorkflow(greetWorkflow.name, { value: 'world' });
      const out = (await handle.result()) as Record<string, unknown>;
      expect(out['greet']).toEqual({ echoed: 'world' });

      const run = await adapter.getRun(handle.id);
      expect(run?.status).toBe('completed');
    },
    60_000,
  );

  itReal(
    'getRun returns null for unknown ids',
    async () => {
      const { createTemporalOrchestrationAdapter } = await import('../../src/adapter');
      const adapter = createTemporalOrchestrationAdapter({
        client: env!.client,
        connection: env!.connection,
        workflowTaskQueue: env!.taskQueue,
      });
      const run = await adapter.getRun('does-not-exist-' + Date.now());
      expect(run).toBeNull();
    },
    30_000,
  );

  itReal(
    'listRuns returns runs by tenantId',
    async () => {
      const { createTemporalOrchestrationAdapter } = await import('../../src/adapter');
      const adapter = createTemporalOrchestrationAdapter({
        client: env!.client,
        connection: env!.connection,
        workflowTaskQueue: env!.taskQueue,
      });
      adapter.registerTask(echoTask);
      const handle = await adapter.runTask(
        echoTask.name,
        { value: 'tenant-a' },
        { tenantId: 'tenant-a' },
      );
      await handle.result();

      const listed = await adapter.listRuns({ tenantId: 'tenant-a' });
      expect(listed.runs.length).toBeGreaterThan(0);
    },
    60_000,
  );

  itReal(
    'cancel: aborts an in-flight workflow',
    async () => {
      const longTask = defineTask({
        name: 'temporal-long-task',
        input: z.object({}),
        output: z.object({}),
        async handler(_input, ctx) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 30_000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('cancelled'));
            });
          });
          return {};
        },
      });
      const registryMod = await import('../../src/workerRegistry');
      registryMod.clearWorkerRegistries();
      registryMod.installWorkerRegistries({
        tasks: [echoTask, longTask],
        workflows: [greetWorkflow],
      } as never);

      const { createTemporalOrchestrationAdapter } = await import('../../src/adapter');
      const adapter = createTemporalOrchestrationAdapter({
        client: env!.client,
        connection: env!.connection,
        workflowTaskQueue: env!.taskQueue,
      });
      adapter.registerTask(longTask);

      const handle = await adapter.runTask(longTask.name, {});
      await new Promise(r => setTimeout(r, 200));
      await adapter.cancelRun(handle.id);

      // Result should reject — cancellation surfaces as a run failure.
      await expect(handle.result()).rejects.toThrow();
    },
    60_000,
  );
});
