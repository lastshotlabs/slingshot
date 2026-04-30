import { DEFAULT_MAX_ENTRIES, evictOldestArray, createConsoleLogger } from '@lastshotlabs/slingshot-core';
import type { Logger } from '@lastshotlabs/slingshot-core';
import type { WebhookJob, WebhookQueue } from '../types/queue';
import { WebhookDeliveryError } from '../types/queue';

const logger: Logger = createConsoleLogger({ base: { component: 'slingshot-webhooks:memory-queue' } });

/**
 * Optional configuration for `createWebhookMemoryQueue`.
 *
 * @remarks
 * Both fields are optional — the queue uses safe defaults when omitted.
 */
interface MemoryQueueConfig {
  /**
   * Maximum number of delivery attempts before a job is dead-lettered.
   * Default: 5.
   */
  maxAttempts?: number;
  /**
   * Callback invoked when a job is moved to the dead-letter state.
   * Receives the final `WebhookJob` snapshot and the last `Error`.
   * May be async; callback failures are caught and logged.
   */
  onDeadLetter?: (job: WebhookJob, err: Error) => void | Promise<void>;
}

/**
 * Creates an in-process, non-durable webhook delivery queue for development and testing.
 *
 * Jobs are processed inline — no external dependencies required. All pending jobs are lost
 * on process restart. Use `createBullMQWebhookQueue` for durable, Redis-backed delivery.
 *
 * @param config - Optional queue configuration (maxAttempts, onDeadLetter).
 * @returns A `WebhookQueue` instance backed by an in-memory array.
 *
 * @example
 * ```ts
 * import { createWebhookMemoryQueue } from '@lastshotlabs/slingshot-webhooks';
 *
 * const queue = createWebhookMemoryQueue({ maxAttempts: 3 });
 * ```
 */
export function createWebhookMemoryQueue(config?: MemoryQueueConfig): WebhookQueue {
  const maxAttempts = config?.maxAttempts ?? 5;
  const onDeadLetter = config?.onDeadLetter ?? null;
  const jobs: WebhookJob[] = [];
  const activeJobs = new Set<Promise<void>>();
  let processor: ((job: WebhookJob) => Promise<void>) | null = null;
  let running = false;
  let idCounter = 0;

  let pending = 0;

  logger.warn(
    `[slingshot] Memory webhook queue is capped at ${DEFAULT_MAX_ENTRIES} jobs, is not durable, and has no eviction guarantees beyond dropping oldest entries — for development/testing only`,
  );

  /**
   * Attempts to deliver a single webhook job, retrying on transient failures.
   *
   * Calls `processor(job)` in a loop until the delivery succeeds, the job is
   * non-retryable, or `maxAttempts` is exhausted. On each failed attempt the
   * attempt counter is incremented and the loop continues. When all retries are
   * exhausted (or the error is non-retryable), `onDeadLetter` is invoked with
   * the final job snapshot and the last error.
   *
   * @param job - The webhook job to process. Treated as immutable — each retry
   *   produces a new snapshot with an incremented `attempts` count.
   * @returns A promise that resolves once the job is either delivered or
   *   dead-lettered. Never rejects — errors are handled internally.
   *
   * @throws Never. All errors are caught and routed to `onDeadLetter`.
   *
   * @remarks
   * Retry semantics:
   * - If `processor` throws a `WebhookDeliveryError` with `retryable: false`,
   *   the job is dead-lettered immediately on the first failure.
   * - If `processor` throws any other error (or `WebhookDeliveryError` with
   *   `retryable: true`), the job is retried up to `maxAttempts` times.
   * - `onDeadLetter` is only called when the job cannot be delivered.
   * - Each failed attempt is logged implicitly via `onDeadLetter` — no
   *   intermediate error logging occurs inside this function.
   * - `pending` is decremented exactly once per `processJob` call.
   */
  async function processJob(job: WebhookJob): Promise<void> {
    let lastErr: Error = new Error('Unknown error');
    while (job.attempts < maxAttempts) {
      try {
        const activeProcessor = processor;
        if (!activeProcessor) {
          pending--;
          return;
        }
        await activeProcessor(job);
        pending--;
        return; // success
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const retryable = err instanceof WebhookDeliveryError ? err.retryable : true;
        if (!retryable || job.attempts + 1 >= maxAttempts) {
          const finalJob = { ...job, attempts: job.attempts + 1 };
          pending--;
          if (onDeadLetter) {
            try {
              await onDeadLetter(finalJob, lastErr);
            } catch (err) {
              logger.error('[slingshot-webhooks] onDeadLetter handler failed', err);
            }
          }
          return;
        }
        job = { ...job, attempts: job.attempts + 1 };
      }
    }
    pending--;
    if (onDeadLetter) {
      try {
        await onDeadLetter(job, lastErr);
      } catch (err) {
        logger.error('[slingshot-webhooks] onDeadLetter handler failed', err);
      }
    }
  }

  function trackJob(job: WebhookJob): void {
    const p = processJob(job);
    activeJobs.add(p);
    void p.finally(() => activeJobs.delete(p));
  }

  return {
    name: 'memory',
    enqueue(jobInput: Omit<WebhookJob, 'id' | 'createdAt'>): Promise<string> {
      const id = String(++idCounter);
      const job: WebhookJob = {
        id,
        ...jobInput,
        createdAt: new Date(),
      };
      pending++;
      if (running && processor) {
        trackJob(job);
      } else {
        const overflow = jobs.length + 1 - DEFAULT_MAX_ENTRIES;
        if (overflow > 0) {
          for (let i = 0; i < overflow; i++) {
            const oldest = jobs.shift();
            if (!oldest) break;
            pending--;
            if (onDeadLetter) {
              try {
                void Promise.resolve(
                  onDeadLetter(
                    oldest,
                    new Error('[slingshot-webhooks] Memory queue at capacity — job evicted'),
                  ),
                ).catch(err => {
                  logger.error('[slingshot-webhooks] onDeadLetter handler failed', err);
                });
              } catch (err) {
                logger.error('[slingshot-webhooks] onDeadLetter handler failed', err);
              }
            }
          }
        } else {
          evictOldestArray(jobs, DEFAULT_MAX_ENTRIES);
        }
        jobs.push(job);
      }
      return Promise.resolve(id);
    },
    start(p: (job: WebhookJob) => Promise<void>): Promise<void> {
      processor = p;
      running = true;
      // Flush queued jobs exactly once; completed jobs must not replay on restart.
      const queuedJobs = jobs.splice(0, jobs.length);
      for (const job of queuedJobs) {
        trackJob(job);
      }
      return Promise.resolve();
    },
    stop(): Promise<void> {
      running = false;
      processor = null;
      return Promise.resolve();
    },
    depth(): Promise<number> {
      return Promise.resolve(pending);
    },
    async drain(): Promise<void> {
      await Promise.all([...activeJobs]);
    },
  };
}
