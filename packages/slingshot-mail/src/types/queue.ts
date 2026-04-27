import type { QueueLifecycle } from '@lastshotlabs/slingshot-core';
import type { MailMessage } from './provider';
import type { MailProvider } from './provider';

/**
 * A single mail delivery job tracked by the queue.
 *
 * Exposed to `onDeadLetter` callbacks so callers can inspect what failed and why.
 */
export interface MailJob {
  /** Unique job ID assigned by the queue. */
  id: string;
  /** The message to be delivered. */
  message: MailMessage;
  /** Bus event key that triggered this job, if any. */
  sourceEvent?: string;
  /** Number of send attempts made so far (0 on first attempt). */
  attempts: number;
  /** Timestamp when the job was enqueued. */
  createdAt: Date;
}

/**
 * Configuration shared by all queue implementations.
 *
 * Used when `config.queue` is omitted from `MailPluginConfig` so the plugin can create a
 * default `MemoryQueue`; also accepted directly by `createBullMQMailQueue`.
 */
export interface MailQueueConfig {
  /** Maximum delivery attempts per job before dead-lettering. Default: 3. */
  maxAttempts?: number;
  /** Base retry delay in milliseconds (doubles on each attempt). Default: 1000. Used by BullMQ. */
  retryBaseDelayMs?: number;
  /**
   * Maximum milliseconds `drain()` will wait for in-flight jobs to settle.
   * When the timeout expires, drain resolves with a console warning rather than hanging.
   * Default: 30000. Set to 0 for no timeout (not recommended in production).
   */
  drainTimeoutMs?: number;
  /**
   * Called when a job exceeds `maxAttempts` or encounters a permanent failure.
   * Use this for alerting, logging, or persisting failed deliveries.
   */
  onDeadLetter?: (job: MailJob, error: Error) => void;
}

/**
 * Interface that every mail queue implementation must satisfy.
 *
 * Extend `QueueLifecycle` (`start`, `stop`, `depth`, `drain`) with mail-specific
 * `enqueue` and `start(provider)`. The in-process `MemoryQueue` and BullMQ-backed
 * queue both implement this interface.
 *
 * @remarks
 * Implement this interface to integrate a custom queue backend (e.g. SQS, RabbitMQ).
 */
export interface MailQueue extends QueueLifecycle {
  /**
   * Add a message to the queue for async delivery.
   * @param message - The fully-resolved message to enqueue.
   * @param opts - Optional metadata attached to the job.
   * @returns The opaque job ID assigned by the queue.
   */
  enqueue(message: MailMessage, opts?: { sourceEvent?: string }): Promise<string>;
  /**
   * Start the queue worker and bind it to the given provider.
   * Called once during plugin `setupPost`. Jobs enqueued before `start()` are
   * processed immediately after the worker is live.
   * @param provider - The transport provider that will handle actual delivery.
   */
  start(provider: MailProvider): Promise<void>;
}
