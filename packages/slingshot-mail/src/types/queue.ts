import type {
  DynamicEventBus,
  MetricsEmitter,
  QueueLifecycle,
} from '@lastshotlabs/slingshot-core';
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
  /**
   * Optional idempotency key used to deduplicate enqueues. When supplied, the queue
   * implementation guarantees that subsequent enqueues with the same key resolve to
   * the original job id without producing a second delivery.
   */
  idempotencyKey?: string;
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
   * Maximum milliseconds a single provider.send() call may run before the job is
   * treated as retryable timeout. Default: 30000. Set to 0 to disable.
   */
  sendTimeoutMs?: number;
  /**
   * Maximum pending in-memory jobs (memory queue only). When exceeded, the
   * oldest job is dead-lettered. Defaults to the framework's
   * `DEFAULT_MAX_ENTRIES`. Set explicitly in tests rather than mocking the
   * core constant.
   */
  maxEntries?: number;
  /**
   * Called when a job exceeds `maxAttempts` or encounters a permanent failure.
   * Use this for alerting, logging, or persisting failed deliveries.
   */
  onDeadLetter?: (job: MailJob, error: Error) => void;
  /**
   * Optional unified metrics emitter. Defaults to a no-op. When provided, the
   * queue records:
   * - `mail.send.count` counter (labels: `provider`, `result=success|failure|circuitOpen`)
   * - `mail.send.duration` timing (labels: `provider`)
   * - `mail.queue.depth` gauge (sampled on each enqueue and dequeue)
   * - `mail.retryAfter` gauge when the provider returns a 429 with a Retry-After hint (labels: `provider`)
   * - `mail.circuitBreaker.state` gauge per provider (`0=closed`, `1=open`, `2=half-open`)
   */
  metrics?: MetricsEmitter;
  /**
   * Optional event bus used to publish queue-level events such as
   * `mail:send.permanentFailure` and `mail:drain.timedOut`. The plugin
   * injects the framework bus when the in-memory queue is auto-created;
   * users wiring a custom queue may pass their own.
   */
  bus?: DynamicEventBus;
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
   * @param opts - Optional metadata attached to the job. When `idempotencyKey` is
   *   present, repeated enqueues with the same key are deduplicated and return the
   *   original job id without producing a second delivery.
   * @returns The opaque job ID assigned by the queue.
   */
  enqueue(
    message: MailMessage,
    opts?: { sourceEvent?: string; idempotencyKey?: string },
  ): Promise<string>;
  /**
   * Start the queue worker and bind it to the given provider.
   * Called once during plugin `setupPost`. Jobs enqueued before `start()` are
   * processed immediately after the worker is live.
   * @param provider - The transport provider that will handle actual delivery.
   */
  start(provider: MailProvider): Promise<void>;
}
