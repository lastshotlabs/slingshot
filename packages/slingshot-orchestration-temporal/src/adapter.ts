import {
  ApplicationFailure,
  Client,
  type Connection,
  ScheduleNotFoundError,
  WorkflowFailedError,
} from '@temporalio/client';
import { TimeoutError, withTimeout } from '@lastshotlabs/slingshot-core';
import type { Logger } from '@lastshotlabs/slingshot-core';
import { noopLogger } from '@lastshotlabs/slingshot-core';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  OrchestrationAdapter,
  Run,
  RunFilter,
  RunHandle,
  RunOptions,
  ScheduleHandle,
  WorkflowRun,
} from '@lastshotlabs/slingshot-orchestration';
import { OrchestrationError, createCachedRunHandle } from '@lastshotlabs/slingshot-orchestration';
import { toRunError, wrapTemporalError } from './errors';
import { deriveTemporalRunId } from './ids';
import {
  buildSearchAttributes,
  buildVisibilityQuery,
  buildVisibilityValidationQueries,
  decodeTags,
} from './searchAttributes';
import { mapTemporalStatus } from './statusMap';
import {
  type TemporalOrchestrationAdapterOptions,
  temporalAdapterOptionsSchema,
} from './validation';

const TASK_WORKFLOW_TYPE = 'slingshotTaskWorkflow';
const WORKFLOW_WORKFLOW_TYPE = 'slingshotWorkflow';
const USER_SIGNAL_NAME = 'slingshot-signal';
const STATE_QUERY_NAME = 'slingshot-state';

