import { type ConnectionOptions, Job, type JobType, Queue, QueueEvents, Worker } from 'bullmq';
import {
  type AnyResolvedTask,
  type AnyResolvedWorkflow,
  type ObservabilityCapability,
  type OrchestrationAdapter,
  OrchestrationError,
  type OrchestrationEventSink,
  type Run,
  type RunFilter,
  type RunHandle,
  type ScheduleCapability,
  type ScheduleHandle,
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

const CANCELLATION_ERROR_MESSAGE = 'Run cancelled';

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

function deserializeRunSnapshot(value: string): Run | WorkflowRun | null {
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
    console.error('[slingshot-orchestration-bullmq] Failed to deserialize run snapshot:', err);
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
 * Create the BullMQ-backed orchestration adapter.
 *
 * Use this adapter when the app already runs Redis and wants durable queues, repeatable
 * schedules, and worker-based task execution without changing task or workflow code.
 */
export function createBullMQOrchestrationAdapter(
  rawOptions: BullMQOrchestrationAdapterOptions & {
    eventSink?: OrchestrationEventSink;
    workflowConcurrency?: number;
  },
): OrchestrationAdapter & ObservabilityCapability & ScheduleCapability {
  const { eventSink, workflowConcurrency, ...parsedInput } = rawOptions;
  const options = bullmqOrchestrationAdapterOptionsSchema.parse(parsedInput);
  const taskRegistry = new Map<string, AnyResolvedTask>();
  const workflowRegistry = new Map<string, AnyResolvedWorkflow>();
  const prefix = options.prefix ?? 'orch';
  const connection = options.connection as ConnectionOptions;
  const defaultTaskQueue = new Queue(`${prefix}:tasks`, { connection });
  const workflowQueue = new Queue(`${prefix}:workflows`, { connection });
  const namedQueues = new Map<string, Queue>();
  const namedWorkers = new Map<string, Worker>();
  const namedQueueEvents = new Map<string, QueueEvents>();
  // Capped FIFO cache: maps runId → BullMQ jobId to avoid full-queue scans.
  // Unbounded growth would cause OOM in long-running processes; 10k entries covers
  // the typical lookback window and is evicted FIFO (Map iteration order = insertion order).
  const RUN_ID_CACHE_LIMIT = 10_000;
  const runIdToJobId = new Map<string, string>();
  function cacheRunId(runId: string, jobId: string): void {
    if (runIdToJobId.size >= RUN_ID_CACHE_LIMIT) {
      const oldest = runIdToJobId.keys().next().value;
      if (oldest !== undefined) runIdToJobId.delete(oldest);
    }
    runIdToJobId.set(runId, jobId);
  }
  const cancelledRunSignals = new Map<string, string>();
  const cancelledRunsIndexKey = `${prefix}:cancelled:runs`;
  let taskQueueEvents: QueueEvents | null = null;
  let workflowQueueEvents: QueueEvents | null = null;
  let taskWorker: Worker | null = null;
  let workflowWorker: Worker | null = null;
  let started = false;
  let startPromise: Promise<void> | null = null;
  let closed = false;

  function resolveTask(taskName: string): AnyResolvedTask {
    const task = taskRegistry.get(taskName);
    if (!task) {
      throw new OrchestrationError('TASK_NOT_FOUND', `Task '${taskName}' not registered`);
    }
    return task;
  }

  async function ensureStarted(): Promise<void> {
    if (started) return;
    if (closed) {
      throw new OrchestrationError('ADAPTER_ERROR', 'Adapter has been shut down.');
    }
    if (!startPromise) {
      startPromise = (async () => {
        if (!taskQueueEvents) {
          taskQueueEvents = new QueueEvents(`${prefix}:tasks`, { connection });
        }
        if (!workflowQueueEvents) {
          workflowQueueEvents = new QueueEvents(`${prefix}:workflows`, { connection });
        }
        if (!taskWorker) {
          taskWorker = new Worker(
            `${prefix}:tasks`,
            createBullMQTaskProcessor({
              taskRegistry,
              eventSink,
            }),
            {
              connection,
              concurrency: options.concurrency ?? 10,
              settings: { backoffStrategy: bullmqBackoffStrategy },
            },
          );
        }
        if (!workflowWorker) {
          workflowWorker = new Worker(
            `${prefix}:workflows`,
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
            { connection, concurrency: workflowConcurrency ?? 5 },
          );
        }
        for (const task of taskRegistry.values()) {
          if (!task.queue || namedWorkers.has(task.queue)) continue;
          const queueName = `${prefix}:${task.queue}:tasks`;
          const worker = new Worker(
            queueName,
            createBullMQTaskProcessor({
              taskRegistry,
              eventSink,
            }),
            {
              connection,
              settings: { backoffStrategy: bullmqBackoffStrategy },
            },
          );
          const queueEvents = new QueueEvents(queueName, { connection });
          namedWorkers.set(task.queue, worker);
          namedQueueEvents.set(task.queue, queueEvents);
          if (!namedQueues.has(task.queue)) {
            namedQueues.set(task.queue, new Queue(queueName, { connection }));
          }
        }
        started = true;
      })().catch(error => {
        startPromise = null;
        throw error;
      });
    }
    await startPromise;
  }

  function getQueueForTaskName(taskName: string): Queue {
    const task = resolveTask(taskName);
    if (!task.queue) return defaultTaskQueue;
    const existing = namedQueues.get(task.queue);
    if (existing) return existing;
    const queue = new Queue(`${prefix}:${task.queue}:tasks`, { connection });
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

  async function getPersistedCancelledSnapshot(runId: string): Promise<(Run | WorkflowRun) | null> {
    const client = await getCancellationSnapshotStore();
    const payload = await client.get(getCancelledRunKey(runId));
    if (!payload) {
      return null;
    }
    const snapshot = deserializeRunSnapshot(payload);
    if (snapshot) {
      return snapshot;
    }
    await client.del(getCancelledRunKey(runId));
    await client.zrem(cancelledRunsIndexKey, runId);
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
    const staleRunIds: string[] = [];
    for (const [index, payload] of payloads.entries()) {
      const runId = runIds[index];
      if (!runId || !payload) {
        if (runId) {
          staleRunIds.push(runId);
        }
        continue;
      }
      const snapshot = deserializeRunSnapshot(payload);
      if (!snapshot) {
        staleRunIds.push(runId);
        continue;
      }
      snapshots.push(snapshot);
    }

    if (staleRunIds.length > 0) {
      await client.zrem(cancelledRunsIndexKey, ...staleRunIds);
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
  ): Promise<void> {
    const runId = getRunId(job);
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') {
      return;
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
      return;
    }

    if (state === 'active') {
      try {
        await (
          job as unknown as {
            moveToFailed(err: Error, token: string, fetchNext?: boolean): Promise<void>;
          }
        ).moveToFailed(new Error(CANCELLATION_ERROR_MESSAGE), '0', false);
      } catch (error) {
        throw new OrchestrationError(
          'ADAPTER_ERROR',
          `Failed to cancel active run '${runId}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      cancelledRunSignals.set(runId, CANCELLATION_ERROR_MESSAGE);
    }
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
    const jobs = await queue.getJobs(lookupStates, 0, 499);
    return (
      jobs.find(job => {
        const jobRunId =
          typeof job.data['runId'] === 'string' ? (job.data['runId'] as string) : undefined;
        return jobRunId === runId;
      }) ?? null
    );
  }

  return {
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
          return;
        }
        throw new OrchestrationError('RUN_NOT_FOUND', `Run '${runId}' not found`);
      }

      await cancelBullMQJob(record.job, record.type);

      const childIds = Array.isArray(record.job.data['_childJobIds'])
        ? (record.job.data['_childJobIds'] as string[])
        : [];
      for (const childId of childIds) {
        for (const queue of [defaultTaskQueue, ...namedQueues.values()]) {
          const childJob = await Job.fromId(queue, childId);
          if (!childJob) continue;
          await cancelBullMQJob(childJob, 'task');
        }
      }
    },
    async start() {
      await ensureStarted();
    },
    async shutdown() {
      closed = true;
      cancelledRunSignals.clear();
      runIdToJobId.clear();
      for (const worker of namedWorkers.values()) {
        await worker.close();
      }
      for (const queueEvents of namedQueueEvents.values()) {
        await queueEvents.close();
      }
      namedWorkers.clear();
      namedQueueEvents.clear();
      if (taskWorker) await taskWorker.close();
      if (workflowWorker) await workflowWorker.close();
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
      started = false;
      startPromise = null;
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
      throw new OrchestrationError('RUN_NOT_FOUND', `Schedule '${scheduleId}' not found.`);
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
              type: queue.name.endsWith(':workflows') ? 'workflow' : 'task',
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
