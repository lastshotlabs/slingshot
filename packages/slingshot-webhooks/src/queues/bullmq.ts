import type {
  ConnectionOptions as BullConnectionOptions,
  Job as BullJob,
  Queue as BullQueue,
  Worker as BullWorker,
} from 'bullmq';
import type { Redis } from 'ioredis';
import type { WebhookJob, WebhookQueue } from '../types/queue';
import { WebhookDeliveryError } from '../types/queue';

/**
 * Configuration for `createBullMQWebhookQueue`.
 *
 * All fields except `redis` are optional and fall back to documented defaults.
 *
 * @remarks
 * `redis` accepts either a plain connection object `{ host, port?, password? }` or a
 * Redis URL string (e.g. `"redis://localhost:6379"` or `"rediss://..."` for TLS).
 * BullMQ requires `maxRetriesPerRequest: null` on the ioredis client — this is
 * set automatically by the factory and must not be overridden externally.
 *
 * `maxAttempts` and `retryBaseDelayMs` control the exponential-backoff retry policy:
 * the delay before attempt N is `retryBaseDelayMs * 2^(N-1)`. Non-retryable failures
 * (`WebhookDeliveryError` with `retryable: false`) bypass this schedule and are
 * dead-lettered immediately regardless of `maxAttempts`.
 */
interface BullMQWebhookQueueConfig {
  /**
   * Redis connection config. Accepts a plain object `{ host, port?, password? }` or
   * a Redis URL string (e.g. `"redis://localhost:6379"`).
   */
  redis: { host: string; port?: number; password?: string } | string;
  /** BullMQ queue name. Default: `'slingshot-webhooks'`. */
  queueName?: string;
  /**
   * Maximum number of delivery attempts before a job is dead-lettered.
   * Default: 5.
   */
  maxAttempts?: number;
  /**
   * Base delay in milliseconds for exponential backoff between retries.
   * Actual delay for attempt N is `retryBaseDelayMs * 2^(N-1)`. Default: 1000.
   */
  retryBaseDelayMs?: number;
  /**
   * Callback invoked when a job is permanently failed (exhausted retries or non-retryable error).
   * Receives the final `WebhookJob` snapshot and the last `Error`.
   */
  onDeadLetter?: (job: WebhookJob, err: Error) => void | Promise<void>;
}

/**
 * The subset of `WebhookJob` fields persisted in the BullMQ Redis job data object.
 *
 * @remarks
 * `id` is omitted because BullMQ assigns it from an internal auto-increment counter
 * and exposes it as `job.id`. `createdAt` is omitted because BullMQ persists the
 * enqueue wall-clock time as `job.timestamp` (Unix ms); it is reconstructed via
 * `new Date(bullJob.timestamp)` when the processor receives the job. `attempts` is
 * omitted because BullMQ tracks the attempt count as `job.attemptsMade` — it is not
 * stored in the data payload to avoid drift between the two sources of truth.
 */
type WebhookJobData = Omit<WebhookJob, 'id' | 'createdAt' | 'attempts'>;

function requireJobId(id: string | number | undefined | null): string {
  if (id == null) {
    throw new Error('BullMQ returned a job without an id');
  }
  return String(id);
}

/**
 * Creates a durable, Redis-backed webhook delivery queue powered by [BullMQ](https://docs.bullmq.io).
 *
 * Requires `bullmq` and `ioredis` as installed dependencies. The queue eagerly tests the
 * Redis connection on `start()` to surface misconfiguration at startup. Non-retryable
 * failures (e.g. 4xx responses, permanent `WebhookDeliveryError`) are dead-lettered
 * immediately without burning retry attempts.
 *
 * @param config - BullMQ config with Redis connection, queue name, max attempts, and dead-letter handler.
 * @returns A `WebhookQueue` instance. Call `start(processor)` to connect and begin processing.
 * @throws {Error} If `bullmq` or `ioredis` is not installed (thrown on `start()`).
 * @throws {Error} If the Redis connection cannot be established (thrown on `start()`).
 *
 * @example
 * ```ts
 * import { createBullMQWebhookQueue } from '@lastshotlabs/slingshot-webhooks';
 *
 * const queue = createBullMQWebhookQueue({
 *   redis: { host: 'localhost', port: 6379 },
 *   maxAttempts: 5,
 *   onDeadLetter: (job, err) => console.error('Dead letter:', job.deliveryId, err.message),
 * });
 * ```
 */
