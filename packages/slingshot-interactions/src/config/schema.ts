import { z } from 'zod';
import { deepFreeze } from '@lastshotlabs/slingshot-core';
import { handlerTemplateSchema } from '../handlers/template';

/** Manifest-safe config schema for `createInteractionsPlugin()`. */
export const interactionsPluginConfigSchema = z
  .object({
    mountPath: z.string().startsWith('/').min(1).default('/interactions'),
    handlers: z.record(z.string().min(1).max(100), handlerTemplateSchema).default({}),
    rateLimit: z
      .object({
        windowMs: z.number().int().positive().default(60_000),
        max: z.number().int().positive().default(20),
      })
      .default({ windowMs: 60_000, max: 20 }),
  })
  .transform(config =>
    deepFreeze({
      mountPath: config.mountPath,
      handlers: config.handlers,
      rateLimit: {
        windowMs: config.rateLimit.windowMs,
        max: config.rateLimit.max,
      },
    }),
  );
