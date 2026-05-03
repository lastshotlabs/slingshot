// ---------------------------------------------------------------------------
// Lifecycle state machine for the BullMQ orchestration adapter.
// Manages lazy-start initialization, reset-after-failure, and graceful
// shutdown with worker drain.
// ---------------------------------------------------------------------------

import { Queue, QueueEvents, Worker } from 'bullmq';
import type { ConnectionOptions, QueueOptions } from 'bullmq';
import type { Logger } from '@lastshotlabs/slingshot-core';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  OrchestrationEventSink,
} from '@lastshotlabs/slingshot-orchestration';
import { OrchestrationError } from '@lastshotlabs/slingshot-orchestration';
import { errInfo } from './cancellation';
import { bullmqBackoffStrategy } from '../taskRuntime';
import { createBullMQTaskProcessor } from '../taskWorker';
import { createBullMQWorkflowProcessor } from '../workflowWorker';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ADAPTER_DISPOSED_MESSAGE =
  'Adapter has been shut down; construct a new adapter instance to start again.';
export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;
export const DRAIN_POLL_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown when an operation is attempted on a BullMQ orchestration adapter that has
 * already been shut down. Re-using a disposed adapter is a programming error -- the
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

// ---------------------------------------------------------------------------
// Start state type
// ---------------------------------------------------------------------------

export type StartState = 'idle' | 'starting' | 'started' | 'failed';

// ---------------------------------------------------------------------------
// State machine config (includes singleton queues created by the caller)
// ---------------------------------------------------------------------------

export interface StateMachineConfig {
  taskQueueName: string;
  workflowQueueName: string;
  namedTaskQueueName(queueLabel: string): string;
  connection: ConnectionOptions;
  queueOptions: QueueOptions;
  concurrency?: number;
  workflowConcurrency?: number;
  shutdownDrainTimeoutMs: number;
  defaultTaskQueue: Queue;
  workflowQueue: Queue;
}

// ---------------------------------------------------------------------------
// Shared mutable state
// ---------------------------------------------------------------------------

