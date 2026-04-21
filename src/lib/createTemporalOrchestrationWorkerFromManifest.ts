import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
} from '@lastshotlabs/slingshot-orchestration';
import {
  interpolateEnvVars,
  loadHandlersIntoRegistry,
  resolveHandlersFileEntries,
} from './createServerFromManifest';
import { createManifestHandlerRegistry } from './manifestHandlerRegistry';
import type { AppManifest } from './manifest';
import { validateAppManifest } from './manifest';
import type { ManifestHandlerRegistry } from './manifestHandlerRegistry';

export interface CreateTemporalOrchestrationWorkerFromManifestOptions {
  handlersPath?: string | { dir: string } | false;
  buildId?: string;
  dryRun?: boolean;
  registry?: ManifestHandlerRegistry;
}

export interface TemporalManifestWorkerPlan {
  buildId: string;
  definitionsModulePath: string;
  workflowTaskQueue: string;
  activityTaskQueues: string[];
  taskNames: string[];
  workflowNames: string[];
  worker?: {
    run(): Promise<void>;
    shutdown(): Promise<void>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectWorkflowTaskNames(workflows: readonly AnyResolvedWorkflow[]): Set<string> {
  const names = new Set<string>();
  for (const workflow of workflows) {
    for (const entry of workflow.steps) {
      if (entry._tag === 'Step') {
        names.add(entry.taskRef?.name ?? entry.task);
        continue;
      }
      if (entry._tag === 'Parallel') {
        for (const step of entry.steps) {
          names.add(step.taskRef?.name ?? step.task);
        }
      }
    }
  }
  return names;
}

async function resolveWorkerManifest(
  manifestPath: string,
  options?: CreateTemporalOrchestrationWorkerFromManifestOptions,
): Promise<{ manifest: AppManifest; registry: ManifestHandlerRegistry }> {
  const absoluteManifestPath = resolve(manifestPath);
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(absoluteManifestPath, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[createTemporalOrchestrationWorkerFromManifest] Failed to read manifest at '${absoluteManifestPath}': ${message}`,
      { cause: error },
    );
  }

  raw = interpolateEnvVars(raw, '');

  const validation = validateAppManifest(raw);
  if (!validation.success) {
    throw new Error(
      `[createTemporalOrchestrationWorkerFromManifest] Invalid manifest at '${absoluteManifestPath}':\n${validation.errors.join('\n')}`,
    );
  }

  for (const warning of validation.warnings) {
    console.warn(`[createTemporalOrchestrationWorkerFromManifest] ${warning}`);
  }

  const registry = options?.registry ?? createManifestHandlerRegistry();
  await loadHandlersIntoRegistry(
    registry,
    options?.handlersPath !== undefined ? options.handlersPath : validation.manifest.handlers,
    dirname(absoluteManifestPath),
  );

  return {
    manifest: validation.manifest,
    registry,
  };
}

function resolveTemporalTlsConfig(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const tls = config['tls'];
  if (!isRecord(tls)) return undefined;
  const resolved: Record<string, unknown> = {};
  if (typeof tls['serverNameOverride'] === 'string') {
    resolved['serverNameOverride'] = tls['serverNameOverride'];
  }
  if (typeof tls['serverRootCACertificate'] === 'string') {
    resolved['serverRootCACertificate'] = tls['serverRootCACertificate'];
  }
  if (isRecord(tls['clientCertPair'])) {
    resolved['clientCertPair'] = {
      crt: tls['clientCertPair']['crt'],
      key: tls['clientCertPair']['key'],
    };
  }
  return Object.keys(resolved).length === 0 ? undefined : resolved;
}

function resolveDefinitionsModulePath(
  manifestPath: string,
  handlersOverride: string | { dir: string } | false | undefined,
  manifestHandlers: string | { dir: string } | false | undefined,
): Promise<string> | string {
  const baseDir = dirname(manifestPath);
  const entries = resolveHandlersFileEntries(
    handlersOverride !== undefined ? handlersOverride : manifestHandlers,
    baseDir,
  );

  if (entries.mode === 'disabled') {
    throw new Error(
      '[createTemporalOrchestrationWorkerFromManifest] Temporal orchestration manifest mode requires handler auto-loading. handlers: false is not supported.',
    );
  }

  if (entries.mode === 'file') {
    if (!existsSync(entries.filePath)) {
      throw new Error(
        `[createTemporalOrchestrationWorkerFromManifest] Temporal definitions module '${entries.filePath}' does not exist.`,
      );
    }
    return entries.filePath;
  }

  if (entries.files.length === 0) {
    throw new Error(
      `[createTemporalOrchestrationWorkerFromManifest] Handler directory '${entries.dirPath}' does not contain any .ts or .js files for Temporal orchestration.`,
    );
  }

  return import('@lastshotlabs/slingshot-orchestration-temporal').then(mod =>
    mod.generateDirectoryDefinitionsModule
      ? mod.generateDirectoryDefinitionsModule({
          outDir: resolve('.slingshot', 'tmp', 'temporal', 'manifest-definitions'),
          files: entries.files,
        })
      : Promise.reject(
          new Error(
            '[createTemporalOrchestrationWorkerFromManifest] Temporal package does not expose manifest definitions module generation.',
          ),
        ),
  );
}

export async function createTemporalOrchestrationWorkerFromManifest(
  manifestPath: string,
  options?: CreateTemporalOrchestrationWorkerFromManifestOptions,
): Promise<TemporalManifestWorkerPlan> {
  const resolved = await resolveWorkerManifest(manifestPath, options);

  const orchestrationPluginRef = resolved.manifest.plugins?.find(
    ref => ref.plugin === 'slingshot-orchestration',
  );
  if (!orchestrationPluginRef || !isRecord(orchestrationPluginRef.config)) {
    throw new Error(
      '[createTemporalOrchestrationWorkerFromManifest] Manifest does not declare plugin "slingshot-orchestration".',
    );
  }

  const config = orchestrationPluginRef.config;
  const adapterRef = isRecord(config['adapter']) ? config['adapter'] : {};
  if (adapterRef['type'] !== 'temporal') {
    throw new Error(
      '[createTemporalOrchestrationWorkerFromManifest] slingshot-orchestration adapter.type must be "temporal" for worker startup.',
    );
  }

  const adapterConfig = isRecord(adapterRef['config']) ? adapterRef['config'] : {};
  if (typeof adapterConfig['workflowTaskQueue'] !== 'string' || adapterConfig['workflowTaskQueue'].length === 0) {
    throw new Error(
      '[createTemporalOrchestrationWorkerFromManifest] Temporal adapter.config.workflowTaskQueue is required.',
    );
  }
  const workerConfig = isRecord(adapterConfig['worker']) ? adapterConfig['worker'] : {};
  const buildId =
    options?.buildId ??
    (typeof workerConfig['buildId'] === 'string' ? workerConfig['buildId'] : undefined);
  if (!buildId) {
    throw new Error(
      '[createTemporalOrchestrationWorkerFromManifest] Temporal worker buildId is required. Set adapter.config.worker.buildId or pass --build-id.',
    );
  }

  const taskNames = Array.isArray(config['tasks'])
    ? config['tasks'].filter((value): value is string => typeof value === 'string')
    : [];
  const workflowNames = Array.isArray(config['workflows'])
    ? config['workflows'].filter((value): value is string => typeof value === 'string')
    : [];

  const selectedWorkflows = workflowNames.map(name => resolved.registry.resolveWorkflow(name));
  const workflowTaskNames = collectWorkflowTaskNames(selectedWorkflows);
  const selectedTasks = new Map<string, AnyResolvedTask>();
  for (const taskName of workflowTaskNames) {
    selectedTasks.set(taskName, resolved.registry.resolveTask(taskName));
  }
  for (const taskName of taskNames) {
    selectedTasks.set(taskName, resolved.registry.resolveTask(taskName));
  }

  const definitionsModulePath = await resolveDefinitionsModulePath(
    resolve(manifestPath),
    options?.handlersPath,
    resolved.manifest.handlers,
  );
  const workflowTaskQueue = adapterConfig['workflowTaskQueue'];
  const defaultActivityTaskQueue =
    typeof adapterConfig['defaultActivityTaskQueue'] === 'string'
      ? adapterConfig['defaultActivityTaskQueue']
      : undefined;
  const activityTaskQueues = [...new Set(
    [...selectedTasks.values()].map(
      task => task.queue ?? defaultActivityTaskQueue ?? workflowTaskQueue,
    ),
  )];

  if (options?.dryRun) {
    return {
      buildId,
      definitionsModulePath,
      workflowTaskQueue,
      activityTaskQueues,
      taskNames,
      workflowNames,
    };
  }

  const [{ NativeConnection }, temporal] = await Promise.all([
    import('@temporalio/worker'),
    import('@lastshotlabs/slingshot-orchestration-temporal'),
  ]);
  const connection = await NativeConnection.connect({
    address:
      typeof adapterConfig['address'] === 'string' ? adapterConfig['address'] : 'localhost:7233',
    ...(resolveTemporalTlsConfig(adapterConfig)
      ? { tls: resolveTemporalTlsConfig(adapterConfig) as never }
      : {}),
  });

  const worker = await temporal.createTemporalOrchestrationWorker({
    connection,
    ownsConnection: true,
    namespace:
      typeof adapterConfig['namespace'] === 'string' ? adapterConfig['namespace'] : undefined,
    workflowTaskQueue,
    defaultActivityTaskQueue,
    buildId,
    definitionsModulePath,
    taskNames,
    workflowNames,
    ...(typeof workerConfig['identity'] === 'string' ? { identity: workerConfig['identity'] } : {}),
    ...(typeof workerConfig['maxConcurrentWorkflowTaskExecutions'] === 'number'
      ? {
          maxConcurrentWorkflowTaskExecutions:
            workerConfig['maxConcurrentWorkflowTaskExecutions'],
        }
      : {}),
    ...(typeof workerConfig['maxConcurrentActivityTaskExecutions'] === 'number'
      ? {
          maxConcurrentActivityTaskExecutions:
            workerConfig['maxConcurrentActivityTaskExecutions'],
        }
      : {}),
  });

  return {
    buildId,
    definitionsModulePath,
    workflowTaskQueue,
    activityTaskQueues,
    taskNames,
    workflowNames,
    worker,
  };
}
