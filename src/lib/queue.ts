// BullMQ queue/worker factories — no module-level mutable state.
//
// Queue helpers require explicit Redis credentials or a queue factory created
// from startup-resolved secrets. No process.env fallback here — framework code
// should resolve secrets at startup and pass them in.
import { createRequire } from 'node:module';
import type {
  Job,
  Processor,
  QueueOptions,
  Queue as QueueType,
  WorkerOptions,
  Worker as WorkerType,
} from 'bullmq';
import { type RedisCredentials, getRedisConnectionOptions } from './redis';

const require = createRequire(import.meta.url);

function requireBullMQ(): typeof import('bullmq') {
  try {
    return require('bullmq') as typeof import('bullmq');
  } catch {
    throw new Error('bullmq is not installed. Run: bun add bullmq');
  }
}

function requireQueueRedisCredentials(credentials?: RedisCredentials): RedisCredentials {
  if (!credentials?.host) {
    throw new Error(
      'Queue helpers require explicit Redis credentials. Resolve Redis secrets at startup and pass them to createQueueFactory(...) or as the final queue helper argument.',
    );
  }
  return credentials;
}

function getQueueRedisConnectionOptions(credentials: RedisCredentials) {
  return getRedisConnectionOptions(credentials);
}

type GetConnectionOptions = () => ReturnType<typeof getRedisConnectionOptions>;

function buildQueueHelpers(getConnectionOptions: GetConnectionOptions) {
  return {
    createQueue<T = unknown, R = unknown>(
      name: string,
      options?: Omit<QueueOptions, 'connection'>,
    ): QueueType<T, R> {
      const { Queue } = requireBullMQ();
      return new Queue<T, R>(name, { connection: getConnectionOptions(), ...options });
    },

    createWorker<T = unknown, R = unknown>(
      name: string,
      processor: Processor<T, R>,
      options?: Omit<WorkerOptions, 'connection'>,
    ): WorkerType<T, R> {
      const { Worker } = requireBullMQ();
      return new Worker<T, R>(name, processor, {
        connection: getConnectionOptions(),
        ...options,
      });
    },

    createCronWorker<T = void, R = unknown>(
      name: string,
      processor: Processor<T, R>,
      schedule: CronSchedule,
      options?: Omit<WorkerOptions, 'connection'>,
    ): { worker: WorkerType<T, R>; queue: QueueType<T, R>; registeredName: string } {
      const { Queue, Worker } = requireBullMQ();
      const connection = getConnectionOptions();

      const queue = new Queue<T, R>(name, { connection });
      const worker = new Worker<T, R>(name, processor, { connection, ...options });

      // Use upsertJobScheduler — idempotent across restarts.
      // Cast at the opaque BullMQ generic boundary: ExtractNameType<T> constrains the
      // scheduler ID to match job data's `name` field, but we use plain string IDs.
      const q = queue as unknown as {
        upsertJobScheduler(
          id: string,
          repeatOpts: { pattern?: string; tz?: string; every?: number },
          jobTemplate?: { name: string },
        ): Promise<unknown>;
      };
      if (schedule.cron) {
        void q.upsertJobScheduler(
          name,
          { pattern: schedule.cron, tz: schedule.timezone },
          { name },
        );
      } else if (schedule.every) {
        void q.upsertJobScheduler(name, { every: schedule.every }, { name });
      }

      return { worker, queue, registeredName: name };
    },

    async cleanupStaleSchedulers(
      activeNames: string[],
      registeredNames: ReadonlySet<string>,
    ): Promise<void> {
      const { Queue } = requireBullMQ();
      const connection = getConnectionOptions();
      const activeSet = new Set(activeNames);

      for (const name of registeredNames) {
        if (activeSet.has(name)) continue;
        const queue = new Queue(name, { connection });
        try {
          await queue.removeJobScheduler(name);
        } catch {
          /* scheduler may not exist */
        }
        await queue.close();
      }
    },

    createDLQHandler<T = unknown>(
      sourceWorker: WorkerType<T>,
      sourceQueueName: string,
      options?: DLQOptions<T>,
    ): { dlqQueue: QueueType<T>; retryJob: (jobId: string) => Promise<void> } {
      const { Queue } = requireBullMQ();
      const connection = getConnectionOptions();
      const dlqName = `${sourceQueueName}-dlq`;
      const dlqQueue: QueueType<T> = new Queue<T>(dlqName, { connection });
      const maxSize = options?.maxSize ?? 1000;
      const preserveJobOptions = options?.preserveJobOptions ?? true;

      // Cast at the opaque BullMQ generic boundary: DLQ jobs use dynamic `dlq:` prefixed
      // names which don't satisfy ExtractNameType<T>'s literal constraint.
      const dlqQueueAny = dlqQueue as unknown as {
        add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
      };

      sourceWorker.on('failed', async (job: Job<T> | undefined, error: Error) => {
        if (!job) return;
        if (job.attemptsMade < (job.opts.attempts ?? 1)) return;

        await dlqQueueAny.add(`dlq:${job.name}`, job.data, {
          ...(preserveJobOptions
            ? {
                delay: job.opts.delay,
                priority: job.opts.priority,
                attempts: job.opts.attempts,
                backoff: job.opts.backoff,
              }
            : {}),
          jobId: `dlq:${job.id}`,
        });

        if (options?.onDeadLetter) {
          try {
            await options.onDeadLetter(job, error);
          } catch (e) {
            console.error(`[dlq:${sourceQueueName}] onDeadLetter callback error:`, e);
          }
        }

        const waitingCount = await dlqQueue.getWaitingCount();
        if (waitingCount > maxSize) {
          const excess = waitingCount - maxSize;
          const jobs = await dlqQueue.getWaiting(0, excess - 1);
          for (const j of jobs) {
            await j.remove();
          }
        }
      });

      const sourceQueue = new Queue<T>(sourceQueueName, { connection });

      const retryJob = async (jobId: string): Promise<void> => {
        const job = await dlqQueue.getJob(jobId);
        if (!job) throw new Error(`Job ${jobId} not found in DLQ`);

        const retryOptions = preserveJobOptions
          ? {
              delay: job.opts.delay,
              priority: job.opts.priority,
              attempts: job.opts.attempts,
              backoff: job.opts.backoff,
            }
          : {};

        await (
          sourceQueue as unknown as {
            add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
          }
        ).add(job.name as string, job.data as T, retryOptions);
        await job.remove();
      };

      return { dlqQueue, retryJob };
    },
  };
}

