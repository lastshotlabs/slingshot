import { z } from 'zod';

/**
 * TLS settings forwarded to the underlying ioredis connection. All fields
 * are optional; pass them when connecting to Redis behind TLS (e.g. ElastiCache,
 * Upstash, MemoryStore).
 */
export const bullmqTlsOptionsSchema = z
  .object({
    rejectUnauthorized: z
      .boolean()
      .optional()
      .describe('Whether to reject connections with unverified TLS certificates. Default true.'),
    ca: z
      .string()
      .optional()
      .describe('PEM-encoded CA certificate used to verify the Redis server certificate.'),
    cert: z
      .string()
      .optional()
      .describe('PEM-encoded client certificate for mTLS authentication with Redis.'),
    key: z
      .string()
      .optional()
      .describe('PEM-encoded client private key for mTLS authentication with Redis.'),
  })
  .describe('TLS options forwarded to ioredis when connecting to Redis over TLS.');

/**
 * Job retention defaults applied when individual jobs do not specify
 * `removeOnComplete`/`removeOnFail`. Without these, Redis memory grows
 * unbounded as completed/failed jobs accumulate.
 */
export const bullmqJobRetentionSchema = z
  .object({
    removeOnCompleteAge: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Seconds to retain completed jobs before removal (default 3600).'),
    removeOnCompleteCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Maximum number of completed jobs retained per queue (default 1000).'),
    removeOnFailAge: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Seconds to retain failed jobs before removal (default 86400).'),
    removeOnFailCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Maximum number of failed jobs retained per queue (optional).'),
  })
  .describe('Job retention defaults applied to every queue created by the adapter.');

/**
 * Validation schema for the BullMQ orchestration adapter factory options.
 */
export const bullmqOrchestrationAdapterOptionsSchema = z.object({
  connection: z
    .object({
      host: z
        .string()
        .optional()
        .describe("Redis server hostname or IP address. Defaults to 'localhost'."),
      port: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Redis server port number. Defaults to 6379.'),
      // tls accepts either:
      //   • the structured object form (rejectUnauthorized/ca/cert/key) — preferred
      //   • a plain boolean (ioredis's "use TLS with defaults" shorthand)
      //   • any other value passed straight through to ioredis (loose)
      // The `requireTls` option enforces *some* TLS config when true.
      tls: z
        .union([bullmqTlsOptionsSchema, z.boolean(), z.unknown()])
        .optional()
        .describe(
          'TLS configuration for the Redis connection. Pass a structured object, ' +
            "true for ioredis defaults, or any ioredis-compatible TLS value.",
        ),
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
  requireTls: z
    .boolean()
    .optional()
    .describe(
      'When true, the adapter throws at startup if no TLS options were configured. ' +
        'Use this in production to avoid accidentally connecting in plaintext.',
    ),
  shutdownDrainTimeoutMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Maximum time (ms) to wait for in-flight jobs to finish before forcing worker close. ' +
        'Default 30000.',
    ),
  jobRetention: bullmqJobRetentionSchema
    .optional()
    .describe(
      'Job retention defaults applied to every queue. Without these, completed and failed ' +
        'jobs accumulate in Redis unbounded.',
    ),
});

/**
 * Typed options accepted by `createBullMQOrchestrationAdapter()`.
 */
export type BullMQOrchestrationAdapterOptions = z.infer<
  typeof bullmqOrchestrationAdapterOptionsSchema
>;

/** TLS options forwarded to the ioredis connection when connecting to Redis over TLS. */
export type BullMQTlsOptions = z.infer<typeof bullmqTlsOptionsSchema>;
/** Job retention defaults controlling how long completed and failed jobs are kept in Redis. */
export type BullMQJobRetentionOptions = z.infer<typeof bullmqJobRetentionSchema>;
