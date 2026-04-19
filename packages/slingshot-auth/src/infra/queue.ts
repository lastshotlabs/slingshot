// Auth-internal BullMQ queue/worker factory.
// Redis connection captured once at factory creation — no per-call threading.
import { createRequire } from 'node:module';
import type {
  ConnectionOptions,
  Job,
  Processor,
  QueueOptions,
  Queue as QueueType,
  WorkerOptions,
  Worker as WorkerType,
} from 'bullmq';
import type * as IORedis from 'ioredis';

const require = createRequire(import.meta.url);

function requireBullMQ(): typeof import('bullmq') {
  try {
    return require('bullmq');
  } catch {
    throw new Error('bullmq is not installed. Run: bun add bullmq');
  }
}

export interface AuthQueueFactory {
  createQueue<T = unknown, R = unknown>(
    name: string,
    options?: Omit<QueueOptions, 'connection'>,
  ): AuthQueue<T, R>;

  createWorker<T = unknown, R = unknown>(
    name: string,
    processor: Processor<T, R>,
    options?: Omit<WorkerOptions, 'connection'>,
  ): WorkerType<T, R>;
}

type BullMQRedisConnection = ConnectionOptions & IORedis.Redis;
type AuthQueue<T, R> = QueueType<T, R, string, T, R, string>;

/**
 * Create a queue factory that captures Redis connection info once.
 * All queues and workers created from this factory share the same connection.
 */
export function createQueueFactory(getRedis: () => BullMQRedisConnection): AuthQueueFactory {
  const client = getRedis();

  const { Queue, Worker } = requireBullMQ();

  return {
    createQueue<T = unknown, R = unknown>(
      name: string,
      options?: Omit<QueueOptions, 'connection'>,
    ): AuthQueue<T, R> {
      return new Queue<T, R, string, T, R, string>(name, { connection: client, ...options });
    },

    createWorker<T = unknown, R = unknown>(
      name: string,
      processor: Processor<T, R>,
      options?: Omit<WorkerOptions, 'connection'>,
    ): WorkerType<T, R> {
      return new Worker<T, R>(name, processor, { connection: client, ...options });
    },
  };
}

export type { Job };
