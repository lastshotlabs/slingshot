import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, mock, test } from 'bun:test';

const createdWorkers: Array<{
  run: ReturnType<typeof mock>;
  shutdown: ReturnType<typeof mock>;
}> = [];
let workerCreateCalls = 0;

const workerCreateMock = mock(async (_options: Record<string, unknown>) => {
  workerCreateCalls += 1;
  if (workerCreateCalls === 2) {
    throw new Error('worker creation failed');
  }

  const worker = {
    run: mock(async () => {}),
    shutdown: mock(async () => {}),
  };

  createdWorkers.push(worker);
  return worker;
});

const installWorkerRegistriesMock = mock(() => {});
const clearWorkerRegistriesMock = mock(() => {});

mock.module('@temporalio/worker', () => ({
  Worker: {
    create: workerCreateMock,
  },
}));

mock.module('../src/discovery', () => ({
  discoverOrchestrationDefinitions: mock(() => ({
    tasks: [
      {
        _tag: 'ResolvedTask',
        name: 'task-a',
        queue: 'activity-q',
      },
    ],
    workflows: [
      {
        _tag: 'ResolvedWorkflow',
        name: 'workflow-a',
        steps: [],
      },
    ],
  })),
  selectOrchestrationDefinitions: mock((discovered: { tasks: unknown[]; workflows: unknown[] }) => {
    return discovered;
  }),
}));

mock.module('../src/workflowModuleGenerator', () => ({
  generateTemporalWorkflowModule: mock(async () => '/tmp/generated-workflows.ts'),
  resolvePackageWorkflowsPath: mock(() => '/tmp/package-workflows.ts'),
}));

mock.module('../src/activities', () => ({
  createTemporalActivities: mock(() => ({})),
}));

mock.module('../src/workerRegistry', () => ({
  installWorkerRegistries: installWorkerRegistriesMock,
  clearWorkerRegistries: clearWorkerRegistriesMock,
  isWorkerRegistryInstalled: mock(() => false),
}));

const { createTemporalOrchestrationWorkerInternal } = await import('../src/worker');

describe('Temporal worker bootstrap', () => {
  test('shuts down already-created workers when a later worker creation fails', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'slingshot-temporal-'));
    const definitionsModulePath = join(tempDir, 'definitions.ts');
    writeFileSync(definitionsModulePath, 'export const tasks = []; export const workflows = [];\n');

    const connection = {
      close: mock(async () => {}),
    };

    try {
      await expect(
        createTemporalOrchestrationWorkerInternal({
          connection: connection as never,
          ownsConnection: true,
          workflowTaskQueue: 'workflow-q',
          buildId: 'build-1',
          definitionsModulePath,
          defaultActivityTaskQueue: 'activity-q',
        }),
      ).rejects.toThrow('worker creation failed');

      expect(workerCreateMock).toHaveBeenCalledTimes(2);
      expect(createdWorkers).toHaveLength(1);
      expect(createdWorkers[0]?.shutdown).toHaveBeenCalledTimes(1);
      expect(installWorkerRegistriesMock).toHaveBeenCalledTimes(1);
      expect(clearWorkerRegistriesMock).toHaveBeenCalledTimes(1);
      expect(connection.close).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      createdWorkers.length = 0;
      workerCreateCalls = 0;
      mock.restore();
    }
  });
});