export interface StartStopState {
  disposed: boolean;
  startState: StartState;
  startPromise: Promise<void> | null;
  startError: Error | null;
  taskQueueEvents: QueueEvents | null;
  workflowQueueEvents: QueueEvents | null;
  taskWorker: Worker | null;
  workflowWorker: Worker | null;
  namedWorkers: Map<string, Worker>;
  namedQueueEvents: Map<string, QueueEvents>;
  namedQueues: Map<string, Queue>;
  cancelledRunSignals: Map<string, string>;
  runIdToJobId: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStateMachine(
  ss: StartStopState,
  config: StateMachineConfig,
  taskRegistry: Map<string, AnyResolvedTask>,
  workflowRegistry: Map<string, AnyResolvedWorkflow>,
  structuredLogger: Logger,
  eventSink: OrchestrationEventSink | undefined,
  hookServices?: import('@lastshotlabs/slingshot-core').HookServices,
) {
  const {
    taskQueueName,
    workflowQueueName,
    namedTaskQueueName,
    connection,
    queueOptions,
    concurrency,
    workflowConcurrency,
    shutdownDrainTimeoutMs,
    defaultTaskQueue,
    workflowQueue,
  } = config;

  // ---- resolveTask ----

  function resolveTask(taskName: string): AnyResolvedTask {
    const task = taskRegistry.get(taskName);
    if (!task) {
      throw new OrchestrationError('TASK_NOT_FOUND', `Task '${taskName}' not registered`);
    }
    return task;
  }

  // ---- getQueueForTaskName ----

  function getQueueForTaskName(taskName: string): Queue {
    const task = resolveTask(taskName);
    if (!task.queue) return defaultTaskQueue;
    const existing = ss.namedQueues.get(task.queue);
    if (existing) return existing;
    const queue = new Queue(namedTaskQueueName(task.queue), queueOptions);
    ss.namedQueues.set(task.queue, queue);
    return queue;
  }

  // ---- getQueueEventsForTaskName ----

  function getQueueEventsForTaskName(taskName: string): QueueEvents {
    const task = resolveTask(taskName);
    if (!task.queue) {
      if (!ss.taskQueueEvents) {
        throw new OrchestrationError('ADAPTER_ERROR', 'Task queue events are not started.');
      }
      return ss.taskQueueEvents;
    }
    const queueEvents = ss.namedQueueEvents.get(task.queue);
    if (!queueEvents) {
      throw new OrchestrationError(
        'ADAPTER_ERROR',
        `Queue events for task queue '${task.queue}' are not started.`,
      );
    }
    return queueEvents;
  }

  // ---- createWorkerForTask ----

  function createWorkerForTask(task: AnyResolvedTask): void {
    if (!task.queue || ss.namedWorkers.has(task.queue)) return;
    const queueName = namedTaskQueueName(task.queue);
    const worker = new Worker(
      queueName,
      createBullMQTaskProcessor({
        taskRegistry,
        eventSink,
        logger: structuredLogger,
        hookServices,
      }),
      {
        connection,
        settings: { backoffStrategy: bullmqBackoffStrategy },
        maxStalledCount: 1,
        stalledInterval: 30_000,
      },
    );
    worker.on('stalled', (jobId: string) => {
      structuredLogger.error('Job stalled in named queue', { jobId, queue: task.queue });
    });
    const queueEvents = new QueueEvents(queueName, { connection });
    ss.namedWorkers.set(task.queue, worker);
    ss.namedQueueEvents.set(task.queue, queueEvents);
    if (!ss.namedQueues.has(task.queue)) {
      ss.namedQueues.set(task.queue, new Queue(queueName, queueOptions));
    }
  }

  // ---- ensureStarted ----

  async function ensureStarted(): Promise<void> {
    if (ss.disposed) {
      throw new OrchestrationAdapterDisposedError();
    }
    if (ss.startState === 'started') return;
    if (ss.startState === 'failed') {
      throw (
        ss.startError ??
        new OrchestrationError(
          'ADAPTER_ERROR',
          'BullMQ orchestration adapter is in failed state. Call reset() to retry initialization.',
        )
      );
    }
    if (ss.startState === 'starting' && ss.startPromise) {
      return ss.startPromise;
    }

    ss.startState = 'starting';
    ss.startPromise = (async () => {
      if (!ss.taskQueueEvents) {
        ss.taskQueueEvents = new QueueEvents(taskQueueName, { connection });
      }
      if (!ss.workflowQueueEvents) {
        ss.workflowQueueEvents = new QueueEvents(workflowQueueName, { connection });
      }
      if (!ss.taskWorker) {
        ss.taskWorker = new Worker(
          taskQueueName,
          createBullMQTaskProcessor({
            taskRegistry,
            eventSink,
            logger: structuredLogger,
          }),
          {
            connection,
            concurrency: concurrency ?? 10,
            settings: { backoffStrategy: bullmqBackoffStrategy },
            maxStalledCount: 1,
            stalledInterval: 30_000,
          },
        );
        ss.taskWorker.on('stalled', (jobId: string) => {
          structuredLogger.error('Job stalled in task queue', { jobId, queue: taskQueueName });
        });
      }
      if (!ss.workflowWorker) {
        ss.workflowWorker = new Worker(
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
                if (!ss.taskQueueEvents) {
                  throw new OrchestrationError(
                    'ADAPTER_ERROR',
                    'Task queue events are not started.',
                  );
                }
                return ss.taskQueueEvents;
              }
              return getQueueEventsForTaskName(taskName);
            },
            eventSink,
            logger: structuredLogger,
            hookServices,
          }),
          {
            connection,
            concurrency: workflowConcurrency ?? 5,
            maxStalledCount: 1,
            stalledInterval: 30_000,
          },
        );
        ss.workflowWorker.on('stalled', (jobId: string) => {
          structuredLogger.error('Job stalled in workflow queue', {
            jobId,
            queue: workflowQueueName,
          });
        });
      }
      for (const task of taskRegistry.values()) {
        createWorkerForTask(task);
      }
    })().then(
      () => {
        ss.startState = 'started';
        ss.startError = null;
        ss.startPromise = null;
        structuredLogger.info('BullMQ orchestration adapter started', {
          taskQueue: taskQueueName,
          workflowQueue: workflowQueueName,
          namedWorkerCount: ss.namedWorkers.size,
        });
      },
      err => {
        ss.startError = err instanceof Error ? err : new Error(String(err));
        ss.startState = 'failed';
        ss.startPromise = null;
        throw err;
      },
    );
    return ss.startPromise;
  }

  // ---- reset ----

  function resetStartState(): void {
    if (ss.startState !== 'failed') {
      throw new OrchestrationError(
        'INVALID_CONFIG',
        `reset() is only valid when start state is 'failed' (current: ${ss.startState}).`,
      );
    }
    structuredLogger.warn('Resetting adapter start state after failure');
    ss.startState = 'idle';
    ss.startError = null;
    ss.startPromise = null;
  }

  // ---- shutdown ----

  async function shutdown(): Promise<void> {
    if (ss.disposed) return;
    structuredLogger.info('BullMQ orchestration adapter shutting down');

    if (ss.startPromise) {
      try {
        await ss.startPromise;
      } catch {
        // Start failed; partial teardown
      }
    }

    ss.disposed = true;
    ss.cancelledRunSignals.clear();
    ss.runIdToJobId.clear();

    const drainWorker = async (worker: Worker, label: string): Promise<void> => {
      try {
        await worker.pause(true);
      } catch (error) {
        structuredLogger.error('Failed to pause worker during shutdown', {
          worker: label,
          err: errInfo(error),
        });
      }

      const deadline = Date.now() + shutdownDrainTimeoutMs;
      let activeCount = 0;
      type WorkerWithActiveCount = { getActiveCount?: () => Promise<number> };
      const getActiveCount = (worker as unknown as WorkerWithActiveCount).getActiveCount;
      if (typeof getActiveCount === 'function') {
        while (Date.now() < deadline) {
          try {
            activeCount = await getActiveCount.call(worker);
          } catch (error) {
            structuredLogger.error('getActiveCount failed during shutdown drain', {
              worker: label,
              err: errInfo(error),
            });
            break;
          }
          if (activeCount === 0) break;
          await new Promise<void>(resolve => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
        }
      }

      const forceClose = activeCount > 0;
      if (forceClose) {
        structuredLogger.warn('Worker force-closed after drain timeout', {
          worker: label,
          activeCount,
          shutdownDrainTimeoutMs,
          errorCode: 'WORKER_DRAIN_TIMEOUT',
        });
      }
      try {
        await worker.close(forceClose);
      } catch (error) {
        structuredLogger.error('Failed to close worker during shutdown', {
          worker: label,
          err: errInfo(error),
        });
      }
    };

    const shutdownSequence = async () => {
      await Promise.all(
        [...ss.namedWorkers.entries()].map(([queueName, worker]) =>
          drainWorker(worker, `named:${queueName}`),
        ),
      );
      for (const queueEvents of ss.namedQueueEvents.values()) {
        await queueEvents.close();
      }
      ss.namedWorkers.clear();
      ss.namedQueueEvents.clear();
      if (ss.taskWorker) await drainWorker(ss.taskWorker, 'tasks');
      if (ss.workflowWorker) await drainWorker(ss.workflowWorker, 'workflows');
      if (ss.taskQueueEvents) await ss.taskQueueEvents.close();
      if (ss.workflowQueueEvents) await ss.workflowQueueEvents.close();
      ss.taskWorker = null;
      ss.workflowWorker = null;
      ss.taskQueueEvents = null;
      ss.workflowQueueEvents = null;
      for (const queue of ss.namedQueues.values()) {
        await queue.close();
      }
      ss.namedQueues.clear();
      await defaultTaskQueue.close();
      await workflowQueue.close();
      ss.startPromise = null;
    };

    const totalTimeoutMs = shutdownDrainTimeoutMs * 2 + 5_000;
    const timeoutPromise = new Promise<void>(resolve => {
      setTimeout(() => {
        structuredLogger.warn('Shutdown exceeded total timeout; forcing exit', {
          totalTimeoutMs,
        });
        resolve();
      }, totalTimeoutMs);
    });

    await Promise.race([shutdownSequence(), timeoutPromise]);
    structuredLogger.info('BullMQ orchestration adapter shutdown completed');
  }

  function ensureWorkerForTask(taskName: string): void {
    if (ss.startState !== 'started') return;
    if (ss.disposed) return;
    const task = resolveTask(taskName);
    createWorkerForTask(task);
  }

  return {
    ensureStarted,
    ensureWorkerForTask,
    resetStartState,
    shutdown,
    resolveTask,
    getQueueForTaskName,
    getQueueEventsForTaskName,
  };
}
