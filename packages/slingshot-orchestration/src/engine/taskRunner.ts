import type { Logger } from '@lastshotlabs/slingshot-core';
import { noopLogger } from '@lastshotlabs/slingshot-core';
import { logger } from '../internal/logger';
import { createCachedRunHandle } from '../adapter';
import { OrchestrationError } from '../errors';
import type {
  AnyResolvedTask,
  OrchestrationEventMap,
  OrchestrationEventSink,
  RunError,
  RunHandle,
  RunProgress,
} from '../types';

interface TaskRunnerSubmissionOptions {
  runId: string;
  tenantId?: string;
  priority?: number;
  delay?: number;
  log?: Console;
}

interface TaskRunnerCallbacks {
  onStarted(runId: string): void | Promise<void>;
  onProgress(runId: string, taskName: string, data: RunProgress): void | Promise<void>;
  onCompleted(
    runId: string,
    taskName: string,
    output: unknown,
    durationMs: number,
  ): void | Promise<void>;
  onFailed(
    runId: string,
    taskName: string,
    error: RunError,
    durationMs: number,
    status: 'failed' | 'cancelled',
  ): void | Promise<void>;
}

interface PendingTask {
  def: AnyResolvedTask;
  input: unknown;
  options: TaskRunnerSubmissionOptions;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueueOrder: number;
  availableAt: number;
}

interface ActiveTask {
  def: AnyResolvedTask;
  controller: AbortController;
}

export interface TaskRunner {
  submit(def: AnyResolvedTask, input: unknown, options: TaskRunnerSubmissionOptions): RunHandle;
  cancel(runId: string): Promise<void>;
  waitForIdle(): Promise<void>;
}

function toRunError(error: unknown): RunError {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function abortMessage(signal: AbortSignal): string | undefined {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return undefined;
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
        logger.error('eventSink.emit error', { label, err: String(err) });
      });
    }
  } catch (err) {
    logger.error('eventSink.emit error', { label, err: String(err) });
  }
}

function retryDelay(def: AnyResolvedTask, attempt: number): number {
  const baseDelay = def.retry.delayMs ?? 1_000;
  if (def.retry.backoff === 'exponential') {
    const computed = baseDelay * 2 ** Math.max(0, attempt - 1);
    return Math.min(computed, def.retry.maxDelayMs ?? computed);
  }
  return baseDelay;
}

