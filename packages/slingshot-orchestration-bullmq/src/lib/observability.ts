// ---------------------------------------------------------------------------
// Observability: metrics, health checks, and associated types for the
// BullMQ orchestration adapter.
// ---------------------------------------------------------------------------

import type { Queue } from 'bullmq';
import type { Logger } from '@lastshotlabs/slingshot-core';
import type { QueueEvents } from 'bullmq';
import type { Run } from '@lastshotlabs/slingshot-orchestration';

// ---------------------------------------------------------------------------
// Metrics types
// ---------------------------------------------------------------------------

/**
 * Snapshot of operational metrics emitted by the BullMQ orchestration adapter.
 *
 * Counters are monotonically increasing for the lifetime of the adapter instance and
 * are reset only when {@link createBullMQOrchestrationAdapter} is called again.
 */
export interface BullMQOrchestrationAdapterMetrics {
  /** Number of FIFO evictions from the runId to jobId cache. */
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

/**
 * Adapter capability for resetting the lazy-start state machine after a failed
 * initialization so the next start() or lazy operation retries adapter startup.
 */
export interface BullMQOrchestrationResetCapability {
  reset(): void;
}

/**
 * Health-check capability for the BullMQ orchestration adapter.
 *
 * Returns the current health state of the adapter including Redis connectivity,
 * worker presence, disposal state, and start-state status.
 */
export interface BullMQOrchestrationHealthCapability {
  health(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    details: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// Observability state
// ---------------------------------------------------------------------------

export interface ObservabilityState {
  disposed: boolean;
  startState: string;
  taskWorker: unknown;
  workflowWorker: unknown;
  defaultTaskQueue: Queue;
  metrics: BullMQOrchestrationAdapterMetrics;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createObservabilityFns(state: ObservabilityState, structuredLogger: Logger) {
  void structuredLogger;
  function getMetrics(): BullMQOrchestrationAdapterMetrics {
    return { ...state.metrics };
  }

  async function health(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    details: Record<string, unknown>;
  }> {
    const details: Record<string, unknown> = {
      disposed: state.disposed,
      startState: state.startState,
      taskWorkerRunning: state.taskWorker !== null,
      workflowWorkerRunning: state.workflowWorker !== null,
    };

    if (state.disposed) {
      return { status: 'unhealthy', details };
    }

    try {
      const client = await state.defaultTaskQueue.client;
      await client.ping();
      details.redisPing = 'ok';
    } catch (err) {
      details.redisPing = 'error';
      details.redisError = err instanceof Error ? err.message : String(err);
      return { status: 'unhealthy', details };
    }

    if (state.startState !== 'started') {
      return { status: 'degraded', details };
    }

    if (!state.taskWorker || !state.workflowWorker) {
      return { status: 'degraded', details };
    }

    return { status: 'healthy', details };
  }

  return { getMetrics, health };
}

// ---------------------------------------------------------------------------
// Progress listener helper
// ---------------------------------------------------------------------------

export function createProgressListener(
  runId: string,
  callback: (progress: unknown) => void,
  runIdToJobId: Map<string, string>,
  ensureStarted: () => Promise<void>,
  getQueueEventsList: () => QueueEvents[],
): () => void {
  const matchedJobId = runIdToJobId.get(runId);
  const listener = ({ jobId, data }: { jobId: string; data: unknown }) => {
    if (jobId === runId || (matchedJobId !== undefined && jobId === matchedJobId)) {
      callback(data as Run['progress']);
    }
  };
  let attachedEvents: QueueEvents[] = [];
  let disposed = false;
  const attachPromise = ensureStarted().then(() => {
    if (disposed) return;
    attachedEvents = getQueueEventsList();
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
}
