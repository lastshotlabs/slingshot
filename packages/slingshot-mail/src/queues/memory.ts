import type { MetricsEmitter } from '@lastshotlabs/slingshot-core';
import { DEFAULT_MAX_ENTRIES, createNoopMetricsEmitter } from '@lastshotlabs/slingshot-core';
import { TemplateNotFoundError } from '@lastshotlabs/slingshot-core';
import { MailCircuitOpenError } from '../lib/circuitBreaker';
import type { MailMessage, MailProvider } from '../types/provider';
import { MailSendError } from '../types/provider';
import type { MailJob, MailQueue, MailQueueConfig } from '../types/queue';
import { sendWithTimeout } from './sendWithTimeout';

/**
 * Creates an in-process, non-durable mail queue for development and testing.
 *
 * Jobs are held in memory and processed inline - no external dependencies required.
 * This queue is **not** suitable for production: all pending jobs are lost on process
 * restart. Use `createBullMQMailQueue` for durable, Redis-backed delivery.
 *
 * @param config - Optional queue configuration (maxAttempts, onDeadLetter).
 * @returns A `MailQueue` instance backed by an in-memory map.
 *
 * @remarks
 * Prints a startup warning to `console.warn` to make the non-durable nature visible.
 * The warning is intentional and should not be suppressed.
 *
 * @example
 * ```ts
 * import { createMemoryQueue } from '@lastshotlabs/slingshot-mail';
 *
 * const queue = createMemoryQueue({ maxAttempts: 2 });
 * ```
 */
