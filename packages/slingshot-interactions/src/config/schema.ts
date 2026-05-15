import { z } from 'zod';
import { handlerTemplateSchema } from '../handlers/template';

/** Config schema for `createInteractionsPackage()`. */
export const interactionsPluginConfigSchema = z.object({
  mountPath: z.string().startsWith('/').min(1).default('/interactions'),
  handlers: z.record(z.string().min(1).max(100), handlerTemplateSchema).default({}),
  rateLimit: z
    .object({
      windowMs: z.number().int().positive().default(60_000),
      max: z.number().int().positive().default(20),
    })
    .default({ windowMs: 60_000, max: 20 }),
});
