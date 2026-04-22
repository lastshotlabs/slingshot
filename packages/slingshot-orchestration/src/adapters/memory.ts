import { createCachedRunHandle, generateRunId } from '../adapter';
import { createTaskRunner } from '../engine/taskRunner';
import { executeWorkflow } from '../engine/workflowRunner';
import { OrchestrationError } from '../errors';
import { createIdempotencyScope } from '../idempotency';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  ObservabilityCapability,
  OrchestrationAdapter,
  OrchestrationEventSink,
  Run,
  RunFilter,
  RunProgress,
  RunStatus,
  StepRun,
  WorkflowRun,
} from '../types';
import { memoryAdapterOptionsSchema } from '../validation';

function toError(error: unknown) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function matchesTags(
  runTags: Record<string, string> | undefined,
  filterTags: Record<string, string>,
): boolean {
  if (!runTags) return false;
  return Object.entries(filterTags).every(([key, value]) => runTags[key] === value);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Run cancelled'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Run cancelled'));
      },
      { once: true },
    );
  });
}

/**
 * Create the in-process orchestration adapter.
 *
 * This adapter is the lightest execution mode: no external infrastructure, no
 * durability across process restarts, and full support for observability/progress
 * within the running process.
 */
export function createMemoryAdapter(
  options: {
    concurrency?: number;
    eventSink?: OrchestrationEventSink;
  } = {},
): OrchestrationAdapter & ObservabilityCapability {
  const parsed = memoryAdapterOptionsSchema.parse({ concurrency: options.concurrency });
  const taskRegistry = new Map<string, AnyResolvedTask>();
  const workflowRegistry = new Map<string, AnyResolvedWorkflow>();
  const runs = new Map<string, Run | WorkflowRun>();
  const resultPromises = new Map<string, Promise<unknown>>();
  const progressListeners = new Map<string, Set<(data: RunProgress | undefined) => void>>();
  const idempotencyKeys = new Map<string, string>();
  const workflowControllers = new Map<string, AbortController>();
  const workflowChildren = new Map<string, Set<string>>();
  const delayedWorkflowStarts = new Map<string, AbortController>();
  let started = false;
  let shuttingDown = false;

  function ensureStarted(): Promise<void> {
    if (started) return Promise.resolve();
    started = true;
    return Promise.resolve();
  }

  function notifyProgress(runId: string, progress: RunProgress | undefined): void {
    for (const listener of progressListeners.get(runId) ?? []) {
      listener(progress);
    }
  }

  function loadRunResult(runId: string): Promise<unknown> {
    const activePromise = resultPromises.get(runId);
    if (activePromise) {
      return activePromise;
    }

    const run = runs.get(runId);
    if (!run) {
      return Promise.reject(new OrchestrationError('RUN_NOT_FOUND', `Run '${runId}' not found`));
    }

    if (run.status === 'completed') {
      return Promise.resolve(run.output);
    }
    if (run.status === 'failed' || run.status === 'cancelled') {
      return Promise.reject(new Error(run.error?.message ?? `Run '${runId}' ${run.status}.`));
    }

    return Promise.reject(
      new OrchestrationError('ADAPTER_ERROR', `Run '${runId}' is not active in this process.`),
    );
  }

  const taskRunner = createTaskRunner({
    concurrency: parsed.concurrency ?? 10,
    eventSink: options.eventSink,
    callbacks: {
      onStarted(runId) {
        const run = runs.get(runId);
        if (!run) return;
        run.status = 'running';
        run.startedAt = new Date();
      },
      onProgress(runId, _taskName, data) {
        const run = runs.get(runId);
        if (!run) return;
        run.progress = data;
        notifyProgress(runId, data);
      },
      onCompleted(runId, _taskName, output) {
        const run = runs.get(runId);
        if (!run) return;
        run.status = 'completed';
        run.output = output;
        run.completedAt = new Date();
        notifyProgress(runId, run.progress);
        resultPromises.delete(runId);
        progressListeners.delete(runId);
      },
      onFailed(runId, _taskName, error, _durationMs, status) {
        const run = runs.get(runId);
        if (!run) return;
        run.status = status;
        run.error = error;
        run.completedAt = new Date();
        notifyProgress(runId, run.progress);
        resultPromises.delete(runId);
        progressListeners.delete(runId);
      },
    },
  });

  return {
    registerTask(def) {
      taskRegistry.set(def.name, def);
    },
    registerWorkflow(def) {
      workflowRegistry.set(def.name, def);
    },
    async runTask(name, input, opts) {
      await ensureStarted();
      if (shuttingDown) {
        throw new OrchestrationError('ADAPTER_ERROR', 'Adapter is shutting down.');
      }
      const def = taskRegistry.get(name);
      if (!def) {
        throw new OrchestrationError('TASK_NOT_FOUND', `Task '${name}' not registered`);
      }

      const scopedIdempotencyKey = createIdempotencyScope({ type: 'task', name }, opts ?? {});
      if (scopedIdempotencyKey) {
        const existingRunId = idempotencyKeys.get(scopedIdempotencyKey);
        if (existingRunId) {
          return createCachedRunHandle(existingRunId, () => loadRunResult(existingRunId));
        }
      }

      const runId = generateRunId();
      // Set idempotency key atomically before any async work to prevent races
      if (scopedIdempotencyKey) {
        idempotencyKeys.set(scopedIdempotencyKey, runId);
      }
      runs.set(runId, {
        id: runId,
        type: 'task',
        name,
        status: 'pending',
        input,
        tenantId: opts?.tenantId,
        priority: opts?.priority,
        tags: opts?.tags,
        metadata: opts?.metadata,
        createdAt: new Date(),
      });

      const handle = taskRunner.submit(def, input, {
        runId,
        tenantId: opts?.tenantId,
        priority: opts?.priority,
        delay: opts?.delay,
      });
      resultPromises.set(runId, handle.result());
      return createCachedRunHandle(runId, () => handle.result());
    },
    async runWorkflow(name, input, opts) {
      await ensureStarted();
      if (shuttingDown) {
        throw new OrchestrationError('ADAPTER_ERROR', 'Adapter is shutting down.');
      }
      const def = workflowRegistry.get(name);
      if (!def) {
        throw new OrchestrationError('WORKFLOW_NOT_FOUND', `Workflow '${name}' not registered`);
      }

      const scopedIdempotencyKey = createIdempotencyScope(
        { type: 'workflow', name },
        opts ?? {},
      );
      if (scopedIdempotencyKey) {
        const existingRunId = idempotencyKeys.get(scopedIdempotencyKey);
        if (existingRunId) {
          return createCachedRunHandle(existingRunId, () => loadRunResult(existingRunId));
        }
      }

      const runId = generateRunId();
      // Set idempotency key atomically before any async work to prevent races
      if (scopedIdempotencyKey) {
        idempotencyKeys.set(scopedIdempotencyKey, runId);
      }
      const workflowRun: WorkflowRun = {
        id: runId,
        type: 'workflow',
        name,
        status: 'pending',
        input,
        tenantId: opts?.tenantId,
        priority: opts?.priority,
        tags: opts?.tags,
        metadata: opts?.metadata,
        createdAt: new Date(),
        steps: {},
      };
      runs.set(runId, workflowRun);

      const controller = new AbortController();
      workflowControllers.set(runId, controller);
      workflowChildren.set(runId, new Set());
      const delayController = new AbortController();
      delayedWorkflowStarts.set(runId, delayController);
      const promise = (async () => {
        try {
          if ((opts?.delay ?? 0) > 0) {
            await wait(opts?.delay ?? 0, delayController.signal);
          }

          delayedWorkflowStarts.delete(runId);
          return await executeWorkflow({
            def,
            input,
            runId,
            tenantId: opts?.tenantId,
            signal: controller.signal,
            taskRunner,
            taskRegistry,
            eventSink: options.eventSink,
            onChildRun(childRunId) {
              workflowChildren.get(runId)?.add(childRunId);
            },
            callbacks: {
              onStarted(workflowRunId) {
                const run = runs.get(workflowRunId);
                if (!run) return;
                run.status = 'running';
                run.startedAt = new Date();
              },
              onStepStarted(workflowRunId, stepName, taskName) {
                const run = runs.get(workflowRunId) as WorkflowRun | undefined;
                if (!run) return;
                run.steps ??= {};
                run.steps[stepName] = {
                  name: stepName,
                  task: taskName,
                  status: 'running',
                  attempts: 1,
                  startedAt: new Date(),
                };
              },
              onStepCompleted(workflowRunId, stepName, taskName, output, attempts) {
                const run = runs.get(workflowRunId) as WorkflowRun | undefined;
                if (!run) return;
                run.steps ??= {};
                run.steps[stepName] = {
                  name: stepName,
                  task: taskName,
                  status: 'completed',
                  attempts,
                  output,
                  startedAt: run.steps[stepName]?.startedAt ?? new Date(),
                  completedAt: new Date(),
                };
              },
              onStepFailed(workflowRunId, stepName, taskName, error, attempts, status = 'failed') {
                const run = runs.get(workflowRunId) as WorkflowRun | undefined;
                if (!run) return;
                run.steps ??= {};
                run.steps[stepName] = {
                  name: stepName,
                  task: taskName,
                  status,
                  attempts,
                  error,
                  startedAt: run.steps[stepName]?.startedAt ?? new Date(),
                  completedAt: new Date(),
                };
              },
              onStepSkipped(workflowRunId, stepName, taskName) {
                const run = runs.get(workflowRunId) as WorkflowRun | undefined;
                if (!run) return;
                run.steps ??= {};
                run.steps[stepName] = {
                  name: stepName,
                  task: taskName,
                  status: 'skipped',
                  attempts: 0,
                  completedAt: new Date(),
                };
              },
              onSleepStarted(workflowRunId, stepName, wakeAt) {
                const run = runs.get(workflowRunId) as WorkflowRun | undefined;
                if (!run) return;
                run.steps ??= {};
                run.steps[stepName] = {
                  name: stepName,
                  task: '__sleep__',
                  status: 'running',
                  attempts: 1,
                  output: { wakeAt },
                  startedAt: new Date(),
                };
              },
              onCompleted(workflowRunId, output) {
                const run = runs.get(workflowRunId);
                if (!run) return;
                run.status = 'completed';
                run.output = output;
                run.completedAt = new Date();
                resultPromises.delete(workflowRunId);
                progressListeners.delete(workflowRunId);
              },
              onFailed(workflowRunId, error, _failedStep, _durationMs, status = 'failed') {
                const run = runs.get(workflowRunId);
                if (!run) return;
                run.status = status;
                run.error = error;
                run.completedAt = new Date();
                resultPromises.delete(workflowRunId);
                progressListeners.delete(workflowRunId);
              },
            },
          });
        } finally {
          delayedWorkflowStarts.delete(runId);
          workflowControllers.delete(runId);
          workflowChildren.delete(runId);
        }
      })();

      resultPromises.set(runId, promise);
      return createCachedRunHandle(runId, () => promise);
    },
    async getRun(runId) {
      return runs.get(runId) ?? null;
    },
    async cancelRun(runId) {
      const run = runs.get(runId);
      if (!run) {
        throw new OrchestrationError('RUN_NOT_FOUND', `Run '${runId}' not found`);
      }
      if (run.type === 'task') {
        await taskRunner.cancel(runId);
        run.status = 'cancelled';
        run.completedAt = new Date();
        run.error = { message: 'Run cancelled' };
        return;
      }

      delayedWorkflowStarts.get(runId)?.abort(new Error('Run cancelled'));
      workflowControllers.get(runId)?.abort(new Error('Run cancelled'));
      for (const childRunId of workflowChildren.get(runId) ?? []) {
        await taskRunner.cancel(childRunId);
      }
      run.status = 'cancelled';
      run.completedAt = new Date();
      run.error = { message: 'Run cancelled' };
    },
    async start() {
      started = true;
    },
    async shutdown() {
      shuttingDown = true;
      for (const controller of delayedWorkflowStarts.values()) {
        controller.abort(new Error('Run cancelled'));
      }
      for (const controller of workflowControllers.values()) {
        controller.abort(new Error('Run cancelled'));
      }
      await taskRunner.waitForIdle();
    },
    async listRuns(filter) {
      const entries = [...runs.values()].filter(run => {
        if (filter?.type && run.type !== filter.type) return false;
        if (filter?.name && run.name !== filter.name) return false;
        if (filter?.tenantId && run.tenantId !== filter.tenantId) return false;
        if (filter?.status) {
          const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
          if (!statuses.includes(run.status)) return false;
        }
        if (filter?.tags && !matchesTags(run.tags, filter.tags)) return false;
        if (filter?.createdAfter && run.createdAt < filter.createdAfter) return false;
        if (filter?.createdBefore && run.createdAt > filter.createdBefore) return false;
        return true;
      });
      entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? 50;
      return {
        runs: entries.slice(offset, offset + limit),
        total: entries.length,
      };
    },
    onProgress(runId, callback) {
      const listeners = progressListeners.get(runId) ?? new Set();
      listeners.add(callback);
      progressListeners.set(runId, listeners);
      return () => {
        listeners.delete(callback);
        if (listeners.size === 0) {
          progressListeners.delete(runId);
        }
      };
    },
  };
}
