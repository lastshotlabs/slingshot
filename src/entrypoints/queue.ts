/**
 * BullMQ queue/worker entrypoint.
 *
 * Re-exports the queue factory and all associated types from the framework's
 * internal `lib/queue` module. Import from this entrypoint rather than reaching
 * into internal paths.
 *
 * **Factory**
 * - {@link createQueueFactory} — create a queue factory bound to specific Redis
 *   credentials. Returns a `QueueFactory` object with methods for creating queues,
 *   workers, cron workers, dead-letter-queue handlers, and cleaning up stale
 *   schedulers. Requires `bullmq` to be installed (`bun add bullmq`).
 *
 * **Types**
 * - `Job` — BullMQ job type (re-exported for convenience in processor signatures).
 * - `SlingshotWorker` — typed worker handle returned by `createWorker`.
 * - `CronSchedule` — cron expression string type for `createCronWorker`.
 * - `DLQOptions` — configuration for dead-letter-queue retry/discard behavior.
 * - `QueueFactory` — the factory interface itself.
 * - `QueueRedisCredentials` — Redis credentials shape accepted by `createQueueFactory`.
 *
 * @example
 * ```ts
 * import { createQueueFactory } from '@lastshotlabs/slingshot/queue';
 *
 * const queues = createQueueFactory({ host: 'localhost:6379' });
 * const emailQueue = queues.createQueue<EmailJobData>('emails');
 * const worker = queues.createWorker('emails', async job => sendEmail(job.data));
 * ```
 */

export { createQueueFactory } from '../lib/queue.js';
export type {
  Job,
  SlingshotWorker,
  CronSchedule,
  DLQOptions,
  QueueFactory,
  QueueRedisCredentials,
} from '../lib/queue.js';