export function createMemoryQueue(config?: MailQueueConfig): MailQueue {
  console.warn('[slingshot-mail] Memory queue is not durable — for development/testing only');
  const maxAttempts = config?.maxAttempts ?? 3;
  const onDeadLetter = config?.onDeadLetter ?? null;
  const drainTimeoutMs = config?.drainTimeoutMs ?? 30_000;
  const sendTimeoutMs = config?.sendTimeoutMs ?? 30_000;
  const maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // Optional unified metrics emitter. The plugin passes its lazily-resolved
  // proxy in here so the queue does not need to be rebuilt once the framework
  // context is available.
  const metrics: MetricsEmitter = config?.metrics ?? createNoopMetricsEmitter();
  const pending: Map<string, MailJob> = new Map();
  const activeJobs = new Set<Promise<void>>();
  // Maps idempotency key -> original job id so repeated enqueues dedup.
  const idempotencyIndex: Map<string, string> = new Map();
  let provider: MailProvider | null = null;
  let running = false;
  let idCounter = 0;

  const resolveSync = <T>(operation: () => T): Promise<T> => Promise.resolve().then(operation);

  async function processJob(job: MailJob): Promise<void> {
    while (job.attempts < maxAttempts) {
      job.attempts++;
      try {
        const activeProvider = provider;
        if (!activeProvider) {
          throw new Error('Memory mail queue not started â€” call start() first');
        }
        const providerLabel = { provider: activeProvider.name };
        const sendStart = performance.now();
        const result = await sendWithTimeout(activeProvider, job.message, sendTimeoutMs);
        const elapsed = performance.now() - sendStart;
        // Closed breaker on success — the provider's internal breaker
        // resets too. Sample the gauge so dashboards show recovery
        // promptly. 0=closed, 1=open, 2=half-open.
        metrics.gauge('mail.circuitBreaker.state', 0, providerLabel);
        metrics.timing('mail.send.duration', elapsed, providerLabel);
        if (result.status === 'rejected') {
          metrics.counter('mail.send.count', 1, { ...providerLabel, result: 'failure' });
          onDeadLetter?.(job, new MailSendError('Provider rejected message', false));
          pending.delete(job.id);
          metrics.gauge('mail.queue.depth', pending.size);
          return;
        }
        metrics.counter('mail.send.count', 1, { ...providerLabel, result: 'success' });
        pending.delete(job.id);
        metrics.gauge('mail.queue.depth', pending.size);
        return;
      } catch (err) {
        const providerLabel = provider ? { provider: provider.name } : { provider: 'unknown' };
        if (err instanceof MailCircuitOpenError) {
          // Breaker is currently open — emit a state gauge sample (1 = open)
          // so operators can see open-state dwell time without scraping logs.
          metrics.gauge('mail.circuitBreaker.state', 1, providerLabel);
          metrics.counter('mail.send.count', 1, { ...providerLabel, result: 'circuitOpen' });
        } else {
          metrics.counter('mail.send.count', 1, { ...providerLabel, result: 'failure' });
          if (err instanceof MailSendError && err.retryAfterMs !== undefined) {
            // Surface the provider's Retry-After hint so operators can see
            // back-pressure from rate limits even when retries are silent.
            metrics.gauge('mail.retryAfter', err.retryAfterMs, providerLabel);
          }
        }
        const isRetryable = err instanceof MailSendError ? err.retryable : true;
        const isPermanent = err instanceof TemplateNotFoundError || !isRetryable;
        if (isPermanent || job.attempts >= maxAttempts) {
          onDeadLetter?.(job, err instanceof Error ? err : new Error(String(err)));
          pending.delete(job.id);
          metrics.gauge('mail.queue.depth', pending.size);
          return;
        }
      }
    }
  }

  function trackJob(job: MailJob): void {
    const p = processJob(job);
    activeJobs.add(p);
    void p.finally(() => activeJobs.delete(p));
  }

  return {
    name: 'memory',
    enqueue(
      message: MailMessage,
      opts?: { sourceEvent?: string; idempotencyKey?: string },
    ): Promise<string> {
      return resolveSync(() => {
        if (opts?.idempotencyKey) {
          const existingId = idempotencyIndex.get(opts.idempotencyKey);
          if (existingId !== undefined) {
            // Second enqueue with the same key is a no-op — return the original job id.
            return existingId;
          }
        }
        const id = String(++idCounter);
        const job: MailJob = {
          id,
          message,
          sourceEvent: opts?.sourceEvent,
          attempts: 0,
          createdAt: new Date(),
          idempotencyKey: opts?.idempotencyKey,
        };
        pending.set(id, job);
        if (opts?.idempotencyKey) {
          idempotencyIndex.set(opts.idempotencyKey, id);
        }
        if (pending.size > maxEntries) {
          const overflow = pending.size - maxEntries;
          for (let i = 0; i < overflow; i++) {
            const oldest = pending.entries().next().value as [string, MailJob] | undefined;
            if (!oldest) break;
            const [oldestId, oldestJob] = oldest;
            pending.delete(oldestId);
            onDeadLetter?.(
              oldestJob,
              new Error('[slingshot-mail] Memory queue at capacity — job evicted'),
            );
          }
        }
        if (running && provider) {
          trackJob(job);
        }
        metrics.gauge('mail.queue.depth', pending.size);
        return id;
      });
    },
    start(p: MailProvider): Promise<void> {
      return resolveSync(() => {
        provider = p;
        running = true;
        for (const job of pending.values()) {
          trackJob(job);
        }
      });
    },
    stop(): Promise<void> {
      return resolveSync(() => {
        running = false;
        provider = null;
      });
    },
    depth(): Promise<number> {
      return resolveSync(() => pending.size);
    },
    async drain(): Promise<void> {
      if (drainTimeoutMs === 0 || activeJobs.size === 0) {
        await Promise.all([...activeJobs]);
        return;
      }
      const drainAll = Promise.all([...activeJobs]);
      const timeout = new Promise<'timeout'>(resolve =>
        setTimeout(() => resolve('timeout'), drainTimeoutMs),
      );
      const result = await Promise.race([drainAll.then(() => 'done' as const), timeout]);
      if (result === 'timeout') {
        console.warn(
          `[slingshot-mail] drain() timed out after ${drainTimeoutMs}ms — ${activeJobs.size} job(s) still in flight`,
        );
      }
    },
  };
}