export function createTaskRunner(options: {
  concurrency: number;
  callbacks: TaskRunnerCallbacks;
  eventSink?: OrchestrationEventSink;
  logger?: Logger;
  /**
   * Optional `HookServices` instance threaded into every `TaskContext.services`.
   * Provided by in-process adapters (memory, sqlite, in-process bullmq) when the
   * adapter was constructed with a `hookServices` reference. Tasks running in
   * remote isolates (Temporal worker) receive `services: undefined`.
   */
  services?: import('@lastshotlabs/slingshot-core').HookServices;
}): TaskRunner {
  const logger = options.logger ?? noopLogger;
  const pending: PendingTask[] = [];
  const active = new Map<string, ActiveTask>();
  const perTaskCounts = new Map<string, number>();
  const executionPromises = new Map<string, Promise<unknown>>();
  let enqueueCounter = 0;
  let idleResolver: (() => void) | null = null;
  let scheduleTimer: ReturnType<typeof setTimeout> | null = null;

  function resolveIdleIfNeeded(): void {
    if (pending.length === 0 && active.size === 0 && idleResolver) {
      const resolve = idleResolver;
      idleResolver = null;
      resolve();
    }
  }

  function canRun(def: AnyResolvedTask): boolean {
    if (active.size >= options.concurrency) return false;
    const count = perTaskCounts.get(def.name) ?? 0;
    if (def.concurrency !== undefined && count >= def.concurrency) return false;
    return true;
  }

  function armScheduleTimer(): void {
    if (scheduleTimer) {
      clearTimeout(scheduleTimer);
      scheduleTimer = null;
    }

    if (pending.length === 0) {
      return;
    }

    const nextAvailableAt = pending.reduce<number>(
      (earliest, candidate) => Math.min(earliest, candidate.availableAt),
      Number.POSITIVE_INFINITY,
    );

    if (!Number.isFinite(nextAvailableAt)) {
      return;
    }

    const waitMs = Math.max(0, nextAvailableAt - Date.now());
    if (waitMs === 0) {
      return;
    }

    scheduleTimer = setTimeout(() => {
      scheduleTimer = null;
      schedule();
    }, waitMs);
  }

  function pickNextIndex(): number {
    const now = Date.now();
    let selectedIndex = -1;
    let selectedPriority = Number.NEGATIVE_INFINITY;
    let selectedOrder = Number.MAX_SAFE_INTEGER;

    for (let index = 0; index < pending.length; index += 1) {
      const candidate = pending[index];
      if (candidate.availableAt > now) continue;
      if (!canRun(candidate.def)) continue;
      const candidatePriority = candidate.options.priority ?? 0;
      if (
        selectedIndex === -1 ||
        candidatePriority > selectedPriority ||
        (candidatePriority === selectedPriority && candidate.enqueueOrder < selectedOrder)
      ) {
        selectedIndex = index;
        selectedPriority = candidatePriority;
        selectedOrder = candidate.enqueueOrder;
      }
    }

    return selectedIndex;
  }

  function schedule(): void {
    if (scheduleTimer) {
      clearTimeout(scheduleTimer);
      scheduleTimer = null;
    }

    for (;;) {
      const nextIndex = pickNextIndex();
      if (nextIndex === -1) {
        armScheduleTimer();
        resolveIdleIfNeeded();
        return;
      }

      const next = pending.splice(nextIndex, 1)[0];
      const runController = new AbortController();
      active.set(next.options.runId, { def: next.def, controller: runController });
      perTaskCounts.set(next.def.name, (perTaskCounts.get(next.def.name) ?? 0) + 1);

      const execution = (async () => {
        const startedAt = Date.now();
        await options.callbacks.onStarted(next.options.runId);
        safeEmit(
          options.eventSink,
          'orchestration.task.started',
          {
            runId: next.options.runId,
            task: next.def.name,
            input: next.input,
            tenantId: next.options.tenantId,
          },
          'task.started',
        );

        try {
          let attempt = 0;
          for (;;) {
            const attemptController = new AbortController();
            const abortAttempt = () => {
              const reason = runController.signal.reason;
              attemptController.abort(
                reason instanceof Error ? reason : new Error(String(reason ?? 'Run cancelled')),
              );
            };
            if (runController.signal.aborted) {
              abortAttempt();
            } else {
              runController.signal.addEventListener('abort', abortAttempt, { once: true });
            }

            attempt += 1;
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            try {
              if (next.def.timeout !== undefined) {
                timeoutHandle = setTimeout(() => {
                  attemptController.abort(new Error('Task timed out'));
                }, next.def.timeout);
              }
              const result = await next.def.handler(next.def.input.parse(next.input), {
                attempt,
                runId: next.options.runId,
                signal: attemptController.signal,
                log: next.options.log ?? console,
                tenantId: next.options.tenantId,
                services: options.services,
                reportProgress: data => {
                  void options.callbacks.onProgress(next.options.runId, next.def.name, data);
                  safeEmit(
                    options.eventSink,
                    'orchestration.task.progress',
                    {
                      runId: next.options.runId,
                      task: next.def.name,
                      data,
                    },
                    'task.progress',
                  );
                },
              });
              const output = next.def.output.parse(result);
              await options.callbacks.onCompleted(
                next.options.runId,
                next.def.name,
                output,
                Date.now() - startedAt,
              );
              safeEmit(
                options.eventSink,
                'orchestration.task.completed',
                {
                  runId: next.options.runId,
                  task: next.def.name,
                  output,
                  durationMs: Date.now() - startedAt,
                  tenantId: next.options.tenantId,
                },
                'task.completed',
              );
              next.resolve(output);
              return output;
            } catch (error) {
              const reason = abortMessage(attemptController.signal);
              const isCancelled = attemptController.signal.aborted && reason === 'Run cancelled';
              const isTimedOut = attemptController.signal.aborted && reason === 'Task timed out';
              const shouldRetry = !isCancelled && attempt < next.def.retry.maxAttempts;
              if (shouldRetry) {
                await wait(retryDelay(next.def, attempt));
                continue;
              }

              const runError = toRunError(
                isCancelled
                  ? new Error('Run cancelled')
                  : isTimedOut
                    ? new Error('Task timed out')
                    : error,
              );
              await options.callbacks.onFailed(
                next.options.runId,
                next.def.name,
                runError,
                Date.now() - startedAt,
                isCancelled ? 'cancelled' : 'failed',
              );
              if (!isCancelled) {
                safeEmit(
                  options.eventSink,
                  'orchestration.task.failed',
                  {
                    runId: next.options.runId,
                    task: next.def.name,
                    error: runError,
                    tenantId: next.options.tenantId,
                  },
                  'task.failed',
                );
              }
              next.reject(
                isCancelled ? new OrchestrationError('ADAPTER_ERROR', 'Run cancelled') : error,
              );
              return undefined;
            } finally {
              runController.signal.removeEventListener('abort', abortAttempt);
              if (timeoutHandle) clearTimeout(timeoutHandle);
            }
          }
        } finally {
          active.delete(next.options.runId);
          const count = (perTaskCounts.get(next.def.name) ?? 1) - 1;
          if (count <= 0) {
            perTaskCounts.delete(next.def.name);
          } else {
            perTaskCounts.set(next.def.name, count);
          }
          executionPromises.delete(next.options.runId);
          schedule();
        }
      })();

      executionPromises.set(next.options.runId, execution);
    }
  }

  return {
    submit(def, input, submissionOptions) {
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.push({
          def,
          input,
          options: submissionOptions,
          resolve,
          reject,
          enqueueOrder: enqueueCounter,
          availableAt: Date.now() + Math.max(0, submissionOptions.delay ?? 0),
        });
        enqueueCounter += 1;
        schedule();
      });
      promise.catch(err => {
        const runError = err instanceof Error ? err : new Error(String(err));
        logger.error('orchestration.task.postReturnError', {
          runId: submissionOptions.runId,
          task: def.name,
          tenantId: submissionOptions.tenantId,
          error: { message: runError.message, stack: runError.stack },
        });
        if (options.eventSink) {
          try {
            const result = options.eventSink.emit('orchestration.task.postReturnError', {
              runId: submissionOptions.runId,
              task: def.name,
              error: { message: runError.message, stack: runError.stack },
              tenantId: submissionOptions.tenantId,
            });
            if (result && typeof (result as Promise<void>).catch === 'function') {
              (result as Promise<void>).catch(emitErr => {
                logger.error('orchestration.eventSink.emitError', {
                  label: 'task.postReturnError',
                  error:
                    emitErr instanceof Error
                      ? { message: emitErr.message, stack: emitErr.stack }
                      : { message: String(emitErr) },
                });
              });
            }
          } catch (emitErr) {
            logger.error('orchestration.eventSink.emitError', {
              label: 'task.postReturnError',
              error:
                emitErr instanceof Error
                  ? { message: emitErr.message, stack: emitErr.stack }
                  : { message: String(emitErr) },
            });
          }
        }
      });
      executionPromises.set(submissionOptions.runId, promise);
      return createCachedRunHandle(submissionOptions.runId, () => promise);
    },
    async cancel(runId) {
      const pendingIndex = pending.findIndex(entry => entry.options.runId === runId);
      if (pendingIndex >= 0) {
        const [entry] = pending.splice(pendingIndex, 1);
        entry.reject(new OrchestrationError('ADAPTER_ERROR', 'Run cancelled'));
        executionPromises.delete(runId);
        // Promote next pending task now that a slot may have freed up
        schedule();
        return;
      }

      const activeEntry = active.get(runId);
      if (activeEntry) {
        activeEntry.controller.abort(new Error('Run cancelled'));
      }
    },
    waitForIdle() {
      if (pending.length === 0 && active.size === 0) {
        return Promise.resolve();
      }
      return new Promise<void>(resolve => {
        idleResolver = resolve;
      });
    },
  };
}
