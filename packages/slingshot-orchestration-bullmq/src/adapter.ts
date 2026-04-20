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
  type RunOptions,
  type ScheduleCapability,
  type ScheduleHandle,
  type WorkflowRun,
  createCachedRunHandle,
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

function toRun(job: Job<Record<string, unknown>>, type: 'task' | 'workflow'): Run | WorkflowRun {
  const progress = job.progress && typeof job.progress === 'object' ? job.progress : undefined;
  const rawRunId = typeof job.data['runId'] === 'string' ? (job.data['runId'] as string) : '';
  const runId = rawRunId.length > 0 ? rawRunId : String(job.id);
  return {
    id: runId,
    type,
    name: String(job.data['taskName'] ?? job.data['workflowName'] ?? job.name),
    status: 'pending',
    input: job.data['input'],
    output: job.returnvalue,
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

function dedupeJobId(
  target: { type: 'task' | 'workflow'; name: string },
  tenantId: string | undefined,
  idempotencyKey: string,
): string {
  return ['orch-idem', target.type, target.name, tenantId ?? 'global', idempotencyKey].join(':');
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
  const runIdToJobId = new Map<string, string>();
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
      })();
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

  async function findJobByRunId(
    queue: Queue,
    runId: string,
  ): Promise<Job<Record<string, unknown>> | null> {
    const direct = await Job.fromId(queue, runId);
    if (direct) return direct;

    const jobs = await queue.getJobs(lookupStates);
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
      const jobId = opts?.idempotencyKey
        ? dedupeJobId({ type: 'task', name }, opts.tenantId, opts.idempotencyKey)
        : runId;
      let job = await Job.fromId(queue, jobId);
      if (job) {
        const existingJob = job;
        const existingRunId =
          typeof existingJob.data['runId'] === 'string'
            ? (existingJob.data['runId'] as string)
            : String(existingJob.id);
        runIdToJobId.set(existingRunId, String(existingJob.id));
        return createResultHandle(existingRunId, () =>
          existingJob.waitUntilFinished(getQueueEventsForTaskName(name)),
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
      runIdToJobId.set(runId, String(job.id));
      return createResultHandle(runId, () =>
        job.waitUntilFinished(getQueueEventsForTaskName(name)),
      );
    },
    async runWorkflow(name, input, opts) {
      await ensureStarted();
      const workflow = workflowRegistry.get(name);
      if (!workflow) {
        throw new OrchestrationError('WORKFLOW_NOT_FOUND', `Workflow '${name}' not registered`);
      }
      const runId = generateRunId();
      const jobId = opts?.idempotencyKey
        ? dedupeJobId({ type: 'workflow', name }, opts.tenantId, opts.idempotencyKey)
        : runId;
      let job = await Job.fromId(workflowQueue, jobId);
      if (job) {
        const existingJob = job;
        const existingRunId =
          typeof existingJob.data['runId'] === 'string'
            ? (existingJob.data['runId'] as string)
            : String(existingJob.id);
        runIdToJobId.set(existingRunId, String(existingJob.id));
        return createResultHandle(existingRunId, () => {
          if (!workflowQueueEvents) {
            throw new OrchestrationError('ADAPTER_ERROR', 'Workflow queue events are not started.');
          }
          return existingJob.waitUntilFinished(workflowQueueEvents);
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
      runIdToJobId.set(runId, String(job.id));
      return createResultHandle(runId, () => {
        if (!workflowQueueEvents) {
          throw new OrchestrationError('ADAPTER_ERROR', 'Workflow queue events are not started.');
        }
        return job.waitUntilFinished(workflowQueueEvents);
      });
    },
    async getRun(runId) {
      let job = await findJobByRunId(defaultTaskQueue, runId);
      let type: 'task' | 'workflow' = 'task';
      if (!job) {
        job = await findJobByRunId(workflowQueue, runId);
        type = 'workflow';
      }
      if (!job) {
        for (const queue of namedQueues.values()) {
          job = await findJobByRunId(queue, runId);
          if (job) {
            type = 'task';
            break;
          }
        }
      }
      if (!job) return null;
      const run = toRun(job, type);
      run.status = mapBullMQStatus(await job.getState());
      return run;
    },
    async cancelRun(runId) {
      let job = await findJobByRunId(defaultTaskQueue, runId);
      if (!job) {
        job = await findJobByRunId(workflowQueue, runId);
      }
      if (!job) {
        for (const queue of namedQueues.values()) {
          job = await findJobByRunId(queue, runId);
          if (job) break;
        }
      }
      if (!job) {
        throw new OrchestrationError('RUN_NOT_FOUND', `Run '${runId}' not found`);
      }

      const state = await job.getState();
      if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
        await job.remove();
      } else if (state === 'active') {
        await (
          job as unknown as {
            moveToFailed(err: Error, token: string, fetchNext?: boolean): Promise<void>;
          }
        ).moveToFailed(new Error('Run cancelled'), '0', false);
      }

      const childIds = Array.isArray(job.data['_childJobIds'])
        ? (job.data['_childJobIds'] as string[])
        : [];
      for (const childId of childIds) {
        for (const queue of [defaultTaskQueue, ...namedQueues.values()]) {
          const childJob = await Job.fromId(queue, childId);
          if (!childJob) continue;
          const childState = await childJob.getState();
          if (
            childState === 'waiting' ||
            childState === 'delayed' ||
            childState === 'prioritized'
          ) {
            await childJob.remove();
          } else if (childState === 'active') {
            await (
              childJob as unknown as {
                moveToFailed(err: Error, token: string, fetchNext?: boolean): Promise<void>;
              }
            ).moveToFailed(new Error('Run cancelled'), '0', false);
          }
        }
      }
    },
    async start() {
      await ensureStarted();
    },
    async shutdown() {
      closed = true;
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
        ].map(async ({ job, type }) => {
          const run = toRun(job, type);
          run.status = mapBullMQStatus(await job.getState());
          return run;
        }),
      );
      const filtered = merged
        .filter(run => {
          if (filter?.name && run.name !== filter.name) return false;
          if (filter?.tenantId && run.tenantId !== filter.tenantId) return false;
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
        const jobSchedulers = await queue.getJobSchedulers();
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
        const jobSchedulers = await queue.getJobSchedulers();
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
