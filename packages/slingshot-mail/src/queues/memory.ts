import { DEFAULT_MAX_ENTRIES, evictOldest } from '@lastshotlabs/slingshot-core';
import { TemplateNotFoundError } from '@lastshotlabs/slingshot-core';
import type { MailMessage, MailProvider } from '../types/provider';
import { MailSendError } from '../types/provider';
import type { MailJob, MailQueue, MailQueueConfig } from '../types/queue';

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
  const pending: Map<string, MailJob> = new Map();
  const activeJobs = new Set<Promise<void>>();
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
        const result = await activeProvider.send(job.message);
        if (result.status === 'rejected') {
          onDeadLetter?.(job, new MailSendError('Provider rejected message', false));
          pending.delete(job.id);
          return;
        }
        pending.delete(job.id);
        return;
      } catch (err) {
        const isRetryable = err instanceof MailSendError ? err.retryable : true;
        const isPermanent = err instanceof TemplateNotFoundError || !isRetryable;
        if (isPermanent || job.attempts >= maxAttempts) {
          onDeadLetter?.(job, err instanceof Error ? err : new Error(String(err)));
          pending.delete(job.id);
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
    enqueue(message: MailMessage, opts?: { sourceEvent?: string }): Promise<string> {
      return resolveSync(() => {
        const id = String(++idCounter);
        const job: MailJob = {
          id,
          message,
          sourceEvent: opts?.sourceEvent,
          attempts: 0,
          createdAt: new Date(),
        };
        pending.set(id, job);
        if (pending.size > DEFAULT_MAX_ENTRIES) {
          const overflow = pending.size - DEFAULT_MAX_ENTRIES;
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
        } else {
          evictOldest(pending, DEFAULT_MAX_ENTRIES);
        }
        if (running && provider) {
          trackJob(job);
        }
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