export function createBullMQWebhookQueue(config: BullMQWebhookQueueConfig): WebhookQueue {
  const queueName = config.queueName ?? 'slingshot-webhooks';
  const maxAttempts = config.maxAttempts ?? 5;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? 1000;
  let queue: BullQueue | null = null;
  let worker: BullWorker | null = null;
  let connection: Redis | null = null;

  return {
    name: 'bullmq',
    async enqueue(jobInput: Omit<WebhookJob, 'id' | 'createdAt'>): Promise<string> {
      if (!queue) throw new Error('BullMQ webhook queue not started — call start() first');
      const job = await queue.add('deliver', jobInput, {
        attempts: maxAttempts,
        backoff: { type: 'exponential', delay: retryBaseDelayMs },
      });
      return requireJobId(job.id);
    },
    async start(processor: (job: WebhookJob) => Promise<void>): Promise<void> {
      let QueueCtor: typeof BullQueue;
      let WorkerCtor: typeof BullWorker;
      let UnrecoverableError: typeof import('bullmq').UnrecoverableError;
      try {
        const bullmq = await import('bullmq');
        QueueCtor = bullmq.Queue;
        WorkerCtor = bullmq.Worker;
        UnrecoverableError = bullmq.UnrecoverableError;
      } catch {
        throw new Error(
          'BullMQ webhook queue requires bullmq to be installed. Run: bun add bullmq',
        );
      }

      let IORedis: typeof Redis;
      try {
        const ioredis = await import('ioredis');
        const defaultRedis = (ioredis as { default?: typeof Redis }).default;
        const namedRedis = (ioredis as { Redis?: typeof Redis }).Redis;
        if (defaultRedis) {
          IORedis = defaultRedis;
        } else if (namedRedis) {
          IORedis = namedRedis;
        } else {
          throw new Error('BullMQ webhook queue requires ioredis to export a Redis constructor');
        }
      } catch {
        throw new Error(
          'BullMQ webhook queue requires ioredis to be installed. Run: bun add ioredis',
        );
      }

      try {
        connection =
          typeof config.redis === 'string'
            ? new IORedis(config.redis, { maxRetriesPerRequest: null })
            : new IORedis({ ...config.redis, maxRetriesPerRequest: null });
        await connection.ping();
      } catch (err) {
        const connStr =
          typeof config.redis === 'string' ? config.redis : JSON.stringify(config.redis);
        throw new Error(
          `BullMQ webhook queue: failed to connect to Redis (${connStr}): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      const conn = connection as unknown as BullConnectionOptions;
      queue = new QueueCtor(queueName, { connection: conn });
      worker = new WorkerCtor(
        queueName,
        async (bullJob: BullJob<WebhookJobData>) => {
          const webhookJob: WebhookJob = {
            id: requireJobId(bullJob.id),
            deliveryId: bullJob.data.deliveryId,
            endpointId: bullJob.data.endpointId,
            url: bullJob.data.url,
            secret: bullJob.data.secret,
            event: bullJob.data.event,
            payload: bullJob.data.payload,
            attempts: bullJob.attemptsMade,
            createdAt: new Date(bullJob.timestamp),
          };
          try {
            await processor(webhookJob);
          } catch (err) {
            if (err instanceof WebhookDeliveryError && !err.retryable) {
              throw new UnrecoverableError(err.message);
            }
            throw err;
          }
        },
        { connection: conn },
      );

      worker.on('failed', (bullJob: BullJob<WebhookJobData> | undefined, err: Error) => {
        if (!bullJob) return;
        const isUnrecoverable = err instanceof UnrecoverableError;
        const isExhausted = bullJob.attemptsMade >= maxAttempts;
        if (isUnrecoverable || isExhausted) {
          const webhookJob: WebhookJob = {
            id: String(bullJob.id),
            deliveryId: bullJob.data.deliveryId,
            endpointId: bullJob.data.endpointId,
            url: bullJob.data.url,
            secret: bullJob.data.secret,
            event: bullJob.data.event,
            payload: bullJob.data.payload,
            attempts: bullJob.attemptsMade,
            createdAt: new Date(bullJob.timestamp),
          };
          void config.onDeadLetter?.(webhookJob, err);
        }
      });
    },
    async stop(): Promise<void> {
      await worker?.close();
      await queue?.close();
      await connection?.quit();
      worker = null;
      queue = null;
      connection = null;
    },
    async depth(): Promise<number> {
      if (!queue) return 0;
      return queue.count();
    },
  };
}
