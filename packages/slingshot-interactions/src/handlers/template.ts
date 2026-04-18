import { z } from 'zod';

const webhookHandlerTemplateSchema = z.object({
  kind: z.literal('webhook'),
  target: z.url(),
  timeoutMs: z.number().int().positive().default(5000),
  headers: z.record(z.string(), z.string()).optional(),
  signingSecret: z.string().min(1).optional(),
});

const routeHandlerTemplateSchema = z.object({
  kind: z.literal('route'),
  target: z.string().regex(/^\//, 'route targets must start with /'),
  timeoutMs: z.number().int().positive().default(5000),
});

const queueHandlerTemplateSchema = z
  .object({
    kind: z.literal('queue'),
    target: z
      .string()
      .min(1)
      .refine(
        value => !['security.', 'auth:', 'push:', 'app:'].some(prefix => value.startsWith(prefix)),
        'queue target uses a forbidden namespace',
      ),
    fireAndForget: z.boolean().default(true),
  })
  .strict();

/** Declarative handler template used by manifest-safe interactions config. */
export const handlerTemplateSchema = z.discriminatedUnion('kind', [
  webhookHandlerTemplateSchema,
  routeHandlerTemplateSchema,
  queueHandlerTemplateSchema,
]);

/** Union of all declarative handler kinds. */
export type HandlerTemplate = z.output<typeof handlerTemplateSchema>;
/** Remote webhook handler configuration. */
export type WebhookHandlerTemplate = z.output<typeof webhookHandlerTemplateSchema>;
/** Internal route handler configuration. */
export type RouteHandlerTemplate = z.output<typeof routeHandlerTemplateSchema>;
/** Event-bus queue handler configuration. */
export type QueueHandlerTemplate = z.output<typeof queueHandlerTemplateSchema>;
