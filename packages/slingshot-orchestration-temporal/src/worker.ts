import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { Worker, type NativeConnection } from '@temporalio/worker';
import { OrchestrationError, type OrchestrationEventSink } from '@lastshotlabs/slingshot-orchestration';
import { createOrchestrationProviderRegistry } from '@lastshotlabs/slingshot-orchestration/provider';
import { createTemporalActivities } from './activities';
import { discoverOrchestrationDefinitions, selectOrchestrationDefinitions } from './discovery';
import { generateTemporalWorkflowModule, resolvePackageWorkflowsPath } from './workflowModuleGenerator';
import { clearWorkerRegistries, installWorkerRegistries, isWorkerRegistryInstalled } from './workerRegistry';
import {
  temporalWorkerOptionsSchema,
  type TemporalOrchestrationWorkerOptions,
} from './validation';

/**
 * Running Temporal worker group created for a Slingshot orchestration definition set.
 */
export interface TemporalOrchestrationWorkerSupervisor {
  readonly workflowTaskQueue: string;
  readonly activityTaskQueues: readonly string[];
  run(): Promise<void>;
  shutdown(): Promise<void>;
}

function assertNodeRuntime(): void {
  if (!process.versions?.node || typeof Bun !== 'undefined') {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      'Temporal orchestration workers must run on real Node.js. Bun is not supported for worker startup.',
    );
  }
}

/**
 * Create the Temporal worker supervisor that executes portable Slingshot tasks and
 * workflows inside real Temporal workers.
 */
export async function createTemporalOrchestrationWorker(
  rawOptions: TemporalOrchestrationWorkerOptions,
): Promise<TemporalOrchestrationWorkerSupervisor> {
  assertNodeRuntime();
  const options = temporalWorkerOptionsSchema.parse(rawOptions);
  const identity = options.identity ?? `slingshot-temporal-worker-${process.pid}@${hostname()}`;
  if (!existsSync(options.definitionsModulePath)) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `Temporal definitions module '${options.definitionsModulePath}' does not exist.`,
    );
  }
  if (isWorkerRegistryInstalled()) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      'Temporal orchestration worker registry is already installed in this process.',
    );
  }

  const importedDefinitions = (await import(resolve(options.definitionsModulePath))) as Record<
    string,
    unknown
  >;
  const discovered = discoverOrchestrationDefinitions(importedDefinitions);
  const selected = selectOrchestrationDefinitions(discovered, {
    taskNames: options.taskNames,
    workflowNames: options.workflowNames,
  });
  const registry = createOrchestrationProviderRegistry({
    tasks: selected.tasks,
    workflows: selected.workflows,
  });

  let workers: Worker[] = [];
  const queues = new Set<string>();
  try {
    installWorkerRegistries({
      tasks: selected.tasks,
      workflows: selected.workflows,
    });

    const generatedWorkflowsPath = await generateTemporalWorkflowModule({
      generatedWorkflowsDir:
        options.generatedWorkflowsDir ?? resolve('.slingshot', 'tmp', 'temporal', 'workflows'),
      definitionsModulePath: resolve(options.definitionsModulePath),
      workflows: selected.workflows,
      registry,
      packageWorkflowsPath: resolvePackageWorkflowsPath(),
    });

    const namespace = options.namespace;
    const activities = createTemporalActivities({
      connection: options.connection as NativeConnection,
      namespace,
      eventSink: options.eventSink as OrchestrationEventSink | undefined,
    });

    for (const task of selected.tasks) {
      queues.add(task.queue ?? options.defaultActivityTaskQueue ?? options.workflowTaskQueue);
    }
    if (queues.size === 0) {
      queues.add(options.defaultActivityTaskQueue ?? options.workflowTaskQueue);
    }

    workers = [
      await Worker.create({
        connection: options.connection as NativeConnection,
        namespace,
        taskQueue: options.workflowTaskQueue,
        workflowsPath: generatedWorkflowsPath,
        activities,
        identity,
        buildId: options.buildId,
        maxConcurrentWorkflowTaskExecutions: options.maxConcurrentWorkflowTaskExecutions,
        maxConcurrentActivityTaskExecutions: options.maxConcurrentActivityTaskExecutions,
      }),
      ...(
        await Promise.all(
          [...queues]
            .filter(queue => queue !== options.workflowTaskQueue)
            .map(queue =>
              Worker.create({
                connection: options.connection as NativeConnection,
                namespace,
                taskQueue: queue,
                activities,
                identity,
                buildId: options.buildId,
                maxConcurrentActivityTaskExecutions: options.maxConcurrentActivityTaskExecutions,
              }),
            ),
        )
      ),
    ];
  } catch (error) {
    clearWorkerRegistries();
    if (options.ownsConnection) {
      await (options.connection as NativeConnection).close();
    }
    throw error;
  }

  let shuttingDown = false;
  let runPromise: Promise<void> | null = null;

  async function finalize(): Promise<void> {
    clearWorkerRegistries();
    if (options.ownsConnection) {
      await (options.connection as NativeConnection).close();
    }
  }

  return {
    workflowTaskQueue: options.workflowTaskQueue,
    activityTaskQueues: [...queues],
    async run() {
      if (!runPromise) {
        runPromise = Promise.all(workers.map(worker => worker.run()))
          .then(() => undefined)
          .finally(finalize);
      }
      await runPromise;
    },
    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      await Promise.all(workers.map(worker => worker.shutdown()));
      if (runPromise) {
        await runPromise;
      } else {
        await finalize();
      }
    },
  };
}
