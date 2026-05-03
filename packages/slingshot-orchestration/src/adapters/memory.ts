import { logger } from '../internal/logger';
import { createCachedRunHandle, generateRunId } from '../adapter';
import { createTaskRunner } from '../engine/taskRunner';
import { executeWorkflow } from '../engine/workflowRunner';
import { OrchestrationError } from '../errors';
import { createIdempotencyScope } from '../idempotency';
import { assertPayloadSize, resolveMaxPayloadBytes } from '../serialization';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  ObservabilityCapability,
  OrchestrationAdapter,
  OrchestrationEventSink,
  Run,
  RunProgress,
  ScheduleCapability,
  ScheduleHandle,
  SignalCapability,
  WorkflowRun,
} from '../types';
import { memoryAdapterOptionsSchema } from '../validation';

function matchesTags(
  runTags: Record<string, string> | undefined,
  filterTags: Record<string, string>,
): boolean {
  if (!runTags) return false;
  return Object.entries(filterTags).every(([key, value]) => runTags[key] === value);
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
      reject(signal.reason instanceof Error ? signal.reason : new Error('Run cancelled'));
      return;
    }

    onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Run cancelled'));
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
    maxPayloadBytes?: number;
    logger?: import('@lastshotlabs/slingshot-core').Logger;
  } = {},
): OrchestrationAdapter & ObservabilityCapability & SignalCapability & ScheduleCapability & {
  health(): { status: 'healthy' | 'degraded'; details: Record<string, unknown> };
} {
  const parsed = memoryAdapterOptionsSchema.parse({
    concurrency: options.concurrency,
    maxPayloadBytes: options.maxPayloadBytes,
  });
  const maxPayloadBytes = resolveMaxPayloadBytes(parsed.maxPayloadBytes, 'memory adapter');
  const taskRegistry = new Map<string, AnyResolvedTask>();
  const workflowRegistry = new Map<string, AnyResolvedWorkflow>();
  const runs = new Map<string, Run | WorkflowRun>();
  const resultPromises = new Map<string, Promise<unknown>>();
  const progressListeners = new Map<string, Map<string, (data: RunProgress | undefined) => void>>();
  const idempotencyKeys = new Map<string, string>();
  // Map of in-flight idempotency promises. Keyed by scoped idempotency key, the
  // value is a Promise that resolves to the runId once the run has been fully
  // claimed (run record created, idempotency key persisted, handle ready).
  // Concurrent callers awaiting the same key all observe the same Promise and
  // therefore the same handle, eliminating the race between has() and add().
  const inFlightIdempotency = new Map<string, Promise<string>>();
  const workflowControllers = new Map<string, AbortController>();
  const workflowChildren = new Map<string, Set<string>>();
  const delayedWorkflowStarts = new Map<string, AbortController>();
  // Signal infrastructure
  const signalQueues = new Map<string, Array<{ name: string; payload: unknown; receivedAt: Date }>>();
  // Schedule infrastructure
  const schedules = new Map<string, ScheduleHandle & { _timeout?: ReturnType<typeof setTimeout> }>();
  let scheduleCheckerInterval: ReturnType<typeof setInterval> | undefined;

  function parseCronNext(cron: string, from: Date = new Date()): Date | null {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [minStr, hourStr, domStr, monthStr, dowStr] = parts;
    const minute = parseInt(minStr, 10);
    const hour = parseInt(hourStr, 10);
    const dom = parseInt(domStr, 10);
    const month = parseInt(monthStr, 10);
    const dow = parseInt(dowStr, 10);
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1);
    const maxIter = 2 * 365 * 24 * 60;
    for (let i = 0; i < maxIter; i++) {
      const m = next.getMinutes();
      const h = next.getHours();
      const d = next.getDate();
      const mo = next.getMonth() + 1;
      const dw = next.getDay();
      const minuteMatch = isNaN(minute) || minStr === '*' || minute === m;
      const hourMatch = isNaN(hour) || hourStr === '*' || hour === h;
      const domMatch = isNaN(dom) || domStr === '*' || dom === d;
      const monthMatch = isNaN(month) || monthStr === '*' || month === mo;
      const dowMatch = isNaN(dow) || dowStr === '*' || dow === dw;
      if (minuteMatch && hourMatch && domMatch && monthMatch && dowMatch) {
        return next;
      }
      next.setMinutes(next.getMinutes() + 1);
    }
    return null;
  }

  function startScheduleChecker(
    adapterApi: {
      runTask(name: string, input: unknown): Promise<unknown>;
      runWorkflow(name: string, input: unknown): Promise<unknown>;
    },
  ): void {
    if (scheduleCheckerInterval) return;
    scheduleCheckerInterval = setInterval(() => {
      if (shuttingDown) return;
      const now = new Date();
      for (const [id, sched] of schedules) {
        if (sched._timeout) continue;
        const nextRun = sched.nextRunAt ?? parseCronNext(sched.cron, now);
        if (!nextRun) continue;
        schedules.set(id, { ...sched, nextRunAt: nextRun });
        if (nextRun <= now) {
          void (async () => {
            try {
              if (sched.target.type === 'task') {
                await adapterApi.runTask(sched.target.name, sched.input ?? {});
              } else {
                await adapterApi.runWorkflow(sched.target.name, sched.input ?? {});
              }
            } catch (err) {
              logger.error('[slingshot-orchestration] Scheduled run failed', {
                scheduleId: id,
                target: sched.target,
                cron: sched.cron,
                err: err instanceof Error ? err.message : String(err),
              });
            }
          })();
          const nextAfter = new Date(Date.now() + 60_000);
          const computed = parseCronNext(sched.cron, nextAfter);
          const current = schedules.get(id);
          if (current) schedules.set(id, { ...current, nextRunAt: computed ?? undefined });
        } else {
          const delay = nextRun.getTime() - now.getTime();
          const timeout = setTimeout(() => {
            const existingTimeout = schedules.get(id)?._timeout;
            if (existingTimeout) clearTimeout(existingTimeout);
            void (async () => {
              try {
                if (sched.target.type === 'task') {
                  await adapterApi.runTask(sched.target.name, sched.input ?? {});
                } else {
                  await adapterApi.runWorkflow(sched.target.name, sched.input ?? {});
                }
              } catch (err) {
                logger.error('[slingshot-orchestration] Scheduled run failed', {
                  scheduleId: id,
                  target: sched.target,
                  cron: sched.cron,
                  err: err instanceof Error ? err.message : String(err),
                });
              }
            })();
            const nextAfter = new Date(Date.now() + 60_000);
            const computed = parseCronNext(sched.cron, nextAfter);
            const current = schedules.get(id);
            if (current) schedules.set(id, { ...current, nextRunAt: computed ?? undefined, _timeout: undefined });
          }, delay);
          const current = schedules.get(id);
          if (current) schedules.set(id, { ...current, _timeout: timeout });
        }
      }
    }, 30_000);
  }

  let started = false;
  let shuttingDown = false;

  function ensureStarted(): Promise<void> {
    if (started) return Promise.resolve();
    started = true;
    return Promise.resolve();
  }

  function notifyProgress(runId: string, progress: RunProgress | undefined): void {
    for (const listener of progressListeners.get(runId)?.values() ?? []) {
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
    logger: options.logger,
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
      onCompleted(runId, taskName, output) {
        const run = runs.get(runId);
        if (!run) return;
        try {
          assertPayloadSize(output, maxPayloadBytes, `task '${taskName}' output`);
        } catch (error) {
          run.status = 'failed';
          run.error = {
            message: error instanceof Error ? error.message : `task '${taskName}' output rejected`,
          };
          run.completedAt = new Date();
          notifyProgress(runId, run.progress);
          resultPromises.delete(runId);
          progressListeners.delete(runId);
          return;
        }
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

      assertPayloadSize(input, maxPayloadBytes, `task '${name}' input`);

      const scopedIdempotencyKey = createIdempotencyScope({ type: 'task', name }, opts ?? {});
      if (scopedIdempotencyKey) {
        const existingRunId = idempotencyKeys.get(scopedIdempotencyKey);
        if (existingRunId) {
          return createCachedRunHandle(existingRunId, () => loadRunResult(existingRunId));
        }
        // Atomically claim the in-flight slot. Use a Map<key, Promise<runId>>
        // so concurrent callers awaiting the same key observe the same runId
        // without ever passing a stale has()/add() check.
        const inFlight = inFlightIdempotency.get(scopedIdempotencyKey);
        if (inFlight) {
          const settledRunId = await inFlight;
          return createCachedRunHandle(settledRunId, () => loadRunResult(settledRunId));
        }
      }

      const runId = generateRunId();
      // Synchronously publish the in-flight promise so any caller that arrives
      // between this point and idempotencyKeys.set() observes the same runId.
      let resolveClaim: ((value: string) => void) | undefined;
      let rejectClaim: ((reason: unknown) => void) | undefined;
      if (scopedIdempotencyKey) {
        const claim = new Promise<string>((resolve, reject) => {
          resolveClaim = resolve;
          rejectClaim = reject;
        });
        // Suppress unhandled rejection until a concurrent caller awaits.
        claim.catch(() => {});
        inFlightIdempotency.set(scopedIdempotencyKey, claim);
        idempotencyKeys.set(scopedIdempotencyKey, runId);
      }

      try {
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
        if (scopedIdempotencyKey) {
          resolveClaim?.(runId);
          inFlightIdempotency.delete(scopedIdempotencyKey);
        }
        return createCachedRunHandle(runId, () => handle.result());
      } catch (err) {
        if (scopedIdempotencyKey) {
          rejectClaim?.(err);
          inFlightIdempotency.delete(scopedIdempotencyKey);
          idempotencyKeys.delete(scopedIdempotencyKey);
        }
        throw err;
      }
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

      assertPayloadSize(input, maxPayloadBytes, `workflow '${name}' input`);

      const scopedIdempotencyKey = createIdempotencyScope({ type: 'workflow', name }, opts ?? {});
      if (scopedIdempotencyKey) {
        const existingRunId = idempotencyKeys.get(scopedIdempotencyKey);
        if (existingRunId) {
          return createCachedRunHandle(existingRunId, () => loadRunResult(existingRunId));
        }
        // Atomically claim the in-flight slot. See runTask above for the
        // rationale behind the Map<key, Promise<runId>> pattern.
        const inFlight = inFlightIdempotency.get(scopedIdempotencyKey);
        if (inFlight) {
          const settledRunId = await inFlight;
          return createCachedRunHandle(settledRunId, () => loadRunResult(settledRunId));
        }
      }

      const runId = generateRunId();
      let resolveClaim: ((value: string) => void) | undefined;
      if (scopedIdempotencyKey) {
        const claim = new Promise<string>(resolve => {
          resolveClaim = resolve;
        });
        claim.catch(() => {});
        inFlightIdempotency.set(scopedIdempotencyKey, claim);
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

      // Suppress unhandled-rejection until the caller attaches via handle.result()
      promise.catch(() => {});
      resultPromises.set(runId, promise);
      if (scopedIdempotencyKey) {
        resolveClaim?.(runId);
        inFlightIdempotency.delete(scopedIdempotencyKey);
      }
      return createCachedRunHandle(runId, () => promise);
    },
    async getRun(runId) {
      const run = runs.get(runId);
      if (!run) return null;
      if (run.type === 'workflow') {
        const pendingSignals = signalQueues.get(runId) ?? [];
        (run as WorkflowRun & { pendingSignals?: unknown[] }).pendingSignals = [...pendingSignals];
      }
      return run;
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
        return undefined;
      }

      delayedWorkflowStarts.get(runId)?.abort(new Error('Run cancelled'));
      workflowControllers.get(runId)?.abort(new Error('Run cancelled'));
      for (const childRunId of workflowChildren.get(runId) ?? []) {
        await taskRunner.cancel(childRunId);
      }
      run.status = 'cancelled';
      run.completedAt = new Date();
      run.error = { message: 'Run cancelled' };
      return undefined;
    },
    async start() {
      started = true;
      if (schedules.size > 0) startScheduleChecker(this);
    },
    async shutdown() {
      shuttingDown = true;
      if (scheduleCheckerInterval) {
        clearInterval(scheduleCheckerInterval);
        scheduleCheckerInterval = undefined;
      }
      for (const [, sched] of schedules) {
        if (sched._timeout) clearTimeout(sched._timeout);
      }
      schedules.clear();
      for (const controller of delayedWorkflowStarts.values()) {
        controller.abort(new Error('Run cancelled'));
      }
      for (const controller of workflowControllers.values()) {
        controller.abort(new Error('Run cancelled'));
      }
      const SHUTDOWN_TIMEOUT_MS = 30_000;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<void>(resolve => {
        timeoutHandle = setTimeout(() => {
          logger.warn('shutdown timed out — some tasks may still be running', {
            timeoutMs: SHUTDOWN_TIMEOUT_MS,
          });
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
      });
      try {
        await Promise.race([taskRunner.waitForIdle(), timeoutPromise]);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
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
      const subscriptionId = crypto.randomUUID();
      const listeners =
        progressListeners.get(runId) ?? new Map<string, (data: RunProgress | undefined) => void>();
      listeners.set(subscriptionId, callback);
      progressListeners.set(runId, listeners);
      return () => {
        listeners.delete(subscriptionId);
        if (listeners.size === 0) {
          progressListeners.delete(runId);
        }
      };
    },
    // ── SignalCapability ──────────────────────────────────────────────────────
    async signal(runId, name, payload) {
      const run = runs.get(runId);
      if (!run) {
        throw new OrchestrationError('RUN_NOT_FOUND', `Run '${runId}' not found`);
      }
      if (run.type !== 'workflow') {
        throw new OrchestrationError(
          'VALIDATION_FAILED',
          `Cannot signal '${runId}': only workflow runs accept signals.`,
        );
      }
      const queue = signalQueues.get(runId) ?? [];
      queue.push({ name, payload, receivedAt: new Date() });
      signalQueues.set(runId, queue);
    },
    // ── ScheduleCapability ────────────────────────────────────────────────────
    async schedule(target, cron, input) {
      const id = generateRunId();
      const nextRunAt = parseCronNext(cron);
      const handle: ScheduleHandle & { _timeout?: ReturnType<typeof setTimeout> } = {
        id,
        target,
        cron,
        input,
        nextRunAt: nextRunAt ?? undefined,
      };
      schedules.set(id, handle);
      if (started) startScheduleChecker(this);
      return { id, target, cron, input, nextRunAt: nextRunAt ?? undefined };
    },
    async unschedule(scheduleId) {
      const sched = schedules.get(scheduleId);
      if (!sched) {
        throw new OrchestrationError('RUN_NOT_FOUND', `Schedule '${scheduleId}' not found`);
      }
      if (sched._timeout) clearTimeout(sched._timeout);
      schedules.delete(scheduleId);
    },
    async listSchedules() {
      return [...schedules.values()].map(({ _timeout, ...handle }) => {
        void _timeout;
        return handle;
      });
    },
    health() {
      const details: Record<string, unknown> = {
        started,
        shuttingDown,
      };
      if (shuttingDown) {
        return { status: 'degraded', details };
      }
      return { status: 'healthy', details };
    },
  };
}
