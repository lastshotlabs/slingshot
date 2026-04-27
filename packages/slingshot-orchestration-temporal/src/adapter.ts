import {
  ApplicationFailure,
  Client,
  type Connection,
  ScheduleNotFoundError,
  WorkflowFailedError,
} from '@temporalio/client';
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
  const memo = (description.memo ?? {}) as unknown as Partial<TemporalMemo>;
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

async function maybeQueryState(handle: ReturnType<Client['workflow']['getHandle']>) {
  try {
    return await handle.query<{ progress?: Run['progress']; steps?: WorkflowRun['steps'] }>(
      STATE_QUERY_NAME,
    );
  } catch {
    return undefined;
  }
}

export function createTemporalOrchestrationAdapter(
  rawOptions: TemporalOrchestrationAdapterOptions,
): OrchestrationAdapter {
  const options = temporalAdapterOptionsSchema.parse(rawOptions);
  const client = options.client as Client;
  const connection = options.connection as Connection | undefined;
  const tasks = new Map<string, AnyResolvedTask>();
  const workflows = new Map<string, AnyResolvedWorkflow>();
  let started = false;

  function rebuildRegistry(): void {
    // Reserved for future provider-manifest materialization.
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
        description = await handle.describe();
      } catch (error) {
        if ((error as { name?: string }).name === 'WorkflowNotFoundError') {
          return null;
        }
        throw wrapTemporalError(`Failed to describe workflow '${runId}'`, error);
      }

      const memo = getMemo(description);
      const status = mapTemporalStatus(description.status.name);
      const state = await maybeQueryState(handle);

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
        const result = (await handle.result()) as
          | TemporalTaskResultEnvelope
          | TemporalWorkflowResultEnvelope;
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
      await handle.signal(USER_SIGNAL_NAME, { name, payload });
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

      const poll = async () => {
        if (disposed || inFlight) return;
        inFlight = true;
        try {
          const state = await maybeQueryState(handle);
          if (state?.progress !== undefined) {
            const serialized = JSON.stringify(state.progress);
            if (serialized !== lastSerialized) {
              lastSerialized = serialized;
              try {
                callback(state.progress);
              } catch (callbackError) {
                // If the caller's callback throws, log it and stop polling
                // to prevent the timer from accumulating unhandled errors.
                console.error(
                  '[slingshot-orchestration-temporal] onProgress callback threw; stopping poll',
                  callbackError,
                );
                disposed = true;
                clearInterval(timer);
                return;
              }
            }
          }
          const description = await handle.describe();
          if (description.status.name !== 'RUNNING') {
            disposed = true;
            clearInterval(timer);
          }
        } catch {
          disposed = true;
          clearInterval(timer);
        } finally {
          inFlight = false;
        }
      };

      const timer = setInterval(() => {
        void poll();
      }, 1000);
      void poll();

      return () => {
        disposed = true;
        clearInterval(timer);
      };
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
      if (options.ownsConnection && connection) {
        await connection.close();
      }
    },
  };
}
