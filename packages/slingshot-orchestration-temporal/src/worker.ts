import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { ClientInterceptors } from '@temporalio/client';
import type { DataConverter } from '@temporalio/common';
import { type NativeConnection, Worker, type WorkerInterceptors } from '@temporalio/worker';
import {
  OrchestrationError,
  type OrchestrationEventSink,
} from '@lastshotlabs/slingshot-orchestration';
import { createOrchestrationProviderRegistry } from '@lastshotlabs/slingshot-orchestration/provider';
import { createTemporalActivities } from './activities';
import { discoverOrchestrationDefinitions, selectOrchestrationDefinitions } from './discovery';
import { type TemporalOrchestrationWorkerOptions, temporalWorkerOptionsSchema } from './validation';
import {
  clearWorkerRegistries,
  installWorkerRegistries,
  isWorkerRegistryInstalled,
} from './workerRegistry';
import {
  generateTemporalWorkflowModule,
  resolvePackageWorkflowsPath,
} from './workflowModuleGenerator';

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
  return createTemporalOrchestrationWorkerInternal(rawOptions);
}

/**
 * Internal worker bootstrap helper used by tests and the Node-gated public entrypoint.
 */
export async function createTemporalOrchestrationWorkerInternal(
  rawOptions: TemporalOrchestrationWorkerOptions,
): Promise<TemporalOrchestrationWorkerSupervisor> {
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
  const createdWorkers: Worker[] = [];
  let extraWorkerPromises: Promise<Worker>[] = [];
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
    // `dataConverter` and `interceptors` are pass-through configuration
    // surfaces. Plumb them into every Worker we construct so payload codecs
    // (e.g. PII redaction) and worker interceptors (auth headers, tracing,
    // workflow modules) are applied symmetrically across the workflow
    // worker and any per-queue activity workers.
    //
    // The same `dataConverter` and (the client-shaped subset of)
    // `interceptors` are also forwarded into the internal `Client` that
    // activities use to signal child workflows. Without this plumbing,
    // activity-emitted signals bypass the codec and leak unredacted PII
    // to Temporal Web UI and the visibility store.
    const workerDataConverter = options.dataConverter as DataConverter | undefined;
    const workerInterceptors = options.interceptors as WorkerInterceptors | undefined;
    const clientInterceptors = options.interceptors as ClientInterceptors | undefined;

    const activities = createTemporalActivities({
      connection: options.connection as NativeConnection,
      namespace,
      eventSink: options.eventSink as OrchestrationEventSink | undefined,
      ...(workerDataConverter ? { dataConverter: workerDataConverter } : {}),
      ...(clientInterceptors ? { interceptors: clientInterceptors } : {}),
    });

    for (const task of selected.tasks) {
      queues.add(task.queue ?? options.defaultActivityTaskQueue ?? options.workflowTaskQueue);
    }
    if (queues.size === 0) {
      queues.add(options.defaultActivityTaskQueue ?? options.workflowTaskQueue);
    }

    const workflowWorker = await Worker.create({
      connection: options.connection as NativeConnection,
      namespace,
      taskQueue: options.workflowTaskQueue,
      workflowsPath: generatedWorkflowsPath,
      activities,
      identity,
      buildId: options.buildId,
      maxConcurrentWorkflowTaskExecutions: options.maxConcurrentWorkflowTaskExecutions,
      maxConcurrentActivityTaskExecutions: options.maxConcurrentActivityTaskExecutions,
      ...(workerDataConverter ? { dataConverter: workerDataConverter } : {}),
      ...(workerInterceptors ? { interceptors: workerInterceptors } : {}),
    });
    createdWorkers.push(workflowWorker);

    extraWorkerPromises = [...queues]
      .filter(queue => queue !== options.workflowTaskQueue)
      .map(async queue => {
        const worker = await Worker.create({
          connection: options.connection as NativeConnection,
          namespace,
          taskQueue: queue,
          activities,
          identity,
          buildId: options.buildId,
          maxConcurrentActivityTaskExecutions: options.maxConcurrentActivityTaskExecutions,
          ...(workerDataConverter ? { dataConverter: workerDataConverter } : {}),
          ...(workerInterceptors ? { interceptors: workerInterceptors } : {}),
        });
        createdWorkers.push(worker);
        return worker;
      });

    workers = [workflowWorker, ...(await Promise.all(extraWorkerPromises))];
  } catch (error) {
    await Promise.allSettled(extraWorkerPromises);
    await Promise.allSettled(createdWorkers.map(worker => worker.shutdown()));
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
