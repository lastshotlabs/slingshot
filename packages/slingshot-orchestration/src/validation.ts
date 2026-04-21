import { z } from 'zod';

export const retryPolicySchema = z
  .object({
    maxAttempts: z
      .number()
      .int()
      .positive()
      .describe('Maximum attempts including the initial attempt.'),
    backoff: z
      .enum(['fixed', 'exponential'])
      .optional()
      .describe('Delay strategy used between retry attempts.'),
    delayMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Base retry delay in milliseconds.'),
    maxDelayMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Upper bound applied to exponential retry backoff.'),
  })
  .refine(
    data =>
      data.maxDelayMs === undefined ||
      data.delayMs === undefined ||
      data.maxDelayMs >= data.delayMs,
    { message: 'maxDelayMs must be >= delayMs when both are specified.' },
  );

export const runOptionsSchema = z.object({
  idempotencyKey: z
    .string()
    .min(1)
    .optional()
    .describe('Optional idempotency key for deduping runs.'),
  delay: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Optional delay before execution in milliseconds.'),
  tenantId: z.string().min(1).optional().describe('Optional tenant ID associated with the run.'),
  priority: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .optional()
    .describe('Higher priority runs are dequeued first. Bounded to [-1000000, 1000000].'),
  tags: z
    .record(z.string().max(256), z.string().max(1024))
    .optional()
    .refine(tags => !tags || Object.keys(tags).length <= 50, {
      message: 'Maximum 50 tags per run.',
    })
    .describe(
      'Filterable string tags attached to the run. Max 50 tags, keys <=256 chars, values <=1024 chars.',
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Arbitrary metadata stored with the run.'),
  adapterHints: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Adapter-specific escape hatch options validated by the adapter itself.'),
});

export const memoryAdapterOptionsSchema = z.object({
  concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum concurrent task executions in the in-memory adapter.'),
});

export const sqliteAdapterOptionsSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Path to the SQLite database file, or :memory: for an in-memory database.'),
  concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum concurrent task executions in the SQLite adapter.'),
});

export type MemoryAdapterOptions = z.infer<typeof memoryAdapterOptionsSchema>;
export type SqliteAdapterOptions = z.infer<typeof sqliteAdapterOptionsSchema>;
