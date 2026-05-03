import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_MAX_ENTRIES,
  createConsoleLogger,
  evictOldestArray,
} from '@lastshotlabs/slingshot-core';
import type { HookServices, Logger } from '@lastshotlabs/slingshot-core';
import type { WebhookJob, WebhookQueue } from '../types/queue';
import { WebhookDeliveryError } from '../types/queue';

const logger: Logger = createConsoleLogger({
  base: { component: 'slingshot-webhooks:memory-queue' },
});

/**
 * Optional configuration for `createWebhookMemoryQueue`.
 *
 * @remarks
 * All fields are optional — the queue uses safe defaults when omitted.
 */
export interface MemoryQueueConfig {
  /**
   * Maximum number of delivery attempts before a job is dead-lettered.
   * Default: 5.
   */
  maxAttempts?: number;
  /**
   * Callback invoked when a job is moved to the dead-letter state.
   * Receives the final `WebhookJob` snapshot, the last `Error`, and the
   * framework `HookServices` accessor (when the queue is owned by a plugin
   * that has registered one; otherwise `undefined`).
   * May be async; callback failures are caught and logged.
   */
  onDeadLetter?: (job: WebhookJob, err: Error, services?: HookServices) => void | Promise<void>;
  /**
   * Late-bound accessor for framework {@link HookServices}. The plugin sets
   * this during `setupMiddleware`; the queue invokes it just before each
   * `onDeadLetter` call so the callback sees current framework state.
   */
  getHookServices?: () => HookServices | undefined;
  /**
   * When set, dead-lettered jobs are also persisted to a JSON-lines file at
   * this path. The file survives process restarts and can be re-processed
   * via {@link replayWebhookDlq}.
   *
   * The onDeadLetter callback, if set, is still invoked — the file store is
   * an additional durability layer.
   */
  dlqStoragePath?: string;
}

// ============================================================================
// Webhook file-backed DLQ helpers
// ============================================================================

/**
 * Re-process every dead-lettered webhook job stored in the given JSON-lines
 * file by passing each to the provided `enqueueFn` callback. Jobs that are
 * successfully enqueued are removed from the file; jobs whose callback
 * rejects are retained.
 *
 * @param storagePath - Path to the JSON-lines file written by {@link createWebhookMemoryQueue}
 *   when `dlqStoragePath` was configured.
 * @param enqueueFn - Async callback that receives each stored job and should
 *   re-enqueue it (e.g. call `webhookQueue.enqueue(job)`). Return a resolved
 *   promise to mark the job as successfully re-processed; reject to retain it.
 * @returns Summary of how many jobs were re-enqueued, how many failed, and the total.
 */
export async function replayWebhookDlq(
  storagePath: string,
  enqueueFn: (job: WebhookJob) => Promise<void>,
): Promise<{ processed: number; failed: number; total: number }> {
  if (!fs.existsSync(storagePath)) {
    return { processed: 0, failed: 0, total: 0 };
  }

  const entries: WebhookJob[] = [];
  const content = fs.readFileSync(storagePath, 'utf-8');
  if (content.trim()) {
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as WebhookJob;
        entries.push(parsed);
      } catch {
        // skip malformed lines
      }
    }
  }

  let processed = 0;
  let failed = 0;
  const results: boolean[] = [];

  for (const job of entries) {
    try {
      await enqueueFn(job);
      results.push(true);
      processed++;
    } catch {
      results.push(false);
      failed++;
    }
  }

  // Rewrite the file with only the entries that failed.
  const remaining = entries.filter((_, i) => !results[i]);
  if (remaining.length === 0) {
    try {
      fs.unlinkSync(storagePath);
    } catch {
      // best-effort
    }
  } else {
    const dir = path.dirname(storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = remaining.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(storagePath, lines, 'utf-8');
  }

  return { processed, failed, total: entries.length };
}

/**
 * Creates an in-process, non-durable webhook delivery queue for development and testing.
 *
 * Jobs are processed inline — no external dependencies required. All pending jobs are lost
 * on process restart. Use `createBullMQWebhookQueue` for durable, Redis-backed delivery.
 *
 * When `config.dlqStoragePath` is provided, dead-lettered jobs are also persisted to a
 * JSON-lines file. Use {@link replayWebhookDlq} to re-process them after restart.
 *
 * @param config - Optional queue configuration (maxAttempts, onDeadLetter, dlqStoragePath).
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
  const getHookServices = config?.getHookServices;
  const dlqStoragePath = config?.dlqStoragePath;
  const jobs: WebhookJob[] = [];
  const activeJobs = new Set<Promise<void>>();
  let processor: ((job: WebhookJob) => Promise<void>) | null = null;
  let running = false;
  let idCounter = 0;

  let pending = 0;

  logger.warn(
    `[slingshot] Memory webhook queue is capped at ${DEFAULT_MAX_ENTRIES} jobs, is not durable, and has no eviction guarantees beyond dropping oldest entries — for development/testing only`,
  );

  // -------------------------------------------------------------------------
  // File-backed DLQ persistence helpers
  // -------------------------------------------------------------------------

  function ensureDlqDir(): void {
    if (!dlqStoragePath) return;
    const dir = path.dirname(dlqStoragePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  function appendDlqJob(job: WebhookJob): void {
    if (!dlqStoragePath) return;
    try {
      ensureDlqDir();
      const line = JSON.stringify(job) + '\n';
      fs.appendFileSync(dlqStoragePath, line, 'utf-8');
    } catch (err) {
      logger.error('[slingshot-webhooks] Failed to persist dead-letter job', {
        error: err instanceof Error ? err.message : String(err),
        jobId: job.id,
      });
    }
  }

  function compactDlq(): void {
    if (!dlqStoragePath) return;
    try {
      if (!fs.existsSync(dlqStoragePath)) return;
      const content = fs.readFileSync(dlqStoragePath, 'utf-8');
      if (!content.trim()) return;
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length >= 1024) {
        // Deduplicate by job id, keeping the latest
        const seen = new Map<string, string>();
        for (const line of lines) {
          try {
            const job = JSON.parse(line) as { id: string };
            seen.set(job.id, line);
          } catch {
            // keep malformed lines as-is
            const key = `__malformed_${Math.random()}`;
            seen.set(key, line);
          }
        }
        const compacted = Array.from(seen.values()).join('\n') + '\n';
        fs.writeFileSync(dlqStoragePath, compacted, 'utf-8');
      }
    } catch {
      // best-effort
    }
  }

  // -------------------------------------------------------------------------
  // Dead-letter handler
  // -------------------------------------------------------------------------

  async function handleDeadLetter(job: WebhookJob, err: Error): Promise<void> {
    // Persist to file first
    appendDlqJob(job);
    compactDlq();

    // Then call the callback
    if (onDeadLetter) {
      try {
        await onDeadLetter(job, err, getHookServices?.());
      } catch (err) {
        logger.error('[slingshot-webhooks] onDeadLetter handler failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Job processing
  // -------------------------------------------------------------------------

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
          await handleDeadLetter(finalJob, lastErr);
          return;
        }
        job = { ...job, attempts: job.attempts + 1 };
      }
    }
    pending--;
    await handleDeadLetter(job, lastErr);
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
            handleDeadLetter(
              oldest,
              new Error('[slingshot-webhooks] Memory queue at capacity — job evicted'),
            ).catch(err => {
              logger.error('[slingshot-webhooks] onDeadLetter handler failed', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
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