interface TemporalMemo {
  kind: 'task' | 'workflow';
  name: string;
  input: unknown;
  tenantId?: string;
  priority?: number;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

interface TemporalTaskResultEnvelope {
  output: unknown;
  progress?: Run['progress'];
}

interface TemporalWorkflowResultEnvelope {
  output: unknown;
  steps: NonNullable<WorkflowRun['steps']>;
  progress?: Run['progress'];
}

interface TemporalFailureDetails {
  error: NonNullable<Run['error']>;
  failedStep?: string;
  steps?: NonNullable<WorkflowRun['steps']>;
  progress?: Run['progress'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasErrorName(value: unknown, name: string): boolean {
  return isRecord(value) && value.name === name;
}

function extractFailureDetails(error: unknown): TemporalFailureDetails | undefined {
  if (!(error instanceof WorkflowFailedError) && !hasErrorName(error, 'WorkflowFailedError')) {
    return undefined;
  }

  const cause = isRecord(error) ? error.cause : undefined;
  if (!(cause instanceof ApplicationFailure) && !hasErrorName(cause, 'ApplicationFailure')) {
    return undefined;
  }

  const details = isRecord(cause) && Array.isArray(cause.details) ? cause.details[0] : undefined;
  if (!isRecord(details) || !isRecord(details.error)) return undefined;
  if (typeof details.error.message !== 'string') return undefined;

  return {
    error: {
      message: details.error.message,
      stack: typeof details.error.stack === 'string' ? details.error.stack : undefined,
    },
    failedStep: typeof details.failedStep === 'string' ? details.failedStep : undefined,
    steps: details.steps as TemporalFailureDetails['steps'],
    progress: details.progress as TemporalFailureDetails['progress'],
  };
}

function getMemo(description: { memo?: Record<string, unknown> }): TemporalMemo {
  // Memo values are user-supplied at workflow start and shaped by Slingshot
  // into TemporalMemo. The runtime payload is opaque, so each field is
  // re-validated inline below before being read.
  const memo = (description.memo ?? {}) as Partial<TemporalMemo>;
  return {
    kind: memo.kind === 'workflow' ? 'workflow' : 'task',
    name: memo.name ?? 'unknown',
    input: memo.input,
    tenantId: memo.tenantId,
    priority: typeof memo.priority === 'number' ? memo.priority : undefined,
    tags: memo.tags,
    metadata: memo.metadata,
  };
}

function getSearchAttributePriority(
  searchAttributes?: Record<string, unknown>,
): number | undefined {
  const raw = searchAttributes?.SlingshotPriority;
  if (typeof raw === 'number') {
    return raw;
  }
  if (Array.isArray(raw) && typeof raw[0] === 'number') {
    return raw[0];
  }
  return undefined;
}

/**
 * Per-workflow concurrency cap for in-flight `maybeQueryState` polls. Two
 * concurrent callers (e.g. `getRun` and an `onProgress` poll tick) both racing
 * against a hung Temporal cluster previously stacked 60+ pending queries per
 * workflow — this Map collapses concurrent calls to a single in-flight query
 * per runId.
 */
const inFlightQueriesByRunId = new Map<
  string,
  Promise<{ progress?: Run['progress']; steps?: WorkflowRun['steps'] } | undefined>
>();

interface AdapterInstrumentation {
  onQuery?: (event: { runId: string; durationMs: number; error?: unknown }) => void;
  onSignal?: (event: { runId: string; durationMs: number; error?: unknown }) => void;
  queryTimeoutMs?: number;
}

async function maybeQueryState(
  handle: ReturnType<Client['workflow']['getHandle']>,
  runId: string,
  instrumentation: AdapterInstrumentation,
) {
  // Single-flight: if a query is already in flight for this runId reuse the
  // outstanding promise so the next caller awaits the existing query rather
  // than queuing a parallel one.
  const existing = inFlightQueriesByRunId.get(runId);
  if (existing) return existing;

  const queryTimeoutMs = instrumentation.queryTimeoutMs ?? 5_000;
  const startedAt = Date.now();
  const queryPromise = (async () => {
    try {
      const result = await withTimeout(
        handle.query<{ progress?: Run['progress']; steps?: WorkflowRun['steps'] }>(
          STATE_QUERY_NAME,
        ),
        queryTimeoutMs,
        `temporal.query(${STATE_QUERY_NAME})`,
      );
      try {
        instrumentation.onQuery?.({
          runId,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // instrumentation hooks must not break adapter operation
      }
      return result;
    } catch (err) {
      try {
        instrumentation.onQuery?.({
          runId,
          durationMs: Date.now() - startedAt,
          error: err,
        });
      } catch {
        /* ignore hook error */
      }
      // TimeoutError still maps to undefined so callers can degrade gracefully
      // rather than failing the read path.
      if (!(err instanceof TimeoutError)) {
        logger.warn('temporal state query failed', {
          runId,
          error: (err as Error)?.message ?? String(err),
        });
      }
      return undefined;
    }
  })();
  inFlightQueriesByRunId.set(runId, queryPromise);
  try {
    return await queryPromise;
  } finally {
    inFlightQueriesByRunId.delete(runId);
  }
}

/**
 * Health-check capability for the Temporal orchestration adapter.
 *
 * Returns the current health state including Temporal connection status
 * and whether the adapter has been started.
 */
export interface TemporalOrchestrationHealthCapability {
  health(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    details: Record<string, unknown>;
  }>;
}

/**
 * Creates a Temporal-backed {@link OrchestrationAdapter} that translates the
 * framework's task/workflow operations into Temporal Client calls.
 *
 * The adapter validates the supplied options, then returns an
 * `OrchestrationAdapter` whose methods map to Temporal primitives:
 *
 * - **registerTask / registerWorkflow** -- record definitions (immutable after `start()`).
 * - **runTask / runWorkflow** -- start a Temporal workflow execution with
 *   idempotent `workflowId` derivation and `USE_EXISTING` conflict policy.
 * - **getRun** -- describe + query a workflow to build a unified `Run` view
 *   including progress, steps, and terminal output/error.
 * - **cancelRun / signal** -- cancel or deliver a user-defined signal.
 * - **schedule / unschedule / listSchedules** -- manage cron-based schedules.
 * - **listRuns** -- paginated visibility query with offset/limit support.
 * - **onProgress** -- poll-based progress subscription with automatic cleanup.
 * - **start** -- verify connectivity and search-attribute availability.
 * - **shutdown** -- dispose progress pollers, close the client and (if owned)
 *   the underlying connection.
 *
 * @param rawOptions - Adapter configuration validated against {@link temporalAdapterOptionsSchema}.
 * @returns A fully wired {@link OrchestrationAdapter}.
 */
export function createTemporalOrchestrationAdapter(
  rawOptions: TemporalOrchestrationAdapterOptions & {
    structuredLogger?: Logger;
    logger?: Logger;
  },
): OrchestrationAdapter & TemporalOrchestrationHealthCapability {
  const { structuredLogger: rawLogger, ...parsedInput } = rawOptions;
  const options = temporalAdapterOptionsSchema.parse(parsedInput);
  const logger: Logger = rawLogger ?? noopLogger;
  const client = options.client as Client;
  const connection = options.connection as Connection | undefined;
  const tasks = new Map<string, AnyResolvedTask>();
  const workflows = new Map<string, AnyResolvedWorkflow>();
  // Track active onProgress disposers so shutdown can release any in-flight
  // polling intervals before closing the client/connection. Without this,
  // a late-firing tick can run a query against an already-closed connection.
  const progressIntervals = new Set<() => void>();
  let started = false;

  const instrumentation: AdapterInstrumentation = {
    queryTimeoutMs: (options as { queryTimeoutMs?: number }).queryTimeoutMs,
    onQuery: (options as { onQuery?: AdapterInstrumentation['onQuery'] }).onQuery,
    onSignal: (options as { onSignal?: AdapterInstrumentation['onSignal'] }).onSignal,
  };

  function rebuildRegistry(): void {
    // Rebuild the local worker registry from the current set of registered
    // task/workflow definitions. This is a no-op until the adapter has been
    // started and definitions have been registered.
    if (!started) return;
    for (const [name, def] of tasks) {
      workerRegistry.registerTask(name, def);
    }
    for (const [name, def] of workflows) {
      workerRegistry.registerWorkflow(name, def);
    }
  }

  function ensureMutable(): void {
    if (started) {
      throw new OrchestrationError(
        'INVALID_CONFIG',
        'Temporal orchestration adapter does not allow registration after start().',
      );
    }
  }

  function getTask(name: string): AnyResolvedTask {
    const task = tasks.get(name);
    if (!task) {
      throw new OrchestrationError('TASK_NOT_FOUND', `Task '${name}' is not registered.`);
    }
    return task;
  }

  function getWorkflow(name: string): AnyResolvedWorkflow {
    const workflow = workflows.get(name);
    if (!workflow) {
      throw new OrchestrationError('WORKFLOW_NOT_FOUND', `Workflow '${name}' is not registered.`);
    }
    return workflow;
  }

  async function startRun(
    kind: 'task' | 'workflow',
    name: string,
    input: unknown,
    opts: RunOptions | undefined,
  ): Promise<RunHandle> {
    const definition = kind === 'task' ? getTask(name) : getWorkflow(name);
    const runId = deriveTemporalRunId({
      kind,
      name,
      tenantId: opts?.tenantId,
      idempotencyKey: opts?.idempotencyKey,
    });
    const handle = await client.workflow.start(
      kind === 'task' ? TASK_WORKFLOW_TYPE : WORKFLOW_WORKFLOW_TYPE,
      {
        taskQueue: options.workflowTaskQueue,
        workflowId: runId,
        workflowIdConflictPolicy: 'USE_EXISTING',
        args: [
          {
            [`${kind}Name`]: name,
            input,
            runId,
            tenantId: opts?.tenantId,
            ...(kind === 'workflow' ? { workflowName: name } : { taskName: name }),
          },
        ],
        ...(opts?.delay ? { startDelay: opts.delay } : {}),
        memo: {
          kind,
          name,
          input,
          tenantId: opts?.tenantId,
          priority: opts?.priority,
          tags: opts?.tags,
          metadata: opts?.metadata,
        },
        searchAttributes: buildSearchAttributes(kind, name, opts) as never,
        ...(kind === 'workflow'
          ? {
              /**
               * Default workflow execution timeout is 30 days.
               * This prevents workflows from running forever if no explicit timeout
               * is configured. Callers can override this per-workflow via `definition.timeout`.
               */
              workflowExecutionTimeout: definition.timeout ?? '30 days',
            }
          : {}),
      },
    );

    return createCachedRunHandle(runId, async () => {
      const result = (await handle.result()) as
        | TemporalTaskResultEnvelope
        | TemporalWorkflowResultEnvelope;
      return result.output;
    });
  }

  return {
    registerTask(def) {
      ensureMutable();
      if (tasks.has(def.name)) {
        throw new OrchestrationError('INVALID_CONFIG', `Duplicate task '${def.name}'.`);
      }
      tasks.set(def.name, def);
      rebuildRegistry();
    },
    registerWorkflow(def) {
      ensureMutable();
      if (workflows.has(def.name)) {
        throw new OrchestrationError('INVALID_CONFIG', `Duplicate workflow '${def.name}'.`);
      }
      workflows.set(def.name, def);
      rebuildRegistry();
    },
    async health() {
      const details: Record<string, unknown> = {
        started,
        ownsConnection: !!options.ownsConnection,
      };

      if (!started) {
        return { status: 'degraded', details };
      }

      try {
        await client.connection.ensureConnected();
        details.connection = 'ok';
      } catch (err) {
        details.connection = 'error';
        details.connectionError =
          err instanceof Error ? err.message : String(err);
        return { status: 'unhealthy', details };
      }

      return { status: 'healthy', details };
    },
    async runTask(name, input, opts) {
      getTask(name);
      return startRun('task', name, input, opts);
    },
    async runWorkflow(name, input, opts) {
      getWorkflow(name);
      return startRun('workflow', name, input, opts);
    },
    async getRun(runId) {
      const handle = client.workflow.getHandle(runId);
      let description: Awaited<ReturnType<typeof handle.describe>>;
      try {
        description = await withTimeout(
          handle.describe(),
          instrumentation.queryTimeoutMs ?? 10_000,
          `temporal.describe(${runId})`,
        );
      } catch (error) {
        if ((error as { name?: string }).name === 'WorkflowNotFoundError') {
          return null;
        }
        throw wrapTemporalError(`Failed to describe workflow '${runId}'`, error);
      }

      const memo = getMemo(description);
      const status = mapTemporalStatus(description.status.name);
      const state = await maybeQueryState(handle, runId, instrumentation);

      const run: Run | WorkflowRun = {
        id: runId,
        type: memo.kind,
        name: memo.name,
        status,
        input: memo.input,
        tenantId: memo.tenantId,
        priority:
          memo.priority ??
          getSearchAttributePriority(
            description.searchAttributes as Record<string, unknown> | undefined,
          ),
        tags: memo.tags,
        metadata: memo.metadata,
        progress: state?.progress,
        createdAt: description.startTime,
        startedAt: description.executionTime ?? description.startTime,
        completedAt: description.closeTime,
        ...(memo.kind === 'workflow' ? { steps: state?.steps } : {}),
      };

      if (status === 'running' || status === 'pending') {
        return run;
      }

      try {
        const result = (await withTimeout(
          handle.result(),
          instrumentation.queryTimeoutMs ?? 10_000,
          `temporal.result(${runId})`,
        )) as TemporalTaskResultEnvelope | TemporalWorkflowResultEnvelope;
        run.output = result.output;
        run.progress = result.progress ?? run.progress;
        if (memo.kind === 'workflow' && 'steps' in result) {
          (run as WorkflowRun).steps = result.steps;
        }
        return run;
      } catch (error) {
        const details = extractFailureDetails(error);
        if (status === 'cancelled') {
          run.error = { message: 'Run cancelled' };
          run.progress = details?.progress ?? run.progress;
          if (memo.kind === 'workflow') {
            (run as WorkflowRun).steps = details?.steps ?? (run as WorkflowRun).steps;
          }
          return run;
        }
        run.error = details?.error ?? toRunError(error);
        run.progress = details?.progress ?? run.progress;
        if (memo.kind === 'workflow') {
          (run as WorkflowRun).steps = details?.steps ?? (run as WorkflowRun).steps;
        }
        return run;
      }
    },
    async cancelRun(runId) {
      const handle = client.workflow.getHandle(runId);
      try {
        await handle.cancel();
      } catch (error) {
        throw wrapTemporalError(`Failed to cancel workflow '${runId}'`, error);
      }
      return undefined;
    },
    async signal(runId, name, payload) {
      const handle = client.workflow.getHandle(runId);
      const description = await handle.describe();
      const memo = getMemo(description);
      if (memo.kind === 'task') {
        throw new OrchestrationError(
          'CAPABILITY_NOT_SUPPORTED',
          'Temporal task-wrapper runs do not support user-defined signals.',
        );
      }
      const startedAt = Date.now();
      try {
        await handle.signal(USER_SIGNAL_NAME, { name, payload });
        try {
          instrumentation.onSignal?.({
            runId,
            durationMs: Date.now() - startedAt,
          });
        } catch {
          /* ignore hook error */
        }
      } catch (err) {
        try {
          instrumentation.onSignal?.({
            runId,
            durationMs: Date.now() - startedAt,
            error: err,
          });
        } catch {
          /* ignore hook error */
        }
        throw err;
      }
    },
    async schedule(target, cron, input) {
      if (target.type === 'task') {
        getTask(target.name);
      } else {
        getWorkflow(target.name);
      }
      const scheduleId = `sched_${target.type}_${target.name}_${Date.now()}`;
      await client.schedule.create({
        scheduleId,
        spec: {
          cronExpressions: [cron],
        },
        action: {
          type: 'startWorkflow',
          workflowType: target.type === 'task' ? TASK_WORKFLOW_TYPE : WORKFLOW_WORKFLOW_TYPE,
          taskQueue: options.workflowTaskQueue,
          args: [
            {
              [`${target.type}Name`]: target.name,
              input,
              runId: `${scheduleId}-workflow`,
              ...(target.type === 'task'
                ? { taskName: target.name }
                : { workflowName: target.name }),
            },
          ],
          memo: {
            kind: target.type,
            name: target.name,
            input,
          },
          searchAttributes: buildSearchAttributes(target.type, target.name) as never,
        },
        memo: {
          target,
          cron,
          input,
        },
      });

      return {
        id: scheduleId,
        target,
        cron,
        input,
      };
    },
    async unschedule(scheduleId) {
      try {
        await client.schedule.getHandle(scheduleId).delete();
      } catch (error) {
        if (error instanceof ScheduleNotFoundError) return;
        throw wrapTemporalError(`Failed to delete schedule '${scheduleId}'`, error);
      }
    },
    async listSchedules() {
      const schedules: ScheduleHandle[] = [];
      for await (const schedule of client.schedule.list()) {
        const memo = schedule.memo as {
          target?: ScheduleHandle['target'];
          cron?: string;
          input?: unknown;
        };
        if (!memo?.target || !memo.cron) continue;
        schedules.push({
          id: schedule.scheduleId,
          target: memo.target,
          cron: memo.cron,
          input: memo.input,
          nextRunAt: schedule.info.nextActionTimes[0],
        });
      }
      return schedules;
    },
    async listRuns(filter?: RunFilter) {
      const query = buildVisibilityQuery(filter);
      const runs: Run[] = [];
      const iterable = client.workflow.list({
        ...(query ? { query } : {}),
        ...(filter?.limit ? { pageSize: filter.limit } : {}),
      });

      let skipped = 0;
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? Number.POSITIVE_INFINITY;

      for await (const execution of iterable) {
        if (skipped < offset) {
          skipped += 1;
          continue;
        }
        if (runs.length >= limit) break;
        const memo = getMemo({ memo: execution.memo });
        runs.push({
          id: execution.workflowId,
          type: memo.kind,
          name: memo.name,
          status: mapTemporalStatus(execution.status.name),
          input: memo.input,
          tenantId: memo.tenantId,
          priority:
            memo.priority ??
            getSearchAttributePriority(
              execution.searchAttributes as Record<string, unknown> | undefined,
            ),
          tags:
            memo.tags ??
            decodeTags(
              (execution.searchAttributes as Record<string, unknown> | undefined)?.SlingshotTags,
            ),
          metadata: memo.metadata,
          createdAt: execution.startTime,
          startedAt: execution.executionTime ?? execution.startTime,
          completedAt: execution.closeTime,
        });
      }

      const count = await client.workflow.count(query);
      return {
        runs,
        total: count.count,
      };
    },
    onProgress(runId, callback) {
      const handle = client.workflow.getHandle(runId);
      let lastSerialized: string | undefined;
      let disposed = false;
      let inFlight = false;
      // Track the interval handle in a stable slot so the dispose function
      // can reach it without depending on hoisting/closure ordering. This
      // also lets every early-exit branch in `poll()` clear the same timer
      // through a single helper.
      let timer: ReturnType<typeof setInterval> | undefined;

      const stop = () => {
        disposed = true;
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
        progressIntervals.delete(stop);
      };

      const poll = async () => {
        // Guard early so a tick that fired just before disposal returns
        // immediately instead of doing any work after dispose() ran.
        if (disposed || inFlight) return;
        inFlight = true;
        try {
          // Re-check after any await — disposal may have happened while the
          // previous tick was queued.
          if (disposed) return;
          const state = await maybeQueryState(handle, runId, instrumentation);
          if (disposed) return;
          if (state?.progress !== undefined) {
            const serialized = JSON.stringify(state.progress);
            if (serialized !== lastSerialized) {
              lastSerialized = serialized;
              try {
                callback(state.progress);
              } catch (callbackError) {
                // If the caller's callback throws, log it and stop polling
                // to prevent the timer from accumulating unhandled errors.
                logger.error('onProgress callback threw; stopping poll', {
                  err: callbackError instanceof Error ? callbackError.message : String(callbackError),
                });
                stop();
                return;
              }
            }
          }
          const description = await handle.describe();
          if (disposed) return;
          if (description.status.name !== 'RUNNING') {
            stop();
          }
        } catch {
          stop();
        } finally {
          inFlight = false;
        }
      };

      timer = setInterval(() => {
        void poll();
      }, 1000);
      progressIntervals.add(stop);
      void poll();

      return stop;
    },
    async start() {
      if (started) return;
      started = true;
      try {
        await client.connection.ensureConnected();
        await client.workflow.count();
        for (const query of buildVisibilityValidationQueries()) {
          await client.workflow.count(query);
        }
      } catch (error) {
        started = false;
        throw wrapTemporalError('Temporal visibility/search-attribute validation failed', error);
      }
    },
    async shutdown() {
      // Ordering: stop scheduled polling intervals → close any client-level
      // resources → close the underlying connection. Each step is wrapped
      // independently so a failure in one stage does not prevent the others
      // from running. Errors are surfaced via structured logs because
      // callers typically invoke shutdown() during process teardown when
      // throwing would mask the original exit reason.
      for (const dispose of [...progressIntervals]) {
        try {
          dispose();
        } catch (error) {
          logger.error('Failed to dispose onProgress poller during shutdown', {
            err: error instanceof Error ? error.message : String(error),
          });
        }
      }
      progressIntervals.clear();

      // The current `@temporalio/client` Client class does not expose a
      // dedicated `close()` method — its only releasable resource is the
      // connection it wraps. If a future SDK adds one, we duck-type the
      // call here so the adapter releases everything the SDK owns.
      type ClientWithClose = { close?: () => Promise<void> | void };
      const maybeClient = client as unknown as ClientWithClose;
      if (typeof maybeClient.close === 'function') {
        try {
          await maybeClient.close();
        } catch (error) {
          logger.error('Failed to close Temporal client during shutdown', {
            err: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (options.ownsConnection && connection) {
        try {
          await connection.close();
        } catch (error) {
          logger.error('Failed to close Temporal connection during shutdown', {
            err: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
}
