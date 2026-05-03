// ---------------------------------------------------------------------------
// Cancellation persistence, snapshot serialization, job cancellation,
// and run-lookup helpers for the BullMQ orchestration adapter.
// ---------------------------------------------------------------------------

import { Job, type JobType } from 'bullmq';
import type { Queue, QueueEvents } from 'bullmq';
import { withTimeout } from '@lastshotlabs/slingshot-core';
import type { Logger } from '@lastshotlabs/slingshot-core';
import {
  OrchestrationError,
  type CancelOutcome,
  type OrchestrationEventSink,
  type Run,
  type StepRun,
  type WorkflowRun,
} from '@lastshotlabs/slingshot-orchestration';
import { mapBullMQStatus } from '../statusMap';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CANCELLATION_ERROR_MESSAGE = 'Run cancelled';

// ---------------------------------------------------------------------------
// Serialization types
// ---------------------------------------------------------------------------

export type SerializedStepRun = Omit<StepRun, 'startedAt' | 'completedAt'> & {
  startedAt?: string;
  completedAt?: string;
};

export type SerializedRunSnapshot = Omit<Run, 'createdAt' | 'startedAt' | 'completedAt'> & {
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  steps?: Record<string, SerializedStepRun>;
};

export interface CancellationSnapshotStoreClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  zadd(key: string, score: number | string, member: string): Promise<unknown>;
  zrange(key: string, start: number, end: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export interface RunRecord {
  job: Job<Record<string, unknown>>;
  queue: Queue;
  queueEvents: QueueEvents;
  type: 'task' | 'workflow';
  name: string;
}

// ---------------------------------------------------------------------------
// Pure serialization helpers
// ---------------------------------------------------------------------------

export function serializeStepRun(step: StepRun): SerializedStepRun {
  return {
    ...step,
    startedAt: step.startedAt?.toISOString(),
    completedAt: step.completedAt?.toISOString(),
  };
}

export function serializeRunSnapshot(run: Run | WorkflowRun): SerializedRunSnapshot {
  const base: SerializedRunSnapshot = {
    id: run.id,
    type: run.type,
    name: run.name,
    status: run.status,
    input: run.input,
    output: run.output,
    error: run.error,
    tenantId: run.tenantId,
    priority: run.priority,
    tags: run.tags,
    metadata: run.metadata,
    progress: run.progress,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
  };

  if (run.type !== 'workflow') {
    return base;
  }

  const workflowRun = run as WorkflowRun;
  if (!workflowRun.steps) {
    return base;
  }

  return {
    ...base,
    steps: Object.fromEntries(
      Object.entries(workflowRun.steps).map(([stepName, step]) => [
        stepName,
        serializeStepRun(step),
      ]),
    ),
  };
}

export function errInfo(err: unknown): Record<string, unknown> | string {
  if (err === null || err === undefined) return String(err);
  if (typeof err !== 'object') return String(err);
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
  const out: Record<string, unknown> = {};
  if (typeof e.name === 'string') out.name = e.name;
  if (typeof e.message === 'string') out.message = e.message;
  if (typeof e.code === 'string') out.code = e.code;
  if (e.cause !== undefined)
    out.cause = e.cause instanceof Error ? e.cause.message : String(e.cause);
  return out;
}

export function deserializeRunSnapshot(
  value: string,
  logger?: Logger,
  reportError?: (err: unknown) => void,
): Run | WorkflowRun | null {
  try {
    const parsed = JSON.parse(value) as SerializedRunSnapshot;
    const base: Run = {
      ...parsed,
      type: parsed.type,
      createdAt: new Date(parsed.createdAt),
      startedAt: parsed.startedAt ? new Date(parsed.startedAt) : undefined,
      completedAt: parsed.completedAt ? new Date(parsed.completedAt) : undefined,
    };
    if (parsed.type === 'workflow') {
      return {
        ...base,
        type: 'workflow',
        steps: parsed.steps
          ? Object.fromEntries(
              Object.entries(parsed.steps).map(([stepName, step]) => [
                stepName,
                {
                  ...step,
                  startedAt: step.startedAt ? new Date(step.startedAt) : undefined,
                  completedAt: step.completedAt ? new Date(step.completedAt) : undefined,
                } satisfies StepRun,
              ]),
            )
          : undefined,
      };
    }
    return base;
  } catch (err) {
    if (reportError) reportError(err);
    if (logger) {
      logger.error('Failed to deserialize run snapshot', { err: errInfo(err) });
    } else {
      console.error('[slingshot-orchestration-bullmq] Failed to deserialize run snapshot:', err);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Job / run helpers
// ---------------------------------------------------------------------------

export function getRunId(job: Job<Record<string, unknown>>): string {
  const rawRunId = typeof job.data['runId'] === 'string' ? (job.data['runId'] as string) : '';
  return rawRunId.length > 0 ? rawRunId : String(job.id);
}

export function isCancelledFailedJob(
  job: Job<Record<string, unknown>>,
  state: JobType | 'unknown',
): boolean {
  return state === 'failed' && job.failedReason === CANCELLATION_ERROR_MESSAGE;
}

export function toRun(
  job: Job<Record<string, unknown>>,
  type: 'task' | 'workflow',
): Run | WorkflowRun {
  const progress = job.progress && typeof job.progress === 'object' ? job.progress : undefined;
  const runId = getRunId(job);
  return {
    id: runId,
    type,
    name: String(job.data['taskName'] ?? job.data['workflowName'] ?? job.name),
    status: 'pending',
    input: job.data['input'],
    output: job.returnvalue,
    error:
      typeof job.failedReason === 'string' && job.failedReason.length > 0
        ? { message: job.failedReason }
        : undefined,
    tenantId:
      typeof job.data['tenantId'] === 'string' ? (job.data['tenantId'] as string) : undefined,
    priority: typeof job.opts.priority === 'number' ? job.opts.priority : undefined,
    tags:
      job.data['tags'] && typeof job.data['tags'] === 'object'
        ? (job.data['tags'] as Record<string, string>)
        : undefined,
    metadata:
      job.data['metadata'] && typeof job.data['metadata'] === 'object'
        ? (job.data['metadata'] as Record<string, unknown>)
        : undefined,
    progress: progress as Run['progress'],
    createdAt: new Date(job.timestamp),
    startedAt: job.processedOn ? new Date(job.processedOn) : undefined,
    completedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
  };
}

export function createCancelledSnapshot(
  job: Job<Record<string, unknown>>,
  type: 'task' | 'workflow',
  now = new Date(),
): Run | WorkflowRun {
  return {
    ...toRun(job, type),
    status: 'cancelled',
    output: undefined,
    error: { message: CANCELLATION_ERROR_MESSAGE },
    completedAt: now,
  };
}

export function matchesTags(
  runTags: Record<string, string> | undefined,
  filterTags: Record<string, string>,
): boolean {
  if (!runTags) return false;
  return Object.entries(filterTags).every(([key, value]) => runTags[key] === value);
}

// ---------------------------------------------------------------------------
// Lookups / states
// ---------------------------------------------------------------------------

export const lookupStates: JobType[] = [
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'completed',
  'failed',
  'waiting-children',
];

export function mapStatuses(filterStatus?: string | string[]): JobType[] {
  const statuses = filterStatus
    ? Array.isArray(filterStatus)
      ? filterStatus
      : [filterStatus]
    : ['pending', 'running', 'completed', 'failed'];
  const states = new Set<JobType>();
  for (const status of statuses) {
    switch (status) {
      case 'pending':
        states.add('waiting');
        states.add('delayed');
        states.add('prioritized');
        break;
      case 'running':
        states.add('active');
        break;
      case 'completed':
        states.add('completed');
        break;
      case 'failed':
      case 'cancelled':
        states.add('failed');
        break;
      case 'skipped':
        break;
    }
  }
  return [...states];
}

// ---------------------------------------------------------------------------
// Cancellation watcher (polling-based)
// ---------------------------------------------------------------------------

export function createCancellationWatcher(
  cancelledRunSignals: Map<string, string>,
  runId: string,
): { promise: Promise<never>; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const promise = new Promise<never>((_, reject) => {
    const poll = () => {
      if (stopped) return;
      const message = cancelledRunSignals.get(runId);
      if (message) {
        stop();
        reject(new Error(message));
        return;
      }
      timer = setTimeout(poll, 50);
    };
    poll();
  });

  return { promise, stop };
}

// ---------------------------------------------------------------------------
// Stateful cancellation management factory
// ---------------------------------------------------------------------------

export interface CancellationState {
  prefix: string;
  cancelledRunSignals: Map<string, string>;
  cancelledRunsIndexKey: string;
  defaultTaskQueue: Queue;
  workflowQueue: Queue;
  namedQueues: Map<string, Queue>;
  namedQueueEvents: Map<string, QueueEvents>;
  taskQueueEvents: QueueEvents | null;
  workflowQueueEvents: QueueEvents | null;
  metrics: { runIdCacheEvictions: number; runIdScanMisses: number };
  structuredLogger: Logger;
  eventSink?: OrchestrationEventSink;
}

export function createCancellationFns(state: CancellationState) {
  function getCancelledRunKey(runId: string): string {
    return `${state.prefix}:cancelled:run:${runId}`;
  }

  async function getCancellationSnapshotStore(): Promise<CancellationSnapshotStoreClient> {
    return (await state.defaultTaskQueue.client) as CancellationSnapshotStoreClient;
  }

  async function quarantineMalformedSnapshot(
    client: CancellationSnapshotStoreClient,
    runId: string,
    payload: string,
    parseError: unknown,
  ): Promise<void> {
    const malformedKey = `${getCancelledRunKey(runId)}:malformed`;
    try {
      await client.set(malformedKey, payload);
    } catch (err) {
      state.structuredLogger.error('orchestration.bullmq.snapshotQuarantineFailed', {
        runId,
        error:
          err instanceof Error
            ? { message: err.message, stack: err.stack }
            : { message: String(err) },
      });
    }
    state.structuredLogger.error('orchestration.bullmq.snapshotMalformed', {
      runId,
      malformedKey,
      error:
        parseError instanceof Error
          ? { message: parseError.message, stack: parseError.stack }
          : { message: String(parseError) },
    });
    if (state.eventSink) {
      try {
        const result = state.eventSink.emit('orchestration.bullmq.snapshotMalformed', {
          runId,
          malformedKey,
          error:
            parseError instanceof Error
              ? { message: parseError.message }
              : { message: String(parseError) },
        });
        if (result) {
          result.catch(emitErr => {
            state.structuredLogger.error('orchestration.bullmq.snapshotMalformed.emitError', {
              error:
                emitErr instanceof Error
                  ? { message: emitErr.message, stack: emitErr.stack }
                  : { message: String(emitErr) },
            });
          });
        }
      } catch (emitErr) {
        state.structuredLogger.error('orchestration.bullmq.snapshotMalformed.emitError', {
          error:
            emitErr instanceof Error
              ? { message: emitErr.message, stack: emitErr.stack }
              : { message: String(emitErr) },
        });
      }
    }
  }

  async function getPersistedCancelledSnapshot(
    runId: string,
  ): Promise<(Run | WorkflowRun) | null> {
    const client = await getCancellationSnapshotStore();
    const payload = await client.get(getCancelledRunKey(runId));
    if (!payload) {
      return null;
    }
    let parseError: unknown = null;
    const snapshot = deserializeRunSnapshot(payload, state.structuredLogger, err => {
      parseError = err;
    });
    if (snapshot) {
      return snapshot;
    }
    await quarantineMalformedSnapshot(client, runId, payload, parseError);
    return null;
  }

  async function listPersistedCancelledSnapshots(): Promise<Array<Run | WorkflowRun>> {
    const client = await getCancellationSnapshotStore();
    const runIds = await client.zrange(state.cancelledRunsIndexKey, 0, -1);
    if (runIds.length === 0) {
      return [];
    }

    const payloads = await client.mget(...runIds.map(runId => getCancelledRunKey(runId)));
    const snapshots: Array<Run | WorkflowRun> = [];
    const staleRunIds: string[] = [];
    for (const [index, payload] of payloads.entries()) {
      const runId = runIds[index];
      if (!runId) continue;
      if (!payload) {
        staleRunIds.push(runId);
        continue;
      }
      let parseError: unknown = null;
      const snapshot = deserializeRunSnapshot(payload, state.structuredLogger, err => {
        parseError = err;
      });
      if (!snapshot) {
        await quarantineMalformedSnapshot(client, runId, payload, parseError);
        staleRunIds.push(runId);
        continue;
      }
      snapshots.push(snapshot);
    }

    if (staleRunIds.length > 0) {
      await client.zrem(state.cancelledRunsIndexKey, ...staleRunIds);
      await client.del(...staleRunIds.map(runId => getCancelledRunKey(runId)));
    }

    return snapshots;
  }

  async function persistCancelledSnapshot(snapshot: Run | WorkflowRun): Promise<void> {
    const client = await getCancellationSnapshotStore();
    await client.set(
      getCancelledRunKey(snapshot.id),
      JSON.stringify(serializeRunSnapshot(snapshot)),
    );
    await client.zadd(state.cancelledRunsIndexKey, snapshot.createdAt.getTime(), snapshot.id);
  }

  async function deletePersistedCancelledSnapshot(runId: string): Promise<void> {
    const client = await getCancellationSnapshotStore();
    await client.del(getCancelledRunKey(runId));
    await client.zrem(state.cancelledRunsIndexKey, runId);
  }

  async function toVisibleRun(
    job: Job<Record<string, unknown>>,
    type: 'task' | 'workflow',
  ): Promise<Run | WorkflowRun> {
    const jobState = await job.getState();
    if (isCancelledFailedJob(job, jobState)) {
      return (
        (await getPersistedCancelledSnapshot(getRunId(job))) ??
        createCancelledSnapshot(job, type, job.finishedOn ? new Date(job.finishedOn) : new Date())
      );
    }

    const run = toRun(job, type);
    run.status = mapBullMQStatus(jobState);
    return run;
  }

  async function findRunRecord(runId: string): Promise<RunRecord | null> {
    let job = await findJobByRunId(state.defaultTaskQueue, runId);
    if (job) {
      if (!state.taskQueueEvents) {
        throw new OrchestrationError(
          'ADAPTER_ERROR',
          'Task queue events are not started.',
        );
      }
      return {
        job,
        queue: state.defaultTaskQueue,
        queueEvents: state.taskQueueEvents,
        type: 'task',
        name: String(job.data['taskName'] ?? job.name),
      };
    }

    job = await findJobByRunId(state.workflowQueue, runId);
    if (job) {
      if (!state.workflowQueueEvents) {
        throw new OrchestrationError(
          'ADAPTER_ERROR',
          'Workflow queue events are not started.',
        );
      }
      return {
        job,
        queue: state.workflowQueue,
        queueEvents: state.workflowQueueEvents,
        type: 'workflow',
        name: String(job.data['workflowName'] ?? job.name),
      };
    }

    for (const [queueName, queue] of state.namedQueues.entries()) {
      job = await findJobByRunId(queue, runId);
      if (!job) continue;
      const queueEvents = state.namedQueueEvents.get(queueName);
      if (!queueEvents) {
        throw new OrchestrationError(
          'ADAPTER_ERROR',
          `Queue events for task queue '${queueName}' are not started.`,
        );
      }
      return {
        job,
        queue,
        queueEvents,
        type: 'task',
        name: String(job.data['taskName'] ?? job.name),
      };
    }

    return null;
  }

  const RUN_ID_SCAN_LIMIT = 500;

  async function findJobByRunId(
    queue: Queue,
    runId: string,
  ): Promise<Job<Record<string, unknown>> | null> {
    const direct = await Job.fromId(queue, runId);
    if (direct) return direct;

    const jobs = await queue.getJobs(lookupStates, 0, RUN_ID_SCAN_LIMIT - 1);
    const match =
      jobs.find(j => {
        const jobRunId =
          typeof j.data['runId'] === 'string' ? (j.data['runId'] as string) : undefined;
        return jobRunId === runId;
      }) ?? null;
    if (!match) {
      state.metrics.runIdScanMisses += 1;
      state.structuredLogger.warn('Run ID scan miss', {
        runId,
        scannedCount: jobs.length,
        maxScan: RUN_ID_SCAN_LIMIT,
      });
    }
    return match;
  }

  async function cancelBullMQJob(
    job: Job<Record<string, unknown>>,
    type: 'task' | 'workflow',
    queue: Queue,
  ): Promise<CancelOutcome> {
    const runId = getRunId(job);
    const jobState = await job.getState();
    if (jobState === 'completed' || jobState === 'failed') {
      return { cancelStatus: 'confirmed' };
    }

    if (
      jobState === 'waiting' ||
      jobState === 'delayed' ||
      jobState === 'prioritized' ||
      jobState === 'waiting-children'
    ) {
      const snapshot = createCancelledSnapshot(job, type);
      await persistCancelledSnapshot(snapshot);
      try {
        await job.remove();
      } catch (error) {
        await deletePersistedCancelledSnapshot(runId);
        throw error;
      }
      state.cancelledRunSignals.set(runId, snapshot.error?.message ?? CANCELLATION_ERROR_MESSAGE);

      try {
        const existing = await withTimeout(
          Job.fromId(queue, String(job.id ?? runId)),
          1_000,
          'job.fromId after remove',
        );
        if (existing) {
          return {
            cancelStatus: 'best-effort',
            message: 'job.remove() returned but the job is still visible in Redis',
          };
        }
        return { cancelStatus: 'confirmed' };
      } catch (verifyErr) {
        return {
          cancelStatus: 'best-effort',
          message:
            verifyErr instanceof Error
              ? `verification failed: ${verifyErr.message}`
              : 'verification failed',
        };
      }
    }

    if (jobState === 'active') {
      try {
        type MoveToFailed = {
          moveToFailed(err: Error, token: string, fetchNext?: boolean): Promise<void>;
        };
        await (job as unknown as MoveToFailed).moveToFailed(
          new Error(CANCELLATION_ERROR_MESSAGE),
          '0',
          false,
        );
      } catch (error) {
        throw new OrchestrationError(
          'ADAPTER_ERROR',
          `Failed to cancel active run '${runId}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      state.cancelledRunSignals.set(runId, CANCELLATION_ERROR_MESSAGE);
      return { cancelStatus: 'confirmed' };
    }
    return {
      cancelStatus: 'best-effort',
      message: `Run '${runId}' is in BullMQ state '${jobState}' and cannot be cancelled directly.`,
    };
  }

  async function waitForRunResult(
    runId: string,
    job: Job<Record<string, unknown>>,
    queueEvents: QueueEvents,
  ): Promise<unknown> {
    const cancellationMessage = state.cancelledRunSignals.get(runId);
    if (cancellationMessage) {
      throw new Error(cancellationMessage);
    }

    const cancellationWatcher = createCancellationWatcher(state.cancelledRunSignals, runId);
    try {
      return await Promise.race([job.waitUntilFinished(queueEvents), cancellationWatcher.promise]);
    } finally {
      cancellationWatcher.stop();
    }
  }

  return {
    getPersistedCancelledSnapshot,
    listPersistedCancelledSnapshots,
    persistCancelledSnapshot,
    deletePersistedCancelledSnapshot,
    toVisibleRun,
    findRunRecord,
    findJobByRunId,
    cancelBullMQJob,
    waitForRunResult,
    getCancelledRunKey,
  };
}
