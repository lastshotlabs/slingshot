import { z } from 'zod';

// -- Secrets --
export const secretsSchema = z.union([
  z.object({ provider: z.literal('env'), prefix: z.string().optional() }),
  z.object({
    provider: z.literal('ssm'),
    pathPrefix: z.string(),
    region: z.string().optional(),
  }),
  z.object({ provider: z.literal('file'), directory: z.string() }),
]);

// -- Event Bus --
export const eventBusSchema = z.union([
  z.literal('in-process'),
  z.literal('bullmq'),
  z.object({ type: z.string(), config: z.record(z.string(), z.unknown()).optional() }),
]);
