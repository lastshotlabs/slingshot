import { z } from 'zod';

/**
 * Validation schema for the BullMQ orchestration adapter factory options.
 */
export const bullmqOrchestrationAdapterOptionsSchema = z.object({
  connection: z
    .object({
      host: z.string().optional(),
      port: z.number().int().positive().optional(),
    })
    .loose()
    .describe('BullMQ/ioredis connection options or a compatible connection object.'),
  prefix: z.string().optional().describe('Queue name prefix used for all orchestration queues.'),
  concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum concurrent executions for the default task worker.'),
});

/**
 * Typed options accepted by `createBullMQOrchestrationAdapter()`.
 */
export type BullMQOrchestrationAdapterOptions = z.infer<
  typeof bullmqOrchestrationAdapterOptionsSchema
>;
