/**
 * BullMQ-backed Slingshot orchestration adapter.
 *
 * Composition root that wires together state machine, cancellation,
 * scheduling, and observability modules.
 */

import { Job, Queue } from 'bullmq';
import type { ConnectionOptions, QueueOptions, QueueEvents, Worker } from 'bullmq';
import type { Logger } from '@lastshotlabs/slingshot-core';
import { noopLogger } from '@lastshotlabs/slingshot-core';
import {
  type AnyResolvedTask,
  type AnyResolvedWorkflow,
  type OrchestrationAdapter,
  type ObservabilityCapability,
  type ScheduleCapability,
  type RunHandle,
  OrchestrationError,
  type OrchestrationEventSink,
  createCachedRunHandle,
  createIdempotencyScope,
  generateRunId,
} from '@lastshotlabs/slingshot-orchestration';
import {
  createStateMachine,
  type StartStopState,
  type StateMachineConfig,
  OrchestrationAdapterDisposedError,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
} from './lib/stateMachine';
import {
  createCancellationFns,
  type CancellationState,
  matchesTags,
  mapStatuses,
} from './lib/cancellation';
import { createSchedulingFns, type SchedulingState } from './lib/scheduling';
import {
  createObservabilityFns,
  type ObservabilityState,
  createProgressListener,
  type BullMQOrchestrationAdapterMetrics,
  type BullMQOrchestrationMetricsCapability,
  type BullMQOrchestrationResetCapability,
  type BullMQOrchestrationHealthCapability,
} from './lib/observability';
import {
  createJobRetryOptions,
  resolveTaskRuntimeConfig,
} from './taskRuntime';
import {
  type BullMQOrchestrationAdapterOptions,
  bullmqOrchestrationAdapterOptionsSchema,
} from './validation';

// Re-exports for the public API surface (preserved from original adapter.ts).
export { classifyOrchestrationError, type ErrorClassification } from './errorClassification';
export { OrchestrationAdapterDisposedError };
export type {
  BullMQOrchestrationAdapterMetrics,
  BullMQOrchestrationMetricsCapability,
  BullMQOrchestrationResetCapability,
  BullMQOrchestrationHealthCapability,
};

