import { generateRunId } from '../adapter';
import { OrchestrationError } from '../errors';
import { logger } from '../internal/logger';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  OrchestrationEventMap,
  OrchestrationEventSink,
  RunError,
  RunStatus,
  StepEntry,
  StepRun,
} from '../types';
import type { TaskRunner } from './taskRunner';

interface PersistedWorkflowState {
  results?: Record<string, unknown>;
  steps?: Record<string, StepRun>;
}

export interface WorkflowRunnerCallbacks {
  onStarted(runId: string): void | Promise<void>;
  onStepStarted(runId: string, stepName: string, taskName: string): void | Promise<void>;
  onStepCompleted(
    runId: string,
    stepName: string,
    taskName: string,
    output: unknown,
    attempts: number,
  ): void | Promise<void>;
  onStepFailed(
    runId: string,
    stepName: string,
    taskName: string,
    error: RunError,
    attempts: number,
    status?: RunStatus,
  ): void | Promise<void>;
  onStepSkipped(runId: string, stepName: string, taskName: string): void | Promise<void>;
  onSleepStarted?(runId: string, stepName: string, wakeAt: string): void | Promise<void>;
  onCompleted(runId: string, output: unknown, durationMs: number): void | Promise<void>;
  onFailed(
    runId: string,
    error: RunError,
    failedStep: string | undefined,
    durationMs: number,
    status?: RunStatus,
  ): void | Promise<void>;
}

function toRunError(error: unknown): RunError {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function safeEmit<TName extends keyof OrchestrationEventMap>(
  eventSink: OrchestrationEventSink | undefined,
  name: TName,
  payload: OrchestrationEventMap[TName],
  label: string,
): void {
  if (!eventSink) return;
  try {
    const result = eventSink.emit(name, payload);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(err => {
        logger.error(`eventSink.emit error (${label})`, { err: String(err) });
      });
    }
  } catch (err) {
    logger.error(`eventSink.emit error (${label})`, { err: String(err) });
  }
}

function reportWorkflowHookError(options: {
  eventSink?: OrchestrationEventSink;
  runId: string;
  workflow: string;
  hook: 'onStart' | 'onComplete' | 'onFail';
  error: unknown;
}): void {
  if (options.eventSink) {
    void options.eventSink.emit('orchestration.workflow.hookError', {
      runId: options.runId,
      workflow: options.workflow,
      hook: options.hook,
      error: toRunError(options.error),
    });
    return;
  }
  logger.error(`workflow ${options.hook} hook failed`, { err: String(options.error) });
}

interface HookConfigShape<TFn> {
  handler: TFn;
  continueOnHookError?: boolean;
}

function normalizeHook<TFn>(
  hook: TFn | HookConfigShape<TFn> | undefined,
): { handler: TFn; continueOnHookError: boolean } | undefined {
  if (hook === undefined) return undefined;
  if (typeof hook === 'function') {
    return { handler: hook, continueOnHookError: false };
  }
  if (typeof hook === 'object' && hook !== null && 'handler' in hook) {
    const cfg = hook as HookConfigShape<TFn>;
    return { handler: cfg.handler, continueOnHookError: cfg.continueOnHookError ?? false };
  }
  return undefined;
}

/**
 * Thrown when a workflow lifecycle hook (`onStart`, `onComplete`, or `onFail`)
 * raises and `continueOnHookError` is not set on the hook configuration. The
 * workflow is failed with a `hookFailed` failure step.
 */
