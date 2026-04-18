import type { QueueLifecycle } from '@lastshotlabs/slingshot-core';

/**
 * A single webhook delivery job tracked by the queue.
 *
 * Contains all the data needed to execute one HTTP delivery attempt without additional
 * database lookups. Exposed to queue processors and `onDeadLetter` callbacks.
 */
export interface WebhookJob {
  /** Queue-assigned job ID. */
  id: string;
  /** ID of the `WebhookDelivery` record this job is executing. */
  deliveryId: string;
  /** ID of the target `WebhookEndpoint`. */
  endpointId: string;
  /** Target URL for the `POST` request. */
  url: string;
  /** HMAC-SHA256 signing secret used to produce the `X-Webhook-Signature` header. */
  secret: string;
  /** Bus event key that triggered this delivery. */
  event: string;
  /** JSON-serialised event payload to be sent as the request body. */
  payload: string;
  /** Number of delivery attempts made for this job so far. */
  attempts: number;
  /** Timestamp when this job was enqueued. */
  createdAt: Date;
}

/**
 * Interface that every webhook queue implementation must satisfy.
 *
 * Extends `QueueLifecycle` with webhook-specific `enqueue` and `start(processor)`.
 * The in-process `MemoryQueue` and BullMQ-backed queue both implement this interface.
 *
 * @remarks
 * Implement this interface to integrate a custom queue backend (e.g. SQS, RabbitMQ).
 */
export interface WebhookQueue extends QueueLifecycle {
  /**
   * Adds a delivery job to the queue for asynchronous processing.
   *
   * @param job - Job data without `id` or `createdAt` — both are assigned by the queue
   *   implementation at persistence time, before this method returns.
   * @returns The opaque job ID assigned by the queue (e.g. a BullMQ job ID string, or a
   *   UUID for the in-memory queue). This ID is not the same as the `deliveryId`.
   *
   * @remarks
   * The job ID is assigned and persisted by the queue backend before the returned
   * `Promise` resolves. Callers can use the returned ID to inspect or cancel the job
   * if the queue backend supports it. `createdAt` is set to the enqueue wall-clock time,
   * not the time the processor picks up the job.
   */
  enqueue(job: Omit<WebhookJob, 'id' | 'createdAt'>): Promise<string>;

  /**
   * Connects the queue and starts the worker with the given processor function.
   *
   * @param processor - Async function invoked for each dequeued job. Must throw (or
   *   reject) to signal failure — the queue uses this to apply retry / dead-letter logic.
   *   Throwing a `WebhookDeliveryError` with `retryable: false` bypasses remaining
   *   retries and dead-letters the job immediately.
   * @returns A promise that resolves once the worker is connected and ready to process jobs.
   *
   * @remarks
   * Jobs enqueued before `start()` is called are held in the backing store and will be
   * picked up immediately once the worker is live. Concurrency is capped by the queue
   * implementation (BullMQ uses a `concurrency` worker option; the in-memory queue
   * processes jobs sequentially). On process restart, durable queue backends (e.g. BullMQ
   * with Redis) will re-process any jobs that were in-flight at the time of shutdown,
   * so processor functions must be idempotent.
   */
  start(processor: (job: WebhookJob) => Promise<void>): Promise<void>;
}

/**
 * Thrown by the webhook dispatcher when an HTTP delivery attempt fails.
 *
 * The `retryable` flag controls queue behaviour: non-retryable errors (e.g. 4xx client
 * errors except 429) are dead-lettered immediately; retryable errors (e.g. network
 * timeout, 5xx, 429) are re-queued up to `config.queueConfig.maxAttempts`.
 *
 * @example
 * ```ts
 * if (err instanceof WebhookDeliveryError && !err.retryable) {
 *   console.error('Permanent webhook failure:', err.message, err.statusCode);
 * }
 * ```
 */
export class WebhookDeliveryError extends Error {
  /** Whether the queue should retry this job. */
  retryable: boolean;
  /** HTTP status code returned by the target endpoint, if a response was received. */
  statusCode?: number;
  /**
   * @param message - Human-readable error message.
   * @param retryable - Whether the queue should retry this job.
   * @param statusCode - HTTP status code from the target endpoint, if available.
   */
  constructor(message: string, retryable: boolean, statusCode?: number) {
    super(message);
    this.name = 'WebhookDeliveryError';
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}