const DEFAULT_REMOVE_ON_COMPLETE_AGE_SECONDS = 3_600;
const DEFAULT_REMOVE_ON_COMPLETE_COUNT = 1_000;
const DEFAULT_REMOVE_ON_FAIL_AGE_SECONDS = 86_400;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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
    structuredLogger?: Logger;
  },
): OrchestrationAdapter &
  ObservabilityCapability &
  ScheduleCapability &
  BullMQOrchestrationMetricsCapability &
  BullMQOrchestrationResetCapability &
  BullMQOrchestrationHealthCapability {
  // -- Destructure and validate options --
  const {
    eventSink,
    workflowConcurrency,
    structuredLogger: rawStructuredLogger,
    ...parsedInput
  } = rawOptions;
  const options = bullmqOrchestrationAdapterOptionsSchema.parse(parsedInput);
  const structuredLogger: Logger = rawStructuredLogger ?? noopLogger;

  // -- Registries --
  const taskRegistry = new Map<string, AnyResolvedTask>();
  const workflowRegistry = new Map<string, AnyResolvedWorkflow>();

  // -- Queue naming (BullMQ 5.x rejects ':' in queue names) --
  const prefix = options.prefix ?? 'orch';
  const sanitizedPrefix = prefix.replace(/:/g, '_');
  const taskQueueName = `${sanitizedPrefix}_tasks`;
  const workflowQueueName = `${sanitizedPrefix}_workflows`;
  const namedTaskQueueName = (queueLabel: string): string =>
    `${sanitizedPrefix}_${queueLabel.replace(/:/g, '_')}_tasks`;

  // -- TLS guard --
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

  // -- Job retention defaults --
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

  // -- Singleton queues --
  const defaultTaskQueue = new Queue(taskQueueName, queueOptions);
  const workflowQueue = new Queue(workflowQueueName, queueOptions);
  const namedQueues = new Map<string, Queue>();
  const namedWorkers = new Map<string, Worker>();
  const namedQueueEvents = new Map<string, QueueEvents>();

  // -- Run ID cache (capped FIFO) --
  const RUN_ID_CACHE_LIMIT = 10_000;
  const runIdToJobId = new Map<string, string>();
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
        structuredLogger.warn('Run ID cache evicted', {
          evictedRunId: oldest,
          cacheSize: runIdToJobId.size,
        });
      }
    }
    runIdToJobId.set(runId, jobId);
  }

  // -- Cancellation tracking --
  const cancelledRunSignals = new Map<string, string>();
  const cancelledRunsIndexKey = `${prefix}:cancelled:runs`;

  // -- Shared state object (satisfies all module interfaces) --
  const sharedState: StartStopState &
    CancellationState &
    ObservabilityState &
    SchedulingState = {
    // StartStopState
    disposed: false,
    startState: 'idle',
    startPromise: null,
    startError: null,
    taskQueueEvents: null,
    workflowQueueEvents: null,
    taskWorker: null,
    workflowWorker: null,
    namedWorkers,
    namedQueueEvents,
    namedQueues,
    cancelledRunSignals,
    runIdToJobId,

    // CancellationState
    prefix,
    cancelledRunsIndexKey,
    defaultTaskQueue,
    workflowQueue,
    metrics,
    structuredLogger,
    eventSink,

    // SchedulingState
    workflowQueueName,
  };

  // -- Build modules --
  const stateMachineConfig: StateMachineConfig = {
    taskQueueName,
    workflowQueueName,
    namedTaskQueueName,
    connection,
    queueOptions,
    concurrency: options.concurrency,
    workflowConcurrency,
    shutdownDrainTimeoutMs,
    defaultTaskQueue,
    workflowQueue,
  };

  const sm = createStateMachine(
    sharedState,
    stateMachineConfig,
    taskRegistry,
    workflowRegistry,
    structuredLogger,
    eventSink,
  );
  const cancellation = createCancellationFns(sharedState);
  const observability = createObservabilityFns(sharedState, structuredLogger);
  const scheduling = createSchedulingFns(
    sharedState,
    sm.ensureStarted,
    sm.resolveTask,
    sm.getQueueForTaskName,
  );

  // -- Helper --
  function createResultHandle(id: string, jobPromiseLoader: () => Promise<unknown>): RunHandle {
    return createCachedRunHandle(id, jobPromiseLoader);
  }

  // -- Adapter API --
  return {
    getMetrics: observability.getMetrics,
    reset() {
      sm.resetStartState();
    },
    health: observability.health,

    registerTask(def: AnyResolvedTask): void {
      taskRegistry.set(def.name, def);
      sm.ensureWorkerForTask(def.name);
    },
    registerWorkflow(def: AnyResolvedWorkflow): void {
      workflowRegistry.set(def.name, def);
    },

    async runTask(name, input, opts) {
      await sm.ensureStarted();
      const task = sm.resolveTask(name);
      const taskRuntime = resolveTaskRuntimeConfig(task);
      const runId = generateRunId();
      const queue = sm.getQueueForTaskName(name);
      const jobId = createIdempotencyScope({ type: 'task', name }, opts ?? {}) ?? runId;
      let job = await Job.fromId(queue, jobId);
      if (job) {
        const existingRunId =
          typeof job.data['runId'] === 'string'
            ? (job.data['runId'] as string)
            : String(job.id);
        cacheRunId(existingRunId, String(job.id));
        return createResultHandle(existingRunId, () =>
          cancellation.waitForRunResult(existingRunId, job, sm.getQueueEventsForTaskName(name)),
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
        cancellation.waitForRunResult(runId, job, sm.getQueueEventsForTaskName(name)),
      );
    },

    async runWorkflow(name, input, opts) {
      await sm.ensureStarted();
      const workflow = workflowRegistry.get(name);
      if (!workflow) {
        throw new OrchestrationError('WORKFLOW_NOT_FOUND', `Workflow '${name}' not registered`);
      }
      const runId = generateRunId();
      const jobId = createIdempotencyScope({ type: 'workflow', name }, opts ?? {}) ?? runId;
      let job = await Job.fromId(workflowQueue, jobId);
      if (job) {
        const existingRunId =
          typeof job.data['runId'] === 'string'
            ? (job.data['runId'] as string)
            : String(job.id);
        cacheRunId(existingRunId, String(job.id));
        return createResultHandle(existingRunId, () => {
          if (!sharedState.workflowQueueEvents) {
            throw new OrchestrationError('ADAPTER_ERROR', 'Workflow queue events are not started.');
          }
          return cancellation.waitForRunResult(
            existingRunId,
            job,
            sharedState.workflowQueueEvents,
          );
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
        if (!sharedState.workflowQueueEvents) {
          throw new OrchestrationError('ADAPTER_ERROR', 'Workflow queue events are not started.');
        }
        return cancellation.waitForRunResult(runId, job, sharedState.workflowQueueEvents);
      });
    },

    async getRun(runId) {
      const record = await cancellation.findRunRecord(runId);
      if (record) {
        return cancellation.toVisibleRun(record.job, record.type);
      }
      return cancellation.getPersistedCancelledSnapshot(runId);
    },

    async cancelRun(runId) {
      const record = await cancellation.findRunRecord(runId);
      if (!record) {
        const persistedSnapshot = await cancellation.getPersistedCancelledSnapshot(runId);
        if (persistedSnapshot) {
          return { cancelStatus: 'confirmed' as const };
        }
        throw new OrchestrationError('RUN_NOT_FOUND', `Run '${runId}' not found`);
      }

      const outcome = await cancellation.cancelBullMQJob(record.job, record.type, record.queue);

      const childIds = Array.isArray(record.job.data['_childJobIds'])
        ? (record.job.data['_childJobIds'] as string[])
        : [];
      let degraded = outcome.cancelStatus === 'best-effort';
      for (const childId of childIds) {
        for (const queue of [defaultTaskQueue, ...namedQueues.values()]) {
          const childJob = await Job.fromId(queue, childId);
          if (!childJob) continue;
          const childOutcome = await cancellation.cancelBullMQJob(childJob, 'task', queue);
          if (childOutcome.cancelStatus === 'best-effort') {
            degraded = true;
          }
        }
      }
      return degraded
        ? {
            cancelStatus: 'best-effort' as const,
            message:
              outcome.message ?? 'one or more child jobs could not be confirmed cancelled',
          }
        : { cancelStatus: 'confirmed' as const };
    },

    async start() {
      await sm.ensureStarted();
    },

    async shutdown() {
      await sm.shutdown();
    },

    async listRuns(filter) {
      await sm.ensureStarted();
      const states = mapStatuses(filter?.status);
      const taskQueues = [defaultTaskQueue, ...namedQueues.values()];
      const [workflowJobs, ...taskJobGroups] = await Promise.all([
        filter?.type === 'task' ? Promise.resolve([]) : workflowQueue.getJobs(states),
        ...(filter?.type === 'workflow'
          ? []
          : taskQueues.map(queue => queue.getJobs(states))),
      ]);
      const merged = await Promise.all(
        [
          ...taskJobGroups.flat().map(job => ({ job, type: 'task' as const })),
          ...workflowJobs.map(job => ({ job, type: 'workflow' as const })),
        ].map(({ job, type }) => cancellation.toVisibleRun(job, type)),
      );
      const visibleRuns = new Map<string, unknown>();
      for (const run of merged) {
        visibleRuns.set(run.id, run);
      }
      if (
        !filter?.status ||
        (Array.isArray(filter.status) ? filter.status : [filter.status]).includes('cancelled')
      ) {
        for (const snapshot of await cancellation.listPersistedCancelledSnapshots()) {
          const existing = visibleRuns.get(snapshot.id);
          if (!existing || (existing as { status: string }).status === 'failed') {
            visibleRuns.set(snapshot.id, snapshot);
          }
        }
      }
      const filtered: Array<
        import('@lastshotlabs/slingshot-orchestration').Run | import('@lastshotlabs/slingshot-orchestration').WorkflowRun
      > = [...visibleRuns.values()]
        .filter(run => {
          const r = run as import('@lastshotlabs/slingshot-orchestration').Run;
          if (filter?.name && r.name !== filter.name) return false;
          if (filter?.tenantId && r.tenantId !== filter.tenantId) return false;
          if (filter?.status) {
            const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
            if (!statuses.includes(r.status)) return false;
          }
          if (filter?.tags && !matchesTags(r.tags, filter.tags)) return false;
          if (filter?.createdAfter && r.createdAt < filter.createdAfter) return false;
          if (filter?.createdBefore && r.createdAt > filter.createdBefore) return false;
          return true;
        })
        .sort(
          (a, b) =>
            (b as import('@lastshotlabs/slingshot-orchestration').Run).createdAt.getTime() -
            (a as import('@lastshotlabs/slingshot-orchestration').Run).createdAt.getTime(),
        );
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? 50;
      return {
        runs: filtered.slice(offset, offset + limit),
        total: filtered.length,
      };
    },

    onProgress(runId, callback) {
      return createProgressListener(
        runId,
        callback,
        runIdToJobId,
        sm.ensureStarted,
        () => {
          const events: QueueEvents[] = [];
          if (sharedState.taskQueueEvents) events.push(sharedState.taskQueueEvents);
          if (sharedState.workflowQueueEvents) events.push(sharedState.workflowQueueEvents);
          for (const qe of namedQueueEvents.values()) {
            events.push(qe);
          }
          return events;
        },
      );
    },

    schedule: scheduling.schedule,
    unschedule: scheduling.unschedule,
    listSchedules: scheduling.listSchedules,
  };
}
