import {
  type ConnectionOptions,
  Job,
  type JobType,
  Queue,
  QueueEvents,
  type QueueOptions,
  Worker,
} from 'bullmq';
import type { Logger } from '@lastshotlabs/slingshot-core';
import { noopLogger, withTimeout } from '@lastshotlabs/slingshot-core';
import {
  type AnyResolvedTask,
  type AnyResolvedWorkflow,
  type CancelOutcome,
  type ObservabilityCapability,
  type OrchestrationAdapter,
  OrchestrationError,
  type OrchestrationEventSink,
  type Run,
  type RunFilter,
  type RunHandle,
  type ScheduleCapability,
  type ScheduleHandle,
  type SlingshotLogger,
  type StepRun,
  type WorkflowRun,
  createCachedRunHandle,
  createIdempotencyScope,
  generateRunId,
} from '@lastshotlabs/slingshot-orchestration';
import { mapBullMQStatus } from './statusMap';
import {
  bullmqBackoffStrategy,
  createJobRetryOptions,
  resolveTaskRuntimeConfig,
} from './taskRuntime';
import { createBullMQTaskProcessor } from './taskWorker';
import {
  type BullMQOrchestrationAdapterOptions,
  bullmqOrchestrationAdapterOptionsSchema,
} from './validation';
import { createBullMQWorkflowProcessor } from './workflowWorker';

const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_REMOVE_ON_COMPLETE_AGE_SECONDS = 3_600;
const DEFAULT_REMOVE_ON_COMPLETE_COUNT = 1_000;
const DEFAULT_REMOVE_ON_FAIL_AGE_SECONDS = 86_400;
const DRAIN_POLL_INTERVAL_MS = 100;

/**
 * Allowlist of OS- and Redis-level errors we treat as transient (retryable).
 * Anything else is permanent and should fail-fast — retrying a logic bug or a
 * configuration error wastes worker capacity and obscures the real failure.
 */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const TRANSIENT_REDIS_NAMES = new Set(['ConnectionError', 'ReplyError', 'TimeoutError']);

/**
 * Outcome of error classification used to decide retry vs. fail-fast.
 * `permanent: true` means the error must surface to the caller without retry.
 */
export interface ErrorClassification {
  retryable: boolean;
  permanent: boolean;
  code?: string;
}

/**
 * Classify an error as transient (retryable) or permanent (fail-fast) based on
 * known OS-level and Redis-level error codes. Used by the BullMQ adapter to decide
 * whether a failed job should be retried or surfaced immediately.
 */
export function classifyOrchestrationError(err: unknown): ErrorClassification {
  if (err === null || err === undefined) {
    return { retryable: false, permanent: true };
  }
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) {
      return { retryable: true, permanent: false, code };
    }
    if (TRANSIENT_REDIS_NAMES.has(err.name)) {
      return { retryable: true, permanent: false, code };
    }
    // ioredis-style 'ReadyError' / cluster reconfiguration errors
    if (/READONLY|MOVED|LOADING|MASTERDOWN|CLUSTERDOWN|TRYAGAIN/.test(err.message)) {
      return { retryable: true, permanent: false, code };
    }
    return { retryable: false, permanent: true, code };
  }
  return { retryable: false, permanent: true };
}

const CANCELLATION_ERROR_MESSAGE = 'Run cancelled';
const ADAPTER_DISPOSED_MESSAGE =
  'Adapter has been shut down; construct a new adapter instance to start again.';

/**
 * Thrown when an operation is attempted on a BullMQ orchestration adapter that has
 * already been shut down. Re-using a disposed adapter is a programming error — the
 * underlying queues, workers, and Redis connections have been released and cannot be
 * resurrected. Callers should construct a fresh adapter via
 * {@link createBullMQOrchestrationAdapter}.
 *
 * Extends {@link OrchestrationError} with `code = 'ADAPTER_ERROR'` so existing error
 * branches that key on `code` continue to work; the subclass exists to allow callers
 * to distinguish disposal from other adapter errors via `instanceof`.
 */
export class OrchestrationAdapterDisposedError extends OrchestrationError {
  constructor(message: string = ADAPTER_DISPOSED_MESSAGE) {
    super('ADAPTER_ERROR', message);
    this.name = 'OrchestrationAdapterDisposedError';
  }
}

type SerializedStepRun = Omit<StepRun, 'startedAt' | 'completedAt'> & {
  startedAt?: string;
  completedAt?: string;
};

type SerializedRunSnapshot = Omit<Run, 'createdAt' | 'startedAt' | 'completedAt'> & {
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  steps?: Record<string, SerializedStepRun>;
};

interface CancellationSnapshotStoreClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  zadd(key: string, score: number | string, member: string): Promise<unknown>;
  zrange(key: string, start: number, end: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

function serializeStepRun(step: StepRun): SerializedStepRun {
  return {
    ...step,
    startedAt: step.startedAt?.toISOString(),
    completedAt: step.completedAt?.toISOString(),
  };
}

function serializeRunSnapshot(run: Run | WorkflowRun): SerializedRunSnapshot {
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

function deserializeRunSnapshot(
  value: string,
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
    if (reportError) {
      reportError(err);
    } else {
      console.error('[slingshot-orchestration-bullmq] Failed to deserialize run snapshot:', err);
    }
    return null;
  }
}

function getRunId(job: Job<Record<string, unknown>>): string {
  const rawRunId = typeof job.data['runId'] === 'string' ? (job.data['runId'] as string) : '';
  return rawRunId.length > 0 ? rawRunId : String(job.id);
}

function isCancelledFailedJob(
  job: Job<Record<string, unknown>>,
  state: JobType | 'unknown',
): boolean {
  return state === 'failed' && job.failedReason === CANCELLATION_ERROR_MESSAGE;
}

function toRun(job: Job<Record<string, unknown>>, type: 'task' | 'workflow'): Run | WorkflowRun {
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

function matchesTags(
  runTags: Record<string, string> | undefined,
  filterTags: Record<string, string>,
): boolean {
  if (!runTags) return false;
  return Object.entries(filterTags).every(([key, value]) => runTags[key] === value);
}

const lookupStates: JobType[] = [
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'completed',
  'failed',
  'waiting-children',
];

interface RunRecord {
  job: Job<Record<string, unknown>>;
  queue: Queue;
  queueEvents: QueueEvents;
  type: 'task' | 'workflow';
  name: string;
}

function mapStatuses(filterStatus: RunFilter['status']): JobType[] {
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

/**
 * Snapshot of operational metrics emitted by the BullMQ orchestration adapter.
 *
 * Counters are monotonically increasing for the lifetime of the adapter instance and
 * are reset only when {@link createBullMQOrchestrationAdapter} is called again.
 */
export interface BullMQOrchestrationAdapterMetrics {
  /** Number of FIFO evictions from the runId → jobId cache. */
  runIdCacheEvictions: number;
  /** Number of full-scan fallbacks that completed without finding the requested runId. */
  runIdScanMisses: number;
}

/**
 * Adapter capability that exposes operational counters for the BullMQ orchestration
 * adapter. Returned alongside the standard orchestration capabilities so callers can
 * read counters without crossing module boundaries.
 */
export interface BullMQOrchestrationMetricsCapability {
  /** Return a snapshot of the current adapter metrics. */
  getMetrics(): BullMQOrchestrationAdapterMetrics;
}

export interface BullMQOrchestrationResetCapability {
  /**
   * Reset the lazy-start state machine after a failed initialization so the
   * next `start()` or lazy operation retries adapter startup.
   */
  reset(): void;
}

/**
 * Create the BullMQ-backed orchestration adapter.
 *
 * Use this adapter when the app already runs Redis and wants durable queues, repeatable
 * schedules, and worker-based task execution without changing task or workflow code.
 */
export function createBullMQOrchestrationAdapter(
  rawOptions: BullMQOrchestrationAdapterOptions & {
    eventSink?: OrchestrationEventSink;
    workflowConcurrency?: number;
    logger?: SlingshotLogger;
    /**
     * Structured Logger used for prod-track diagnostics (snapshot malformation,
     * cancellation outcomes, retry classification). Falls back to `noopLogger`
     * when omitted so unit tests stay quiet by default.
     */
    structuredLogger?: Logger;
  },
): OrchestrationAdapter &
  ObservabilityCapability &
  ScheduleCapability &
  BullMQOrchestrationMetricsCapability &
  BullMQOrchestrationResetCapability {
  const {
    eventSink,
    workflowConcurrency,
    logger,
    structuredLogger: rawStructuredLogger,
    ...parsedInput
  } = rawOptions;
  const options = bullmqOrchestrationAdapterOptionsSchema.parse(parsedInput);
  const structuredLogger: Logger = rawStructuredLogger ?? noopLogger;
  const taskRegistry = new Map<string, AnyResolvedTask>();
  const workflowRegistry = new Map<string, AnyResolvedWorkflow>();
  // BullMQ 5.x throws synchronously from the Queue constructor when the
  // queue name contains ':'. We use the prefix as the *segment* separator
  // for cancellation snapshots and Redis sorted-set keys (where ':' is the
  // idiomatic delimiter) but build the queue *names* themselves with '_'.
  // Without this any value of `options.prefix` would crash construction.
  const prefix = options.prefix ?? 'orch';
  const sanitizedPrefix = prefix.replace(/:/g, '_');
  const taskQueueName = `${sanitizedPrefix}_tasks`;
  const workflowQueueName = `${sanitizedPrefix}_workflows`;
  const namedTaskQueueName = (queueLabel: string): string =>
    `${sanitizedPrefix}_${queueLabel.replace(/:/g, '_')}_tasks`;

  // requireTls: when true, connecting without TLS is treated as a configuration
  // error rather than a silent fallback to plaintext. Throws synchronously at
  // construction so misconfigured deployments fail fast at startup.
  if (options.requireTls) {
    const connectionTls = (options.connection as { tls?: unknown }).tls;
    if (
      !connectionTls ||
      (typeof connectionTls === 'object' && Object.keys(connectionTls).length === 0)
    ) {
      throw new OrchestrationError(
        'INVALID_CONFIG',
        'requireTls=true but no TLS options were provided in connection.tls. ' +
          'Refusing to connect to Redis in plaintext.',
      );
    }
  }

  const connection = options.connection as ConnectionOptions;
  const shutdownDrainTimeoutMs =
    options.shutdownDrainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;

  // Default job retention: without these, Redis memory grows unbounded as
  // completed/failed jobs accumulate. Defaults: 1h/1000 completed, 24h failed.
  const removeOnCompleteAge =
    options.jobRetention?.removeOnCompleteAge ?? DEFAULT_REMOVE_ON_COMPLETE_AGE_SECONDS;
  const removeOnCompleteCount =
    options.jobRetention?.removeOnCompleteCount ?? DEFAULT_REMOVE_ON_COMPLETE_COUNT;
  const removeOnFailAge =
    options.jobRetention?.removeOnFailAge ?? DEFAULT_REMOVE_ON_FAIL_AGE_SECONDS;
  const removeOnFailCount = options.jobRetention?.removeOnFailCount;

  const defaultJobOptions: QueueOptions['defaultJobOptions'] = {
    removeOnComplete: { age: removeOnCompleteAge, count: removeOnCompleteCount },
    removeOnFail:
      typeof removeOnFailCount === 'number'
        ? { age: removeOnFailAge, count: removeOnFailCount }
        : { age: removeOnFailAge },
  };

  const queueOptions: QueueOptions = { connection, defaultJobOptions };

  const defaultTaskQueue = new Queue(taskQueueName, queueOptions);
  const workflowQueue = new Queue(workflowQueueName, queueOptions);
  const namedQueues = new Map<string, Queue>();
  const namedWorkers = new Map<string, Worker>();
  const namedQueueEvents = new Map<string, QueueEvents>();
  // Capped FIFO cache: maps runId → BullMQ jobId to avoid full-queue scans.
  // Unbounded growth would cause OOM in long-running processes; 10k entries covers
  // the typical lookback window and is evicted FIFO (Map iteration order = insertion order).
  const RUN_ID_CACHE_LIMIT = 10_000;
  const RUN_ID_SCAN_LIMIT = 500;
  const runIdToJobId = new Map<string, string>();
  // Adapter-level operational counters surfaced via getMetrics(). Mutated in place so
  // callers receive a fresh snapshot on each read.
  const metrics: BullMQOrchestrationAdapterMetrics = {
    runIdCacheEvictions: 0,
    runIdScanMisses: 0,
  };
  function cacheRunId(runId: string, jobId: string): void {
    if (runIdToJobId.size >= RUN_ID_CACHE_LIMIT) {
      const oldest = runIdToJobId.keys().next().value;
      if (oldest !== undefined) {
        runIdToJobId.delete(oldest);
        metrics.runIdCacheEvictions += 1;
        const payload = {
          event: 'orchestration.bullmq.runIdCacheEvicted',
          evictedRunId: oldest,
          cacheSize: runIdToJobId.size,
        };
        if (logger) {
          logger.warn(payload);
        } else {
          console.warn('[slingshot-orchestration-bullmq] runId cache eviction', payload);
        }
      }
    }
    runIdToJobId.set(runId, jobId);
  }
  const cancelledRunSignals = new Map<string, string>();
  const cancelledRunsIndexKey = `${prefix}:cancelled:runs`;
  let taskQueueEvents: QueueEvents | null = null;
  let workflowQueueEvents: QueueEvents | null = null;
  let taskWorker: Worker | null = null;
  let workflowWorker: Worker | null = null;
  /**
   * Lazy-start state machine.
   *
   * Transitions:
   * - idle -> starting (first ensureStarted() call)
   * - starting -> started (init succeeds)
   * - starting -> failed (init throws; concurrent waiters and subsequent
   *   ensureStarted() calls all observe the same retained error until reset())
   * - failed -> starting (only via reset())
   *
   * The retained error is critical: without it, a second concurrent caller
   * arriving after `startPromise` rejects would see `state === 'idle'` (or
   * mistakenly enter starting again against half-initialized resources).
   * Holding `failed + startError` until explicit reset() prevents that race.
   */
  type StartState = 'idle' | 'starting' | 'started' | 'failed';
  let startState: StartState = 'idle';
  let startPromise: Promise<void> | null = null;
  let startError: Error | null = null;
  // disposed is set by shutdown() and is permanent for the lifetime of the
  // instance. A disposed adapter cannot be re-started (the underlying queues
  // and workers have been closed); callers must construct a fresh adapter.
  let disposed = false;

  function resolveTask(taskName: string): AnyResolvedTask {
    const task = taskRegistry.get(taskName);
    if (!task) {
      throw new OrchestrationError('TASK_NOT_FOUND', `Task '${taskName}' not registered`);
    }
    return task;
  }

  async function ensureStarted(): Promise<void> {
    // Disposed-then-start is a programming error. Surface it instead of
    // silently re-initializing on a half-torn-down instance.
    if (disposed) {
      throw new OrchestrationAdapterDisposedError();
    }
    // Fast path: already initialized.
    if (startState === 'started') return;
    // Failed path: keep returning the retained error until reset() is called.
    // This prevents a second concurrent caller from spawning a parallel init
    // against a half-cleaned state.
    if (startState === 'failed') {
      throw (
        startError ??
        new OrchestrationError(
          'ADAPTER_ERROR',
          'BullMQ orchestration adapter is in failed state. Call reset() to retry initialization.',
        )
      );
    }
    // Concurrent-call guard: re-use the in-flight init promise so two callers
    // racing through this function do not both proceed past the started check
    // and double-construct workers/queues.
    if (startState === 'starting' && startPromise) return startPromise;
    startState = 'starting';
    startPromise = (async () => {
      if (!taskQueueEvents) {
        taskQueueEvents = new QueueEvents(taskQueueName, { connection });
      }
      if (!workflowQueueEvents) {
        workflowQueueEvents = new QueueEvents(workflowQueueName, { connection });
      }
      if (!taskWorker) {
        taskWorker = new Worker(
          taskQueueName,
          createBullMQTaskProcessor({
            taskRegistry,
            eventSink,
          }),
          {
            connection,
            concurrency: options.concurrency ?? 10,
            settings: { backoffStrategy: bullmqBackoffStrategy },
            maxStalledCount: 1,
            stalledInterval: 30_000,
          },
        );
        taskWorker.on('stalled', (jobId: string) => {
          console.error(`[slingshot-orchestration-bullmq] Job stalled in task queue: ${jobId}`);
        });
      }
      if (!workflowWorker) {
        workflowWorker = new Worker(
          workflowQueueName,
          createBullMQWorkflowProcessor({
            workflowRegistry,
            taskRegistry,
            getTaskQueue(taskName) {
              if (taskName === '__slingshot_sleep') return defaultTaskQueue;
              return getQueueForTaskName(taskName);
            },
            getTaskQueueEvents(taskName) {
              if (taskName === '__slingshot_sleep') {
                if (!taskQueueEvents) {
                  throw new OrchestrationError(
                    'ADAPTER_ERROR',
                    'Task queue events are not started.',
                  );
                }
                return taskQueueEvents;
              }
              return getQueueEventsForTaskName(taskName);
            },
            eventSink,
          }),
          {
            connection,
            concurrency: workflowConcurrency ?? 5,
            maxStalledCount: 1,
            stalledInterval: 30_000,
          },
        );
        workflowWorker.on('stalled', (jobId: string) => {
          console.error(`[slingshot-orchestration-bullmq] Job stalled in workflow queue: ${jobId}`);
        });
      }
      for (const task of taskRegistry.values()) {
        if (!task.queue || namedWorkers.has(task.queue)) continue;
        const queueName = namedTaskQueueName(task.queue);
        const worker = new Worker(
          queueName,
          createBullMQTaskProcessor({
            taskRegistry,
            eventSink,
          }),
          {
            connection,
            settings: { backoffStrategy: bullmqBackoffStrategy },
            maxStalledCount: 1,
            stalledInterval: 30_000,
          },
        );
        worker.on('stalled', (jobId: string) => {
          console.error(
            `[slingshot-orchestration-bullmq] Job stalled in named queue '${task.queue}': ${jobId}`,
          );
        });
        const queueEvents = new QueueEvents(queueName, { connection });
        namedWorkers.set(task.queue, worker);
        namedQueueEvents.set(task.queue, queueEvents);
        if (!namedQueues.has(task.queue)) {
          namedQueues.set(task.queue, new Queue(queueName, queueOptions));
        }
      }
    })().then(
      () => {
        startState = 'started';
        startError = null;
        startPromise = null;
      },
      err => {
        // Retain the error and the failed state. Subsequent ensureStarted()
        // calls return the same rejection until the caller invokes reset().
        startError = err instanceof Error ? err : new Error(String(err));
        startState = 'failed';
        startPromise = null;
        throw err;
      },
    );
    return startPromise;
  }

  /**
   * Reset the lazy-start state machine after a failed initialization. Only
   * legal when `startState === 'failed'`. After reset() the next
   * `ensureStarted()` will attempt initialization from scratch.
   */
  function resetStartState(): void {
    if (startState !== 'failed') {
      throw new OrchestrationError(
        'INVALID_CONFIG',
        `reset() is only valid when start state is 'failed' (current: ${startState}).`,
      );
    }
    startState = 'idle';
    startError = null;
    startPromise = null;
  }

  function getQueueForTaskName(taskName: string): Queue {
    const task = resolveTask(taskName);
    if (!task.queue) return defaultTaskQueue;
    const existing = namedQueues.get(task.queue);
    if (existing) return existing;
    const queue = new Queue(namedTaskQueueName(task.queue), queueOptions);
    namedQueues.set(task.queue, queue);
    return queue;
  }

  function getQueueEventsForTaskName(taskName: string): QueueEvents {
    const task = resolveTask(taskName);
    if (!task.queue) {
      if (!taskQueueEvents) {
        throw new OrchestrationError('ADAPTER_ERROR', 'Task queue events are not started.');
      }
      return taskQueueEvents;
    }
    const queueEvents = namedQueueEvents.get(task.queue);
    if (!queueEvents) {
      throw new OrchestrationError(
        'ADAPTER_ERROR',
        `Queue events for task queue '${task.queue}' are not started.`,
      );
    }
    return queueEvents;
  }

  function createResultHandle(id: string, jobPromiseLoader: () => Promise<unknown>): RunHandle {
    return createCachedRunHandle(id, jobPromiseLoader);
  }

  function getCancelledRunKey(runId: string): string {
    return `${prefix}:cancelled:run:${runId}`;
  }

  async function getCancellationSnapshotStore(): Promise<CancellationSnapshotStoreClient> {
    return (await defaultTaskQueue.client) as CancellationSnapshotStoreClient;
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
      structuredLogger.error('orchestration.bullmq.snapshotQuarantineFailed', {
        runId,
        error:
          err instanceof Error
            ? { message: err.message, stack: err.stack }
            : { message: String(err) },
      });
    }
    structuredLogger.error('orchestration.bullmq.snapshotMalformed', {
      runId,
      malformedKey,
      error:
        parseError instanceof Error
          ? { message: parseError.message, stack: parseError.stack }
          : { message: String(parseError) },
    });
    if (eventSink) {
      try {
        const result = eventSink.emit('orchestration.bullmq.snapshotMalformed', {
          runId,
          malformedKey,
          error:
            parseError instanceof Error
              ? { message: parseError.message }
              : { message: String(parseError) },
        });
        if (result) {
          result.catch(emitErr => {
            structuredLogger.error('orchestration.bullmq.snapshotMalformed.emitError', {
              error:
                emitErr instanceof Error
                  ? { message: emitErr.message, stack: emitErr.stack }
                  : { message: String(emitErr) },
            });
          });
        }
      } catch (emitErr) {
        structuredLogger.error('orchestration.bullmq.snapshotMalformed.emitError', {
          error:
            emitErr instanceof Error
              ? { message: emitErr.message, stack: emitErr.stack }
              : { message: String(emitErr) },
        });
      }
    }
  }

  async function getPersistedCancelledSnapshot(runId: string): Promise<(Run | WorkflowRun) | null> {
    const client = await getCancellationSnapshotStore();
    const payload = await client.get(getCancelledRunKey(runId));
    if (!payload) {
      return null;
    }
    let parseError: unknown = null;
    const snapshot = deserializeRunSnapshot(payload, err => {
      parseError = err;
    });
    if (snapshot) {
      return snapshot;
    }
    // Do NOT delete the snapshot. Move it aside under :malformed for forensics
    // and surface a structured event so operators can act before data is lost.
    await quarantineMalformedSnapshot(client, runId, payload, parseError);
    return null;
  }

  async function listPersistedCancelledSnapshots(): Promise<Array<Run | WorkflowRun>> {
    const client = await getCancellationSnapshotStore();
    const runIds = await client.zrange(cancelledRunsIndexKey, 0, -1);
    if (runIds.length === 0) {
      return [];
    }

    const payloads = await client.mget(...runIds.map(runId => getCancelledRunKey(runId)));
    const snapshots: Array<Run | WorkflowRun> = [];
    // Truly stale ids — index entries with no payload at all. These are safe
    // to drop because there is nothing to forensically recover.
    const staleRunIds: string[] = [];
    for (const [index, payload] of payloads.entries()) {
      const runId = runIds[index];
      if (!runId) continue;
      if (!payload) {
        staleRunIds.push(runId);
        continue;
      }
      let parseError: unknown = null;
      const snapshot = deserializeRunSnapshot(payload, err => {
        parseError = err;
      });
      if (!snapshot) {
        // Do NOT delete a malformed payload. Quarantine it so an operator can
        // recover the run state if needed; remove it from the live index so
        // it stops surfacing as a cancelled run on every list call.
        await quarantineMalformedSnapshot(client, runId, payload, parseError);
        staleRunIds.push(runId);
        continue;
      }
      snapshots.push(snapshot);
    }

    if (staleRunIds.length > 0) {
      await client.zrem(cancelledRunsIndexKey, ...staleRunIds);
      // Remove only the live keys for entries we already moved to :malformed
      // (or that had no payload). The :malformed copy survives.
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
    await client.zadd(cancelledRunsIndexKey, snapshot.createdAt.getTime(), snapshot.id);
  }

  async function deletePersistedCancelledSnapshot(runId: string): Promise<void> {
    const client = await getCancellationSnapshotStore();
    await client.del(getCancelledRunKey(runId));
    await client.zrem(cancelledRunsIndexKey, runId);
  }

  function createCancelledSnapshot(
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

  async function toVisibleRun(
    job: Job<Record<string, unknown>>,
    type: 'task' | 'workflow',
  ): Promise<Run | WorkflowRun> {
    const state = await job.getState();
    if (isCancelledFailedJob(job, state)) {
      return (
        (await getPersistedCancelledSnapshot(getRunId(job))) ??
        createCancelledSnapshot(job, type, job.finishedOn ? new Date(job.finishedOn) : new Date())
      );
    }

    const run = toRun(job, type);
    run.status = mapBullMQStatus(state);
    return run;
  }

  async function findRunRecord(runId: string): Promise<RunRecord | null> {
    let job = await findJobByRunId(defaultTaskQueue, runId);
    if (job) {
      if (!taskQueueEvents) {
        throw new OrchestrationError('ADAPTER_ERROR', 'Task queue events are not started.');
      }
      return {
        job,
        queue: defaultTaskQueue,
        queueEvents: taskQueueEvents,
        type: 'task',
        name: String(job.data['taskName'] ?? job.name),
      };
    }

    job = await findJobByRunId(workflowQueue, runId);
    if (job) {
      if (!workflowQueueEvents) {
        throw new OrchestrationError('ADAPTER_ERROR', 'Workflow queue events are not started.');
      }
      return {
        job,
        queue: workflowQueue,
        queueEvents: workflowQueueEvents,
        type: 'workflow',
        name: String(job.data['workflowName'] ?? job.name),
      };
    }

    for (const [queueName, queue] of namedQueues.entries()) {
      job = await findJobByRunId(queue, runId);
      if (!job) continue;
      const queueEvents = namedQueueEvents.get(queueName);
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

  function createCancellationWatcher(runId: string): { promise: Promise<never>; stop(): void } {
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
        if (stopped) {
          return;
        }
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

  async function waitForRunResult(
    runId: string,
    job: Job<Record<string, unknown>>,
    queueEvents: QueueEvents,
  ): Promise<unknown> {
    const cancellationMessage = cancelledRunSignals.get(runId);
    if (cancellationMessage) {
      throw new Error(cancellationMessage);
    }

    const cancellationWatcher = createCancellationWatcher(runId);
    try {
      return await Promise.race([job.waitUntilFinished(queueEvents), cancellationWatcher.promise]);
    } finally {
      cancellationWatcher.stop();
    }
  }

  async function cancelBullMQJob(
    job: Job<Record<string, unknown>>,
    type: 'task' | 'workflow',
    queue: Queue,
  ): Promise<CancelOutcome> {
    const runId = getRunId(job);
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') {
      return { cancelStatus: 'confirmed' };
    }

    if (
      state === 'waiting' ||
      state === 'delayed' ||
      state === 'prioritized' ||
      state === 'waiting-children'
    ) {
      const snapshot = createCancelledSnapshot(job, type);
      await persistCancelledSnapshot(snapshot);
      try {
        await job.remove();
      } catch (error) {
        await deletePersistedCancelledSnapshot(runId);
        throw error;
      }
      cancelledRunSignals.set(runId, snapshot.error?.message ?? CANCELLATION_ERROR_MESSAGE);

      // Verify the remove() actually deleted the job. BullMQ's remove() can
      // succeed without throwing while the underlying Redis op was a no-op
      // (e.g. lock contention). Poll Job.fromId once with a short timeout —
      // if the job is still present we return best-effort so the caller can
      // surface the ambiguity instead of falsely claiming success.
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
        // Verification timeout/error — be conservative.
        return {
          cancelStatus: 'best-effort',
          message:
            verifyErr instanceof Error
              ? `verification failed: ${verifyErr.message}`
              : 'verification failed',
        };
      }
    }

    if (state === 'active') {
      try {
        // BullMQ's public Job.moveToFailed signature varies between minor
        // releases (some take a token, some take an opts object). We assert
        // the shape we rely on at this peer-API boundary so the call site
        // stays version-tolerant; the runtime always returns a Promise<void>.
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
      cancelledRunSignals.set(runId, CANCELLATION_ERROR_MESSAGE);
      return { cancelStatus: 'confirmed' };
    }
    return {
      cancelStatus: 'best-effort',
      message: `Run '${runId}' is in BullMQ state '${state}' and cannot be cancelled directly.`,
    };
  }

  async function findJobByRunId(
    queue: Queue,
    runId: string,
  ): Promise<Job<Record<string, unknown>> | null> {
    const direct = await Job.fromId(queue, runId);
    if (direct) return direct;

    // Full-scan fallback: cap at 500 most-recent jobs to avoid OOM on large queues.
    // The runIdToJobId cache handles the common case; this path is only hit for
    // jobs started before the cache was populated (e.g. after a process restart).
    const jobs = await queue.getJobs(lookupStates, 0, RUN_ID_SCAN_LIMIT - 1);
    const match =
      jobs.find(job => {
        const jobRunId =
          typeof job.data['runId'] === 'string' ? (job.data['runId'] as string) : undefined;
        return jobRunId === runId;
      }) ?? null;
    if (!match) {
      metrics.runIdScanMisses += 1;
      const payload = {
        event: 'orchestration.bullmq.runIdScanMiss',
        runId,
        scannedCount: jobs.length,
        maxScan: RUN_ID_SCAN_LIMIT,
      };
      if (logger) {
        logger.warn(payload);
      } else {
        console.warn('[slingshot-orchestration-bullmq] runId scan miss', payload);
      }
    }
    return match;
  }

  return {
    getMetrics(): BullMQOrchestrationAdapterMetrics {
      // Return a defensive copy so callers cannot mutate adapter state.
      return { ...metrics };
    },
    /**
     * Reset the lazy-start state machine after an initialization failure.
     * Throws if the adapter is not in `failed` state. Use this to retry
     * `start()`/`ensureStarted()` after fixing the underlying cause (e.g.
     * Redis becoming reachable again).
     */
    reset() {
      resetStartState();
    },
    registerTask(def) {
      taskRegistry.set(def.name, def);
    },
    registerWorkflow(def) {
      workflowRegistry.set(def.name, def);
    },
    async runTask(name, input, opts) {
      await ensureStarted();
      const task = resolveTask(name);
      const taskRuntime = resolveTaskRuntimeConfig(task);
      const runId = generateRunId();
      const queue = getQueueForTaskName(name);
      const jobId = createIdempotencyScope({ type: 'task', name }, opts ?? {}) ?? runId;
      let job = await Job.fromId(queue, jobId);
      if (job) {
        const existingJob = job;
        const existingRunId =
          typeof existingJob.data['runId'] === 'string'
            ? (existingJob.data['runId'] as string)
            : String(existingJob.id);
        cacheRunId(existingRunId, String(existingJob.id));
        return createResultHandle(existingRunId, () =>
          waitForRunResult(existingRunId, existingJob, getQueueEventsForTaskName(name)),
        );
      }
      job = await queue.add(
        name,
        {
          taskName: name,
          input,
          runId,
          idempotencyKey: opts?.idempotencyKey,
          tenantId: opts?.tenantId,
          tags: opts?.tags,
          metadata: opts?.metadata,
          adapterHints: opts?.adapterHints,
          taskRuntime,
        },
        {
          jobId,
          delay: opts?.delay,
          priority: opts?.priority,
          ...createJobRetryOptions(taskRuntime),
          ...(opts?.adapterHints ?? {}),
        },
      );
      cacheRunId(runId, String(job.id));
      return createResultHandle(runId, () =>
        waitForRunResult(runId, job, getQueueEventsForTaskName(name)),
      );
    },
    async runWorkflow(name, input, opts) {
      await ensureStarted();
      const workflow = workflowRegistry.get(name);
      if (!workflow) {
        throw new OrchestrationError('WORKFLOW_NOT_FOUND', `Workflow '${name}' not registered`);
      }
      const runId = generateRunId();
      const jobId = createIdempotencyScope({ type: 'workflow', name }, opts ?? {}) ?? runId;
      let job = await Job.fromId(workflowQueue, jobId);
      if (job) {
        const existingJob = job;
        const existingRunId =
          typeof existingJob.data['runId'] === 'string'
            ? (existingJob.data['runId'] as string)
            : String(existingJob.id);
        cacheRunId(existingRunId, String(existingJob.id));
        return createResultHandle(existingRunId, () => {
          if (!workflowQueueEvents) {
            throw new OrchestrationError('ADAPTER_ERROR', 'Workflow queue events are not started.');
          }
          return waitForRunResult(existingRunId, existingJob, workflowQueueEvents);
        });
      }
      job = await workflowQueue.add(
        name,
        {
          workflowName: name,
          input,
          runId,
          idempotencyKey: opts?.idempotencyKey,
          tenantId: opts?.tenantId,
          tags: opts?.tags,
          metadata: opts?.metadata,
          adapterHints: opts?.adapterHints,
        },
        {
          jobId,
          delay: opts?.delay,
          priority: opts?.priority,
          ...(opts?.adapterHints ?? {}),
        },
      );
      cacheRunId(runId, String(job.id));
      return createResultHandle(runId, () => {
        if (!workflowQueueEvents) {
          throw new OrchestrationError('ADAPTER_ERROR', 'Workflow queue events are not started.');
        }
        return waitForRunResult(runId, job, workflowQueueEvents);
      });
    },
    async getRun(runId) {
      const record = await findRunRecord(runId);
      if (record) {
        return toVisibleRun(record.job, record.type);
      }
      return getPersistedCancelledSnapshot(runId);
    },
    async cancelRun(runId) {
      const record = await findRunRecord(runId);
      if (!record) {
        const persistedSnapshot = await getPersistedCancelledSnapshot(runId);
        if (persistedSnapshot) {
          return { cancelStatus: 'confirmed' };
        }
        throw new OrchestrationError('RUN_NOT_FOUND', `Run '${runId}' not found`);
      }

      const outcome = await cancelBullMQJob(record.job, record.type, record.queue);

      const childIds = Array.isArray(record.job.data['_childJobIds'])
        ? (record.job.data['_childJobIds'] as string[])
        : [];
      let degraded = outcome.cancelStatus === 'best-effort';
      for (const childId of childIds) {
        for (const queue of [defaultTaskQueue, ...namedQueues.values()]) {
          const childJob = await Job.fromId(queue, childId);
          if (!childJob) continue;
          const childOutcome = await cancelBullMQJob(childJob, 'task', queue);
          if (childOutcome.cancelStatus === 'best-effort') {
            degraded = true;
          }
        }
      }
      return degraded
        ? {
            cancelStatus: 'best-effort',
            message: outcome.message ?? 'one or more child jobs could not be confirmed cancelled',
          }
        : { cancelStatus: 'confirmed' };
    },
    async start() {
      await ensureStarted();
    },
    async shutdown() {
      // Idempotent: a second shutdown() on a disposed adapter is a no-op.
      // Without this, a redundant call would attempt to close already-closed
      // workers and produce spurious errors during process teardown.
      if (disposed) {
        return;
      }
      // Wait for any in-flight start to finish BEFORE tearing down. Otherwise
      // a start racing with a shutdown can leave fresh workers/queues
      // connected to Redis after teardown completed — leaking connections
      // and (worse) picking up jobs after the adapter is supposed to be gone.
      // We swallow start errors here since the caller's intent is shutdown;
      // they will surface elsewhere if relevant.
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          // Start failed; nothing to drain for the failed init, fall through
          // to teardown of whatever partial state was created.
        }
      }
      // Mark disposed AFTER awaiting startPromise so an in-flight start does
      // not see disposed=true mid-init and throw — that would leave the
      // adapter in an inconsistent state with workers half-constructed.
      disposed = true;
      cancelledRunSignals.clear();
      runIdToJobId.clear();

      // Graceful drain: pause new job pickups, then wait for active jobs to drain
      // to zero (or until shutdownDrainTimeoutMs elapses). Without this, in-flight
      // work is interrupted mid-processing and BullMQ relies on stalled-job recovery
      // to retry — increasing latency, surfacing duplicate side effects, and risking
      // partial work commits.
      const drainWorker = async (worker: Worker, label: string): Promise<void> => {
        try {
          // pause(true) stops the worker from picking up new jobs immediately.
          await worker.pause(true);
        } catch (error) {
          console.error(
            `[slingshot-orchestration-bullmq] Failed to pause worker '${label}' during shutdown:`,
            error,
          );
        }

        const deadline = Date.now() + shutdownDrainTimeoutMs;
        let activeCount = 0;
        // Poll getActiveCount(); BullMQ does not expose a 'drained' Promise.
        // The poll interval is short relative to typical job durations, so the
        // overhead is negligible compared to the job work itself.
        // Some test harnesses do not implement getActiveCount — treat absence as zero.
        // The cast is a feature-detect; real BullMQ Workers always expose it.
        type WorkerWithActiveCount = { getActiveCount?: () => Promise<number> };
        const getActiveCount = (worker as unknown as WorkerWithActiveCount).getActiveCount;
        if (typeof getActiveCount === 'function') {
          while (Date.now() < deadline) {
            try {
              activeCount = await getActiveCount.call(worker);
            } catch (error) {
              console.error(
                `[slingshot-orchestration-bullmq] getActiveCount failed for worker '${label}':`,
                error,
              );
              break;
            }
            if (activeCount === 0) break;
            await new Promise<void>(resolve => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
          }
        }

        // After timeout (or when drained), force-close the worker. force=true tells
        // BullMQ to skip waiting for jobs and to release the connection promptly.
        const forceClose = activeCount > 0;
        if (forceClose) {
          console.warn(
            `[slingshot-orchestration-bullmq] Worker '${label}' force-closed with ${activeCount} ` +
              `active job(s) still in flight after ${shutdownDrainTimeoutMs}ms drain timeout.`,
            {
              worker: label,
              activeCount,
              shutdownDrainTimeoutMs,
              errorCode: 'WORKER_DRAIN_TIMEOUT',
            },
          );
        }
        try {
          await worker.close(forceClose);
        } catch (error) {
          console.error(
            `[slingshot-orchestration-bullmq] Failed to close worker '${label}':`,
            error,
          );
        }
      };

      const shutdownSequence = async () => {
        // Drain named workers first (named queues are typically domain-specific
        // and may be more sensitive to mid-job interruption), then the default ones.
        await Promise.all(
          [...namedWorkers.entries()].map(([queueName, worker]) =>
            drainWorker(worker, `named:${queueName}`),
          ),
        );
        for (const queueEvents of namedQueueEvents.values()) {
          await queueEvents.close();
        }
        namedWorkers.clear();
        namedQueueEvents.clear();
        if (taskWorker) await drainWorker(taskWorker, 'tasks');
        if (workflowWorker) await drainWorker(workflowWorker, 'workflows');
        if (taskQueueEvents) await taskQueueEvents.close();
        if (workflowQueueEvents) await workflowQueueEvents.close();
        taskWorker = null;
        workflowWorker = null;
        taskQueueEvents = null;
        workflowQueueEvents = null;
        for (const queue of namedQueues.values()) {
          await queue.close();
        }
        namedQueues.clear();
        await defaultTaskQueue.close();
        await workflowQueue.close();
        startPromise = null;
      };

      // Outer hard-deadline: drainWorker has its own per-worker timeout, but we
      // also bound the total shutdown so that hung Redis connections cannot block
      // process exit indefinitely.
      const totalTimeoutMs = shutdownDrainTimeoutMs * 2 + 5_000;
      const timeoutPromise = new Promise<void>(resolve => {
        setTimeout(() => {
          console.warn(
            `[slingshot-orchestration-bullmq] Shutdown exceeded ${totalTimeoutMs}ms; forcing exit.`,
          );
          resolve();
        }, totalTimeoutMs);
      });

      await Promise.race([shutdownSequence(), timeoutPromise]);
    },
    async listRuns(filter) {
      await ensureStarted();
      const states = mapStatuses(filter?.status);
      const taskQueues = [defaultTaskQueue, ...namedQueues.values()];
      const [workflowJobs, ...taskJobGroups] = await Promise.all([
        filter?.type === 'task' ? Promise.resolve([]) : workflowQueue.getJobs(states),
        ...(filter?.type === 'workflow' ? [] : taskQueues.map(queue => queue.getJobs(states))),
      ]);
      const merged = await Promise.all(
        [
          ...taskJobGroups.flat().map(job => ({ job, type: 'task' as const })),
          ...workflowJobs.map(job => ({ job, type: 'workflow' as const })),
        ].map(({ job, type }) => toVisibleRun(job, type)),
      );
      const visibleRuns = new Map<string, Run | WorkflowRun>();
      for (const run of merged) {
        visibleRuns.set(run.id, run);
      }
      if (
        !filter?.status ||
        (Array.isArray(filter.status) ? filter.status : [filter.status]).includes('cancelled')
      ) {
        for (const snapshot of await listPersistedCancelledSnapshots()) {
          const existing = visibleRuns.get(snapshot.id);
          if (!existing || existing.status === 'failed') {
            visibleRuns.set(snapshot.id, snapshot);
          }
        }
      }
      const filtered = [...visibleRuns.values()]
        .filter(run => {
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
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? 50;
      return {
        runs: filtered.slice(offset, offset + limit),
        total: filtered.length,
      };
    },
    onProgress(runId, callback) {
      const matchedJobId = runIdToJobId.get(runId);
      const listener = ({ jobId, data }: { jobId: string; data: unknown }) => {
        if (jobId === runId || (matchedJobId !== undefined && jobId === matchedJobId)) {
          callback(data as Run['progress']);
        }
      };
      let attachedEvents: QueueEvents[] = [];
      let disposed = false;
      const attachPromise = ensureStarted().then(() => {
        if (disposed) {
          return;
        }
        attachedEvents = [
          ...(taskQueueEvents ? [taskQueueEvents] : []),
          ...(workflowQueueEvents ? [workflowQueueEvents] : []),
          ...namedQueueEvents.values(),
        ];
        for (const queueEvents of attachedEvents) {
          queueEvents.on('progress', listener);
        }
      });
      void attachPromise;
      return () => {
        disposed = true;
        for (const queueEvents of attachedEvents) {
          queueEvents.off('progress', listener);
        }
        attachedEvents = [];
      };
    },
    async schedule(target, cron, input) {
      await ensureStarted();
      const queue = target.type === 'task' ? getQueueForTaskName(target.name) : workflowQueue;
      const scheduleId = `slingshot-schedule-${target.type}-${target.name}-${generateRunId()}`;
      await queue.add(
        target.name,
        {
          [target.type === 'task' ? 'taskName' : 'workflowName']: target.name,
          input,
          // runId is generated per execution by the processor when empty
          _scheduled: true,
        },
        {
          jobId: scheduleId,
          repeat: { pattern: cron },
        },
      );
      return { id: scheduleId, target, cron, input };
    },
    async unschedule(scheduleId) {
      await ensureStarted();
      for (const queue of [defaultTaskQueue, workflowQueue, ...namedQueues.values()]) {
        const jobSchedulers = await queue.getJobSchedulers(0, 999);
        for (const scheduler of jobSchedulers) {
          if (scheduler.key === scheduleId) {
            await queue.removeJobScheduler(scheduler.key);
            return;
          }
        }
      }
      // No-op when the schedule does not exist — idempotent by design.
    },
    async listSchedules() {
      await ensureStarted();
      const schedules: ScheduleHandle[] = [];
      for (const queue of [defaultTaskQueue, workflowQueue, ...namedQueues.values()]) {
        const jobSchedulers = await queue.getJobSchedulers(0, 999);
        for (const scheduler of jobSchedulers) {
          schedules.push({
            id: scheduler.key,
            target: {
              // Queue names use '_' separators (BullMQ 5.x rejects ':' in
              // queue names). Match the workflow queue by exact name so we
              // never confuse a named task queue ending in '_workflows' with
              // the dedicated workflow queue.
              type: queue.name === workflowQueueName ? 'workflow' : 'task',
              name: scheduler.name,
            },
            cron: scheduler.pattern ?? '',
          });
        }
      }
      return schedules;
    },
  };
}