export class WorkflowHookError extends Error {
  public readonly hook: 'onStart' | 'onComplete' | 'onFail';
  public readonly cause: unknown;
  constructor(hook: 'onStart' | 'onComplete' | 'onFail', cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Workflow ${hook} hook failed: ${message}`);
    this.name = 'WorkflowHookError';
    this.hook = hook;
    this.cause = cause;
  }
}

function assertSleepDuration(stepName: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new OrchestrationError(
      'INVALID_CONFIG',
      `Sleep step '${stepName}' duration must be a non-negative finite number.`,
    );
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  let onAbort: (() => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve();
    }, ms);

    if (signal.aborted) {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? 'Run cancelled')),
      );
      return;
    }

    onAbort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? 'Run cancelled')),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  // Remove the listener when the promise settles (timer fires without abort).
  // If the signal aborted, { once: true } already removed it, so the
  // removeEventListener is a harmless no-op.
  const cleanup = () => {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  };
  promise.then(cleanup, cleanup);

  return promise;
}

function abortMessage(signal: AbortSignal): string | undefined {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return undefined;
}

function createAbortSignal(parent: AbortSignal | undefined, timeout: number | undefined) {
  const controller = new AbortController();
  const forwardAbort = () => {
    const reason = parent?.reason;
    controller.abort(
      reason instanceof Error ? reason : new Error(String(reason ?? 'Run cancelled')),
    );
  };

  if (parent?.aborted) {
    forwardAbort();
  } else if (parent) {
    parent.addEventListener('abort', forwardAbort, { once: true });
  }

  const timeoutHandle =
    timeout === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(new Error('Workflow timed out'));
        }, timeout);

  return {
    signal: controller.signal,
    cleanup() {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (parent) {
        parent.removeEventListener('abort', forwardAbort);
      }
    },
  };
}

function withStepOverrides(task: AnyResolvedTask, options: StepEntry['options']): AnyResolvedTask {
  if (!options.retry && options.timeout === undefined) {
    return task;
  }

  return Object.freeze({
    ...task,
    retry: Object.freeze({
      maxAttempts: options.retry?.maxAttempts ?? task.retry.maxAttempts,
      backoff: options.retry?.backoff ?? task.retry.backoff,
      delayMs: options.retry?.delayMs ?? task.retry.delayMs,
      maxDelayMs: options.retry?.maxDelayMs ?? task.retry.maxDelayMs,
    }),
    timeout: options.timeout ?? task.timeout,
  });
}

async function awaitTaskResult(options: {
  taskRunner: TaskRunner;
  childRunId: string;
  promise: Promise<unknown>;
  signal?: AbortSignal;
}): Promise<unknown> {
  void options.promise.catch(() => undefined);

  if (!options.signal) {
    return options.promise;
  }

  if (options.signal.aborted) {
    await options.taskRunner.cancel(options.childRunId);
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error(String(options.signal.reason ?? 'Run cancelled'));
  }

  return await Promise.race([
    options.promise,
    new Promise<never>((_, reject) => {
      const onAbort = () => {
        void options.taskRunner.cancel(options.childRunId);
        reject(
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error(String(options.signal?.reason ?? 'Run cancelled')),
        );
      };

      options.signal?.addEventListener('abort', onAbort, { once: true });
      // Use then/then instead of finally so the derived promise fulfills on rejection
      // (a rejected .finally() promise is unhandled in Bun's JSC-based rejection tracker).
      options.promise.then(
        () => options.signal?.removeEventListener('abort', onAbort),
        () => options.signal?.removeEventListener('abort', onAbort),
      );
    }),
  ]);
}

function resolveTask(entry: StepEntry, registry: Map<string, AnyResolvedTask>): AnyResolvedTask {
  if (entry.taskRef) return entry.taskRef;
  const task = registry.get(entry.task);
  if (!task) {
    throw new OrchestrationError('TASK_NOT_FOUND', `Task '${entry.task}' not registered`);
  }
  return task;
}

export async function executeWorkflow(options: {
  def: AnyResolvedWorkflow;
  input: unknown;
  runId: string;
  tenantId?: string;
  signal?: AbortSignal;
  taskRunner: TaskRunner;
  taskRegistry: Map<string, AnyResolvedTask>;
  callbacks: WorkflowRunnerCallbacks;
  eventSink?: OrchestrationEventSink;
  persistedState?: PersistedWorkflowState;
  onChildRun?(runId: string): void;
  /**
   * Optional `HookServices` instance passed verbatim to `onStart`/`onComplete`/`onFail`.
   * Provided by in-process adapters (memory, sqlite, in-process bullmq); `undefined`
   * for adapters running hooks in remote isolates.
   */
  services?: import('@lastshotlabs/slingshot-core').HookServices;
}): Promise<unknown> {
  const workflowInput = options.def.input.parse(options.input);
  const startedAt = Date.now();
  const { signal, cleanup } = createAbortSignal(options.signal, options.def.timeout);
  const results: Record<string, unknown> = { ...(options.persistedState?.results ?? {}) };
  let failedStep: string | undefined;

  await options.callbacks.onStarted(options.runId);
  safeEmit(
    options.eventSink,
    'orchestration.workflow.started',
    {
      runId: options.runId,
      workflow: options.def.name,
      input: workflowInput,
      tenantId: options.tenantId,
    },
    'workflow.started',
  );

  const onStart = normalizeHook(options.def.onStart);
  if (onStart) {
    try {
      await onStart.handler({
        runId: options.runId,
        input: workflowInput,
        tenantId: options.tenantId,
        services: options.services,
      });
    } catch (error) {
      reportWorkflowHookError({
        eventSink: options.eventSink,
        runId: options.runId,
        workflow: options.def.name,
        hook: 'onStart',
        error,
      });
      if (!onStart.continueOnHookError) {
        failedStep = 'hook:onStart';
        cleanup();
        const hookError = new WorkflowHookError('onStart', error);
        const runError = toRunError(hookError);
        await options.callbacks.onFailed(
          options.runId,
          runError,
          failedStep,
          Date.now() - startedAt,
          'failed',
        );
        safeEmit(
          options.eventSink,
          'orchestration.workflow.failed',
          {
            runId: options.runId,
            workflow: options.def.name,
            error: runError,
            failedStep,
            tenantId: options.tenantId,
          },
          'workflow.failed',
        );
        throw hookError;
      }
    }
  }

  try {
    for (const entry of options.def.steps) {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? 'Run cancelled'));
      }

      if (entry._tag === 'Sleep') {
        const persistedStep = options.persistedState?.steps?.[entry.name];
        if (persistedStep?.status === 'completed') {
          results[entry.name] = persistedStep.output;
          continue;
        }

        const context = { workflowInput, results };
        const sleepMs =
          typeof entry.duration === 'function' ? entry.duration(context) : entry.duration;
        assertSleepDuration(entry.name, sleepMs);
        const existingWakeAt =
          persistedStep?.status === 'running' &&
          persistedStep.output &&
          typeof persistedStep.output === 'object' &&
          persistedStep.output !== null &&
          'wakeAt' in persistedStep.output
            ? String((persistedStep.output as Record<string, unknown>).wakeAt)
            : undefined;
        const wakeAt = existingWakeAt ?? new Date(Date.now() + sleepMs).toISOString();
        const isRecovery = existingWakeAt !== undefined;
        if (!isRecovery) {
          await options.callbacks.onSleepStarted?.(options.runId, entry.name, wakeAt);
        }
        const remaining = Math.max(0, new Date(wakeAt).getTime() - Date.now());
        if (remaining > 0) {
          await wait(remaining, signal);
        }
        const output = { sleptMs: sleepMs, wakeAt };
        results[entry.name] = output;
        await options.callbacks.onStepCompleted(options.runId, entry.name, '__sleep__', output, 1);
        continue;
      }

      if (entry._tag === 'Parallel') {
        const stepContext = { workflowInput, results };
        const activeEntries = entry.steps.filter(
          step => !step.options.condition || step.options.condition(stepContext),
        );

        for (const stepEntry of entry.steps) {
          if (stepEntry.options.condition && !stepEntry.options.condition(stepContext)) {
            results[stepEntry.name] = undefined;
            await options.callbacks.onStepSkipped(options.runId, stepEntry.name, stepEntry.task);
            safeEmit(
              options.eventSink,
              'orchestration.step.skipped',
              {
                runId: options.runId,
                workflow: options.def.name,
                step: stepEntry.name,
              },
              'step.skipped',
            );
          }
        }

        const pendingChildren = activeEntries.map(async stepEntry => {
          const persistedStep = options.persistedState?.steps?.[stepEntry.name];
          if (persistedStep?.status === 'completed') {
            return { step: stepEntry, status: 'fulfilled' as const, value: persistedStep.output };
          }

          const taskDef = withStepOverrides(
            resolveTask(stepEntry, options.taskRegistry),
            stepEntry.options,
          );
          const childRunId = generateRunId();
          await options.callbacks.onStepStarted(options.runId, stepEntry.name, taskDef.name);
          const stepInput = stepEntry.options.input
            ? stepEntry.options.input(stepContext)
            : workflowInput;

          try {
            const childHandle = options.taskRunner.submit(taskDef, stepInput, {
              runId: childRunId,
              tenantId: options.tenantId,
              priority: 0,
            });
            options.onChildRun?.(childRunId);
            const output = await awaitTaskResult({
              taskRunner: options.taskRunner,
              childRunId,
              signal,
              promise: childHandle.result(),
            });
            return { step: stepEntry, status: 'fulfilled' as const, value: output };
          } catch (error) {
            return { step: stepEntry, status: 'rejected' as const, reason: error };
          }
        });

        const settled = await Promise.allSettled(pendingChildren);
        let hardFailure: unknown = null;

        for (const settlement of settled) {
          // An unexpected rejection (e.g. onStepStarted threw). We don't have a step
          // reference so track as a hard failure and move on.
          if (settlement.status === 'rejected') {
            if (hardFailure === null) {
              hardFailure = settlement.reason;
            }
            continue;
          }

          const item = settlement.value;
          const taskDef = withStepOverrides(
            resolveTask(item.step, options.taskRegistry),
            item.step.options,
          );
          if (item.status === 'fulfilled') {
            results[item.step.name] = item.value;
            await options.callbacks.onStepCompleted(
              options.runId,
              item.step.name,
              taskDef.name,
              item.value,
              1,
            );
            safeEmit(
              options.eventSink,
              'orchestration.step.completed',
              {
                runId: options.runId,
                workflow: options.def.name,
                step: item.step.name,
                output: item.value,
              },
              'step.completed',
            );
            continue;
          }

          const error = toRunError(item.reason);
          results[item.step.name] = undefined;
          await options.callbacks.onStepFailed(
            options.runId,
            item.step.name,
            taskDef.name,
            error,
            taskDef.retry.maxAttempts,
            item.step.options.continueOnFailure ? 'failed' : 'failed',
          );
          safeEmit(
            options.eventSink,
            'orchestration.step.failed',
            {
              runId: options.runId,
              workflow: options.def.name,
              step: item.step.name,
              error,
            },
            'step.failed',
          );
          if (!item.step.options.continueOnFailure && hardFailure === null) {
            hardFailure = item.reason;
            failedStep = item.step.name;
          }
        }

        if (hardFailure !== null) throw hardFailure;
        continue;
      }

      const persistedStep = options.persistedState?.steps?.[entry.name];
      if (persistedStep?.status === 'completed' || persistedStep?.status === 'skipped') {
        results[entry.name] = persistedStep.output;
        continue;
      }

      const taskDef = withStepOverrides(resolveTask(entry, options.taskRegistry), entry.options);
      const stepContext = { workflowInput, results };
      if (entry.options.condition && !entry.options.condition(stepContext)) {
        results[entry.name] = undefined;
        await options.callbacks.onStepSkipped(options.runId, entry.name, taskDef.name);
        void options.eventSink?.emit('orchestration.step.skipped', {
          runId: options.runId,
          workflow: options.def.name,
          step: entry.name,
        });
        continue;
      }

      const childRunId = generateRunId();
      const stepInput = entry.options.input ? entry.options.input(stepContext) : workflowInput;
      await options.callbacks.onStepStarted(options.runId, entry.name, taskDef.name);

      try {
        const childHandle = options.taskRunner.submit(taskDef, stepInput, {
          runId: childRunId,
          tenantId: options.tenantId,
          priority: 0,
        });
        options.onChildRun?.(childRunId);
        const output = await awaitTaskResult({
          taskRunner: options.taskRunner,
          childRunId,
          signal,
          promise: childHandle.result(),
        });
        results[entry.name] = output;
        await options.callbacks.onStepCompleted(options.runId, entry.name, taskDef.name, output, 1);
        safeEmit(
          options.eventSink,
          'orchestration.step.completed',
          {
            runId: options.runId,
            workflow: options.def.name,
            step: entry.name,
            output,
          },
          'step.completed',
        );
      } catch (error) {
        const runError = toRunError(error);
        await options.callbacks.onStepFailed(
          options.runId,
          entry.name,
          taskDef.name,
          runError,
          taskDef.retry.maxAttempts,
          entry.options.continueOnFailure ? 'failed' : 'failed',
        );
        safeEmit(
          options.eventSink,
          'orchestration.step.failed',
          {
            runId: options.runId,
            workflow: options.def.name,
            step: entry.name,
            error: runError,
          },
          'step.failed',
        );
        if (entry.options.continueOnFailure) {
          results[entry.name] = undefined;
          continue;
        }
        failedStep = entry.name;
        throw error;
      }
    }

    const output = options.def.outputMapper ? options.def.outputMapper(results) : results;
    if (options.def.output) {
      options.def.output.parse(output);
    }

    const onComplete = normalizeHook(options.def.onComplete);
    if (onComplete) {
      try {
        await onComplete.handler({
          runId: options.runId,
          output,
          durationMs: Date.now() - startedAt,
          tenantId: options.tenantId,
          services: options.services,
        });
      } catch (hookError) {
        reportWorkflowHookError({
          eventSink: options.eventSink,
          runId: options.runId,
          workflow: options.def.name,
          hook: 'onComplete',
          error: hookError,
        });
        if (!onComplete.continueOnHookError) {
          failedStep = 'hook:onComplete';
          throw new WorkflowHookError('onComplete', hookError);
        }
      }
    }

    await options.callbacks.onCompleted(options.runId, output, Date.now() - startedAt);
    safeEmit(
      options.eventSink,
      'orchestration.workflow.completed',
      {
        runId: options.runId,
        workflow: options.def.name,
        output,
        durationMs: Date.now() - startedAt,
        tenantId: options.tenantId,
      },
      'workflow.completed',
    );

    return output;
  } catch (error) {
    const aborted = signal.aborted;
    const reason = aborted ? abortMessage(signal) : undefined;
    const status = aborted && reason === 'Run cancelled' ? 'cancelled' : 'failed';
    const runError = toRunError(
      status === 'cancelled'
        ? new Error('Run cancelled')
        : aborted && reason === 'Workflow timed out'
          ? new Error('Workflow timed out')
          : error,
    );
    await options.callbacks.onFailed(
      options.runId,
      runError,
      failedStep,
      Date.now() - startedAt,
      status,
    );
    if (status !== 'cancelled') {
      safeEmit(
        options.eventSink,
        'orchestration.workflow.failed',
        {
          runId: options.runId,
          workflow: options.def.name,
          error: runError,
          failedStep,
          tenantId: options.tenantId,
        },
        'workflow.failed',
      );
    }
    const onFail = normalizeHook(options.def.onFail);
    if (onFail) {
      try {
        await onFail.handler({
          runId: options.runId,
          error: error instanceof Error ? error : new Error(String(error)),
          failedStep,
          tenantId: options.tenantId,
          services: options.services,
        });
      } catch (hookError) {
        reportWorkflowHookError({
          eventSink: options.eventSink,
          runId: options.runId,
          workflow: options.def.name,
          hook: 'onFail',
          error: hookError,
        });
        if (!onFail.continueOnHookError) {
          throw new WorkflowHookError('onFail', hookError);
        }
      }
    }
    throw error;
  } finally {
    cleanup();
  }
}
