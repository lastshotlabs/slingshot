import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTemporalOrchestrationAdapter } from '../../packages/slingshot-orchestration-temporal/src/adapter';
import { createTemporalOrchestrationWorker } from '../../packages/slingshot-orchestration-temporal/src/worker';
import {
  type AnyResolvedTask,
  type AnyResolvedWorkflow,
  createOrchestrationRuntime,
} from '../../packages/slingshot-orchestration/src/index';
import { createTemporalOrchestrationWorkerFromManifest } from '../../src/lib/createTemporalOrchestrationWorkerFromManifest';

const TEMPORAL_ADDRESS = process.env.TEST_TEMPORAL_ADDRESS ?? 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEST_TEMPORAL_NAMESPACE ?? 'default';
const FIXTURE_PATH = resolve(process.cwd(), 'tests/node-docker/fixtures/temporal-definitions.ts');
const MANIFEST_FIXTURE_PATH = resolve(
  process.cwd(),
  'tests/node-docker/fixtures/temporal-manifest-handlers.ts',
);

function uniqueName(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function waitFor<T>(
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await callback();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
}

interface TemporalFixtureModule {
  retryingEmailTaskExport: AnyResolvedTask;
  formatProfileTaskExport: AnyResolvedTask;
  pauseTaskExport: AnyResolvedTask;
  onboardingWorkflowExport: AnyResolvedWorkflow;
  resetTemporalHookLog(): void;
  readTemporalHookLog(): Array<{ hook: string; runId: string; workflow: string }>;
}

async function importFixtureModule(): Promise<TemporalFixtureModule> {
  return (await import(pathToFileURL(FIXTURE_PATH).href)) as TemporalFixtureModule;
}

async function startSupervisor(supervisor: {
  run(): Promise<void>;
  shutdown(): Promise<void>;
}): Promise<() => Promise<void>> {
  let failure: unknown;
  const runPromise = supervisor.run().catch(error => {
    failure = error;
  });

  await new Promise(resolvePromise => setTimeout(resolvePromise, 300));

  return async () => {
    await supervisor.shutdown();
    await runPromise;
    if (failure) {
      throw failure;
    }
  };
}

describe('Temporal orchestration integration (docker)', () => {
  let clientConnection: Connection;

  beforeAll(async () => {
    clientConnection = await Connection.connect({
      address: TEMPORAL_ADDRESS,
    });
  });

  afterAll(async () => {
    await clientConnection.close();
  });

  let tempDir = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'slingshot-temporal-docker-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      tempDir = '';
    }
  });

  it('runs live task and workflow executions with retries, progress, observability, schedules, events, and hooks', async () => {
    const fixture = await importFixtureModule();
    fixture.resetTemporalHookLog();

    const nativeConnection = await NativeConnection.connect({
      address: TEMPORAL_ADDRESS,
    });

    const eventLog: Array<{ name: string; payload: unknown }> = [];
    const workflowTaskQueue = uniqueName('slingshot-temporal-workflows');
    const buildId = uniqueName('slingshot-build');

    const supervisor = await createTemporalOrchestrationWorker({
      connection: nativeConnection,
      ownsConnection: true,
      namespace: TEMPORAL_NAMESPACE,
      workflowTaskQueue,
      buildId,
      definitionsModulePath: FIXTURE_PATH,
      eventSink: {
        async emit(name, payload) {
          eventLog.push({ name, payload });
        },
      },
    });
    const stopWorker = await startSupervisor(supervisor);

    const adapter = createTemporalOrchestrationAdapter({
      client: new Client({
        connection: clientConnection,
        namespace: TEMPORAL_NAMESPACE,
      }),
      connection: clientConnection,
      namespace: TEMPORAL_NAMESPACE,
      workflowTaskQueue,
    });

    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [
        fixture.retryingEmailTaskExport,
        fixture.formatProfileTaskExport,
        fixture.pauseTaskExport,
      ],
      workflows: [fixture.onboardingWorkflowExport],
    });

    await adapter.start();

    try {
      const taskProgress: Array<Record<string, unknown> | undefined> = [];
      const taskHandle = await runtime.runTask(
        fixture.retryingEmailTaskExport,
        { email: 'task@example.com' },
        {
          tenantId: 'tenant-temporal',
          priority: 7,
          tags: {
            suite: 'temporal',
            mode: 'task',
          },
          metadata: {
            source: 'docker-test',
          },
        },
      );
      const stopTaskProgress = runtime.onProgress(taskHandle.id, progress => {
        taskProgress.push(progress as Record<string, unknown> | undefined);
      });

      await expect(taskHandle.result()).resolves.toEqual({
        email: 'task@example.com',
        attempt: 2,
      });
      stopTaskProgress();

      const completedTaskRun = await waitFor(
        () => runtime.getRun(taskHandle.id),
        run => run?.status === 'completed',
      );
      expect(completedTaskRun?.progress).toMatchObject({ percent: 100, message: 'sent' });
      expect(completedTaskRun?.priority).toBe(7);
      expect(completedTaskRun?.tags).toEqual({
        suite: 'temporal',
        mode: 'task',
      });
      expect(taskProgress.length).toBeGreaterThan(0);
      expect(taskProgress.some(progress => progress?.percent === 50)).toBe(true);

      await expect(runtime.signal(taskHandle.id, 'unsupported')).rejects.toMatchObject({
        code: 'CAPABILITY_NOT_SUPPORTED',
      });

      const workflowProgress: Array<Record<string, unknown> | undefined> = [];
      const workflowHandle = await runtime.runWorkflow(
        fixture.onboardingWorkflowExport,
        {
          email: 'workflow@example.com',
          firstName: 'Ada',
          lastName: 'Lovelace',
        },
        {
          tenantId: 'tenant-temporal',
          priority: 9,
          tags: {
            suite: 'temporal',
            mode: 'workflow',
          },
        },
      );
      const stopWorkflowProgress = runtime.onProgress(workflowHandle.id, progress => {
        workflowProgress.push(progress as Record<string, unknown> | undefined);
      });

      await expect(
        runtime.signal(workflowHandle.id, 'user-approval', { approved: true }),
      ).resolves.toBeUndefined();
      await expect(workflowHandle.result()).resolves.toEqual({
        emailAttempt: 2,
        fullName: 'Ada Lovelace',
        pauseLabel: 'resumed',
      });
      stopWorkflowProgress();

      const completedWorkflowRun = await waitFor(
        () => runtime.getRun(workflowHandle.id),
        run => run?.status === 'completed',
      );
      expect(completedWorkflowRun?.priority).toBe(9);
      expect(completedWorkflowRun?.tags).toEqual({
        suite: 'temporal',
        mode: 'workflow',
      });
      expect(completedWorkflowRun?.type).toBe('workflow');
      expect(workflowProgress.some(progress => progress?.percent === 50)).toBe(true);
      expect(workflowProgress.some(progress => progress?.percent === 100)).toBe(true);

      if (!completedWorkflowRun || completedWorkflowRun.type !== 'workflow') {
        throw new Error('Expected completed workflow run');
      }

      expect(completedWorkflowRun.steps?.['retry-email-step']).toMatchObject({
        status: 'completed',
        attempts: 2,
      });
      expect(completedWorkflowRun.steps?.['format-profile-step']).toMatchObject({
        status: 'completed',
        attempts: 1,
      });
      expect(completedWorkflowRun.steps?.['workflow-pause']).toMatchObject({
        status: 'completed',
      });

      const listedWorkflowRuns = await runtime.listRuns({
        tenantId: 'tenant-temporal',
        type: 'workflow',
        tags: {
          suite: 'temporal',
          mode: 'workflow',
        },
      });
      expect(listedWorkflowRuns.total).toBeGreaterThanOrEqual(1);
      expect(listedWorkflowRuns.runs.some(run => run.id === workflowHandle.id)).toBe(true);

      const schedule = await runtime.schedule(
        { type: 'task', name: fixture.retryingEmailTaskExport.name },
        '0 0 1 1 *',
        { email: 'scheduled@example.com' },
      );
      const schedules = await runtime.listSchedules();
      expect(schedules.some(item => item.id === schedule.id)).toBe(true);
      await runtime.unschedule(schedule.id);
      const schedulesAfterDelete = await runtime.listSchedules();
      expect(schedulesAfterDelete.some(item => item.id === schedule.id)).toBe(false);

      const hookLog = fixture.readTemporalHookLog();
      expect(hookLog).toEqual(
        expect.arrayContaining([
          {
            hook: 'onStart',
            runId: workflowHandle.id,
            workflow: 'onboard-user',
          },
          {
            hook: 'onComplete',
            runId: workflowHandle.id,
            workflow: 'onboard-user',
          },
        ]),
      );

      expect(eventLog.map(event => event.name)).toEqual(
        expect.arrayContaining([
          'orchestration.task.started',
          'orchestration.task.progress',
          'orchestration.task.completed',
          'orchestration.workflow.started',
          'orchestration.step.completed',
          'orchestration.workflow.completed',
        ]),
      );
    } finally {
      await adapter.shutdown();
      await stopWorker();
    }
  }, 45_000);

  it('boots a Temporal worker from manifest config and executes exported orchestration definitions', async () => {
    const fixture = await importFixtureModule();
    fixture.resetTemporalHookLog();

    const workflowTaskQueue = uniqueName('slingshot-manifest-workflows');
    const buildId = uniqueName('slingshot-manifest-build');
    const manifestPath = join(tempDir, 'app.manifest.json');

    const manifest = {
      manifestVersion: 1,
      handlers: MANIFEST_FIXTURE_PATH.replaceAll('\\', '/'),
      plugins: [
        {
          plugin: 'slingshot-orchestration',
          config: {
            adapter: {
              type: 'temporal',
              config: {
                address: TEMPORAL_ADDRESS,
                namespace: TEMPORAL_NAMESPACE,
                workflowTaskQueue,
                worker: {
                  buildId,
                },
              },
            },
            tasks: [
              fixture.retryingEmailTaskExport.name,
              fixture.formatProfileTaskExport.name,
              fixture.pauseTaskExport.name,
            ],
            workflows: [fixture.onboardingWorkflowExport.name],
            routes: false,
          },
        },
      ],
    };

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const dryRunPlan = await createTemporalOrchestrationWorkerFromManifest(manifestPath, {
      dryRun: true,
    });
    expect(dryRunPlan.buildId).toBe(buildId);
    expect(dryRunPlan.workflowTaskQueue).toBe(workflowTaskQueue);
    expect(dryRunPlan.definitionsModulePath).toBe(resolve(MANIFEST_FIXTURE_PATH));
    expect(dryRunPlan.workflowNames).toEqual([fixture.onboardingWorkflowExport.name]);
    expect(dryRunPlan.activityTaskQueues).toContain('email-activities');

    const livePlan = await createTemporalOrchestrationWorkerFromManifest(manifestPath);
    if (!livePlan.worker) {
      throw new Error('Expected manifest worker bootstrap to create a worker.');
    }

    const stopWorker = await startSupervisor(livePlan.worker);
    const adapter = createTemporalOrchestrationAdapter({
      client: new Client({
        connection: clientConnection,
        namespace: TEMPORAL_NAMESPACE,
      }),
      connection: clientConnection,
      namespace: TEMPORAL_NAMESPACE,
      workflowTaskQueue,
    });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [
        fixture.retryingEmailTaskExport,
        fixture.formatProfileTaskExport,
        fixture.pauseTaskExport,
      ],
      workflows: [fixture.onboardingWorkflowExport],
    });

    await adapter.start();

    try {
      const handle = await runtime.runWorkflow(
        fixture.onboardingWorkflowExport,
        {
          email: 'manifest@example.com',
          firstName: 'Grace',
          lastName: 'Hopper',
        },
        {
          tenantId: 'tenant-manifest',
          tags: {
            suite: 'manifest',
          },
        },
      );

      await expect(handle.result()).resolves.toEqual({
        emailAttempt: 2,
        fullName: 'Grace Hopper',
        pauseLabel: 'resumed',
      });

      const run = await waitFor(
        () => runtime.getRun(handle.id),
        value => value?.status === 'completed',
      );
      expect(run?.status).toBe('completed');
      expect(run?.tags).toEqual({ suite: 'manifest' });
    } finally {
      await adapter.shutdown();
      await stopWorker();
    }
  }, 45_000);
});
