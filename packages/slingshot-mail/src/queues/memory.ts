import type { DynamicEventBus, MetricsEmitter } from '@lastshotlabs/slingshot-core';
import {
  DEFAULT_MAX_ENTRIES,
  createConsoleLogger,
  createNoopMetricsEmitter,
} from '@lastshotlabs/slingshot-core';
import type { Logger } from '@lastshotlabs/slingshot-core';
import { classifyMailFailure, retryDelayFor } from '../lib/failureClassification';
import type { MailMessage, MailProvider } from '../types/provider';
import { MailSendError } from '../types/provider';
import type { MailJob, MailQueue, MailQueueConfig } from '../types/queue';
import { sendWithTimeout } from './sendWithTimeout';

const logger: Logger = createConsoleLogger({ base: { component: 'slingshot-mail' } });

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
  logger.warn('[slingshot-mail] Memory queue is not durable — for development/testing only');
  const maxAttempts = config?.maxAttempts ?? 3;
  const onDeadLetter = config?.onDeadLetter ?? null;
  const getHookServices = config?.getHookServices;
  const drainTimeoutMs = config?.drainTimeoutMs ?? 30_000;
  const sendTimeoutMs = config?.sendTimeoutMs ?? 30_000;
  const maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // Allow tests / fast environments to override the default 1s/4s/16s
  // backoff schedule. Set to 0 to disable the wait between retries.
  const retryBaseDelayMs = config?.retryBaseDelayMs;
  // Optional unified metrics emitter. The plugin passes its lazily-resolved
  // proxy in here so the queue does not need to be rebuilt once the framework
  // context is available.
  const metrics: MetricsEmitter = config?.metrics ?? createNoopMetricsEmitter();
  const bus: DynamicEventBus | null = config?.bus ?? null;
  const pending: Map<string, MailJob> = new Map();
  const activeJobs = new Set<Promise<void>>();
  // Timer handles for delayed retries — tracked so stop() can clear them.
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  // Maps idempotency key -> original job id so repeated enqueues dedup.
  const idempotencyIndex: Map<string, string> = new Map();
  let provider: MailProvider | null = null;
  let running = false;
  let idCounter = 0;

  function emit(event: string, payload: unknown): void {
    if (!bus) return;
    try {
      bus.emit(event, payload);
    } catch {
      // Bus emission must never break the queue.
    }
  }

  function deadLetter(job: MailJob, err: Error, classification: 'permanent' | 'exhausted'): void {
    pending.delete(job.id);
    metrics.gauge('mail.queue.depth', pending.size);
    if (classification === 'permanent') {
      emit('mail:send.permanentFailure', {
        jobId: job.id,
        message: job.message,
        sourceEvent: job.sourceEvent,
        error: { message: err.message, name: err.name },
      });
    }
    onDeadLetter?.(job, err, getHookServices?.());
  }

  function scheduleRetry(job: MailJob, delayMs: number): void {
    if (delayMs <= 0) {
      trackJob(job);
      return;
    }
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      if (!running || !provider) return;
      trackJob(job);
    }, delayMs);
    retryTimers.add(timer);
  }

  const resolveSync = <T>(operation: () => T): Promise<T> => Promise.resolve().then(operation);

  async function processJob(job: MailJob): Promise<void> {
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
        deadLetter(job, new MailSendError('Provider rejected message', false), 'permanent');
        return;
      }
      metrics.counter('mail.send.count', 1, { ...providerLabel, result: 'success' });
      pending.delete(job.id);
      metrics.gauge('mail.queue.depth', pending.size);
      return;
    } catch (err) {
      const providerLabel = provider ? { provider: provider.name } : { provider: 'unknown' };
      const classification = classifyMailFailure(err);
      if (classification === 'circuitOpen') {
        metrics.gauge('mail.circuitBreaker.state', 1, providerLabel);
        metrics.counter('mail.send.count', 1, { ...providerLabel, result: 'circuitOpen' });
      } else {
        metrics.counter('mail.send.count', 1, { ...providerLabel, result: 'failure' });
        if (err instanceof MailSendError && err.retryAfterMs !== undefined) {
          metrics.gauge('mail.retryAfter', err.retryAfterMs, providerLabel);
        }
      }
      const errorObj = err instanceof Error ? err : new Error(String(err));
      if (classification === 'permanent') {
        deadLetter(job, errorObj, 'permanent');
        return;
      }
      if (job.attempts >= maxAttempts) {
        deadLetter(job, errorObj, 'exhausted');
        return;
      }
      const retryAfterMs =
        err instanceof MailSendError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : undefined;
      const delay = retryDelayFor(job.attempts, retryAfterMs, retryBaseDelayMs);
      scheduleRetry(job, delay);
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
              getHookServices?.(),
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
        for (const t of retryTimers) clearTimeout(t);
        retryTimers.clear();
      });
    },
    depth(): Promise<number> {
      return resolveSync(() => pending.size);
    },
    async drain(): Promise<void> {
      // Drain awaits full quiescence: in-flight jobs settled AND no scheduled
      // retry timers waiting to fire. Retries scheduled by `scheduleRetry`
      // appear here as `retryTimers` until they re-enter `activeJobs` on the
      // tick the timer fires.
      const isQuiescent = (): boolean => activeJobs.size === 0 && retryTimers.size === 0;
      const settle = async (): Promise<void> => {
        while (!isQuiescent()) {
          await Promise.all([...activeJobs]);
          // After awaiting active jobs, more retries may have been scheduled
          // synchronously. Yield once so any newly fired timers register
          // themselves before we re-check quiescence.
          if (retryTimers.size > 0) {
            await new Promise<void>(resolve => setImmediate(resolve));
          }
        }
      };
      if (drainTimeoutMs === 0) {
        await settle();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), drainTimeoutMs);
      });
      const result = await Promise.race([settle().then(() => 'done' as const), timeout]);
      if (timer) clearTimeout(timer);
      if (result === 'timeout') {
        const remaining = activeJobs.size + retryTimers.size;
        const pendingJobs = [...pending.values()].map(j => ({
          id: j.id,
          sourceEvent: j.sourceEvent,
          attempts: j.attempts,
          to: j.message.to,
          subject: j.message.subject,
        }));
        logger.warn(
          `[slingshot-mail] drain() timed out after ${drainTimeoutMs}ms — ${remaining} job(s) still in flight`,
        );
        emit('mail:drain.timedOut', {
          drainTimeoutMs,
          inFlight: remaining,
          pending: pendingJobs,
        });
      }
    },
  };
}
