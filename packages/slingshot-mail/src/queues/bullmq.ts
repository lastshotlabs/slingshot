import type {
  ConnectionOptions as BullConnectionOptions,
  Job as BullJob,
  Queue as BullQueue,
  UnrecoverableError as BullUnrecoverableError,
  Worker as BullWorker,
} from 'bullmq';
import type { Redis } from 'ioredis';
import type { MailMessage, MailProvider } from '../types/provider';
import { MailSendError } from '../types/provider';
import type { MailJob, MailQueue, MailQueueConfig } from '../types/queue';
import { sendWithTimeout } from './sendWithTimeout';

interface BullMQMailQueueConfig extends MailQueueConfig {
  redis: { host: string; port?: number; password?: string } | string;
  queueName?: string;
}

type MailJobData = { message: MailMessage; sourceEvent?: string; idempotencyKey?: string };

/**
 * Creates a durable, Redis-backed mail queue powered by [BullMQ](https://docs.bullmq.io).
 *
 * Requires `bullmq` and `ioredis` as installed dependencies — both are optional peers.
 * The queue tests the Redis connection eagerly on `start()` to surface misconfiguration
 * at startup rather than at first delivery attempt.
 *
 * Non-retryable failures (e.g. provider-rejected messages) are wrapped in
 * `BullMQ.UnrecoverableError` so they bypass BullMQ's built-in retry backoff and are
 * dead-lettered immediately. The original `MailSendError` context (statusCode,
 * providerError) is preserved and forwarded to `onDeadLetter`.
 *
 * @param config - BullMQ config extending `MailQueueConfig` with Redis connection details.
 * @returns A `MailQueue` instance. Call `start(provider)` to connect and begin processing.
 * @throws {Error} If `bullmq` or `ioredis` is not installed (thrown on `start()`).
 * @throws {Error} If the Redis connection cannot be established (thrown on `start()`).
 *
 * @example
 * ```ts
 * import { createBullMQMailQueue } from '@lastshotlabs/slingshot-mail';
 *
 * const queue = createBullMQMailQueue({
 *   redis: { host: 'localhost', port: 6379 },
 *   maxAttempts: 5,
 *   retryBaseDelayMs: 2000,
 *   onDeadLetter: (job, err) => console.error('Dead letter:', job.id, err.message),
 * });
 * ```
 */
export function createBullMQMailQueue(config: BullMQMailQueueConfig): MailQueue {
  const queueName = config.queueName ?? 'slingshot-mail';
  const maxAttempts = config.maxAttempts ?? 3;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? 1000;
  const sendTimeoutMs = config.sendTimeoutMs ?? 30_000;
  let queue: BullQueue | null = null;
  let worker: BullWorker | null = null;
  let connection: Redis | null = null;

  // Preserve original MailSendError context across the UnrecoverableError boundary so
  // onDeadLetter receives full provider context (statusCode, providerError, etc.)
  const nonRetryableOrigins = new WeakMap<Error, MailSendError>();

  return {
    name: 'bullmq',
    async enqueue(
      message: MailMessage,
      opts?: { sourceEvent?: string; idempotencyKey?: string },
    ): Promise<string> {
      if (!queue) throw new Error('BullMQ mail queue not started — call start() first');
      const addOpts: {
        attempts: number;
        backoff: { type: 'exponential'; delay: number };
        jobId?: string;
      } = {
        attempts: maxAttempts,
        backoff: { type: 'exponential', delay: retryBaseDelayMs },
      };
      if (opts?.idempotencyKey) {
        // BullMQ deduplicates enqueues globally per queue when jobId is supplied.
        // A second add() with the same jobId is a no-op and returns the original job.
        addOpts.jobId = opts.idempotencyKey;
      }
      const job = await queue.add(
        'send',
        { message, sourceEvent: opts?.sourceEvent, idempotencyKey: opts?.idempotencyKey },
        addOpts,
      );
      if (job.id === undefined) {
        throw new Error('BullMQ mail queue: queued job is missing an id');
      }
      return job.id;
    },
    async start(provider: MailProvider): Promise<void> {
      let QueueCtor: typeof BullQueue;
      let WorkerCtor: typeof BullWorker;
      let UnrecoverableError: typeof BullUnrecoverableError;
      try {
        const bullmq = await import('bullmq');
        QueueCtor = bullmq.Queue;
        WorkerCtor = bullmq.Worker;
        UnrecoverableError = bullmq.UnrecoverableError;
      } catch {
        throw new Error('BullMQ mail queue requires bullmq to be installed. Run: bun add bullmq');
      }

      let IORedis: typeof Redis;
      try {
        const ioredis = await import('ioredis');
        const redisModule = ioredis as { default?: typeof Redis; Redis?: typeof Redis };
        const RedisCtor = redisModule.default ?? redisModule.Redis;
        if (!RedisCtor) {
          throw new Error('BullMQ mail queue requires ioredis to expose a Redis constructor');
        }
        IORedis = RedisCtor;
      } catch {
        throw new Error('BullMQ mail queue requires ioredis to be installed. Run: bun add ioredis');
      }

      try {
        connection =
          typeof config.redis === 'string'
            ? new IORedis(config.redis, { maxRetriesPerRequest: null })
            : new IORedis({ ...config.redis, maxRetriesPerRequest: null });
        // Test connection immediately — fail fast
        await connection.ping();
      } catch (err) {
        const connStr =
          typeof config.redis === 'string' ? config.redis : JSON.stringify(config.redis);
        throw new Error(
          `BullMQ mail queue: failed to connect to Redis (${connStr}): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      // BullMQ's ConnectionOptions union accepts an ioredis instance at
      // runtime, but the type declaration only enumerates plain options
      // objects. Bridging via `unknown` is the documented interop pattern.
      const conn = connection as unknown as BullConnectionOptions;
      queue = new QueueCtor(queueName, { connection: conn });
      worker = new WorkerCtor(
        queueName,
        async (job: BullJob<MailJobData>) => {
          const { message } = job.data;
          let result;
          try {
            result = await sendWithTimeout(provider, message, sendTimeoutMs);
          } catch (err) {
            if (err instanceof MailSendError && !err.retryable) {
              // Use BullMQ's UnrecoverableError to prevent retries, and preserve the
              // original MailSendError so onDeadLetter receives full provider context.
              const unrecoverable = new UnrecoverableError(err.message);
              nonRetryableOrigins.set(unrecoverable, err);
              throw unrecoverable;
            }
            throw err;
          }
          if (result.status === 'rejected') {
            // Provider accepted the HTTP request but explicitly rejected the message.
            // Do not retry — dead-letter immediately.
            const rejectedErr = new MailSendError('Provider rejected message', false);
            const unrecoverable = new UnrecoverableError(rejectedErr.message);
            nonRetryableOrigins.set(unrecoverable, rejectedErr);
            throw unrecoverable;
          }
        },
        { connection: conn },
      );

      worker.on('failed', (job: BullJob<MailJobData> | undefined, err: Error) => {
        if (!job) return;
        if (job.attemptsMade >= maxAttempts || nonRetryableOrigins.has(err)) {
          const mailJob: MailJob = {
            id: String(job.id),
            message: job.data.message,
            sourceEvent: job.data.sourceEvent,
            attempts: job.attemptsMade,
            createdAt: new Date(job.timestamp),
          };
          // Restore original MailSendError context when available
          const cause = nonRetryableOrigins.get(err) ?? err;
          config.onDeadLetter?.(mailJob, cause);
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
      return await queue.count();
    },
    async drain(): Promise<void> {
      if (!queue) return;
      await queue.drain();
    },
  };
}