export interface CronSchedule {
  /** Cron expression. Mutually exclusive with `every`. */
  cron?: string;
  /** Interval in milliseconds. Mutually exclusive with `cron`. */
  every?: number;
  /** Timezone for cron expressions. */
  timezone?: string;
}

export interface DLQOptions<T = unknown> {
  /** Max jobs to keep in the DLQ. Default: 1000. */
  maxSize?: number;
  /** Called when a job is moved to the DLQ. */
  onDeadLetter?: (job: Job<T>, error: Error) => Promise<void>;
  /** Auto-retry delay in ms. No auto-retry by default. */
  retryAfter?: number;
  /** Preserve original job options on retry. Default: true. */
  preserveJobOptions?: boolean;
}

export interface QueueFactory {
  createQueue<T = unknown, R = unknown>(
    name: string,
    options?: Omit<QueueOptions, 'connection'>,
  ): QueueType<T, R>;

  createWorker<T = unknown, R = unknown>(
    name: string,
    processor: Processor<T, R>,
    options?: Omit<WorkerOptions, 'connection'>,
  ): WorkerType<T, R>;

  createCronWorker<T = void, R = unknown>(
    name: string,
    processor: Processor<T, R>,
    schedule: CronSchedule,
    options?: Omit<WorkerOptions, 'connection'>,
  ): { worker: WorkerType<T, R>; queue: QueueType<T, R>; registeredName: string };

  cleanupStaleSchedulers(
    activeNames: string[],
    registeredNames: ReadonlySet<string>,
  ): Promise<void>;

  createDLQHandler<T = unknown>(
    sourceWorker: WorkerType<T>,
    sourceQueueName: string,
    options?: DLQOptions<T>,
  ): { dlqQueue: QueueType<T>; retryJob: (jobId: string) => Promise<void> };
}

export function createQueueFactory(credentials: RedisCredentials): QueueFactory {
  const resolvedCredentials = requireQueueRedisCredentials(credentials);
  const getConnectionOptions = () => getQueueRedisConnectionOptions(resolvedCredentials);
  return buildQueueHelpers(getConnectionOptions);
}

export function createQueue<T = unknown, R = unknown>(
  name: string,
  options?: Omit<QueueOptions, 'connection'>,
  credentials?: RedisCredentials,
): QueueType<T, R> {
  return createQueueFactory(requireQueueRedisCredentials(credentials)).createQueue<T, R>(
    name,
    options,
  );
}

export function createWorker<T = unknown, R = unknown>(
  name: string,
  processor: Processor<T, R>,
  options?: Omit<WorkerOptions, 'connection'>,
  credentials?: RedisCredentials,
): WorkerType<T, R> {
  return createQueueFactory(requireQueueRedisCredentials(credentials)).createWorker<T, R>(
    name,
    processor,
    options,
  );
}

export function createCronWorker<T = void, R = unknown>(
  name: string,
  processor: Processor<T, R>,
  schedule: CronSchedule,
  options?: Omit<WorkerOptions, 'connection'>,
  credentials?: RedisCredentials,
): { worker: WorkerType<T, R>; queue: QueueType<T, R>; registeredName: string } {
  return createQueueFactory(requireQueueRedisCredentials(credentials)).createCronWorker<T, R>(
    name,
    processor,
    schedule,
    options,
  );
}

export function cleanupStaleSchedulers(
  activeNames: string[],
  registeredNames: ReadonlySet<string>,
  credentials?: RedisCredentials,
): Promise<void> {
  return createQueueFactory(requireQueueRedisCredentials(credentials)).cleanupStaleSchedulers(
    activeNames,
    registeredNames,
  );
}

export function createDLQHandler<T = unknown>(
  sourceWorker: WorkerType<T>,
  sourceQueueName: string,
  options?: DLQOptions<T>,
  credentials?: RedisCredentials,
): { dlqQueue: QueueType<T>; retryJob: (jobId: string) => Promise<void> } {
  return createQueueFactory(requireQueueRedisCredentials(credentials)).createDLQHandler<T>(
    sourceWorker,
    sourceQueueName,
    options,
  );
}

/**
 * Contract for worker files loaded by createServer()'s worker discovery.
 *
 * A worker file's default export should be a SlingshotWorker. The framework
 * calls it at startup with a properly-credentialed QueueFactory and collects
 * the returned names for scheduler lifecycle management.
 *
 * @example
 * ```ts
 * // workers/digest.ts
 * import type { SlingshotWorker } from 'slingshot/queue'
 *
 * const worker: SlingshotWorker = async (factory) => {
 *   const { registeredName } = factory.createCronWorker(
 *     'digest-emails',
 *     digestProcessor,
 *     { cron: '0 9 * * *' },
 *   )
 *   return [registeredName]
 * }
 * export default worker
 * ```
 */
export type SlingshotWorker = (factory: QueueFactory) => string[] | Promise<string[]>;

export type { Job, RedisCredentials as QueueRedisCredentials };
