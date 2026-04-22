import { z } from 'zod';

const manifestHandlerRefSchema = z
  .object({
    handler: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const temporalAdapterManifestConfigSchema = z
  .object({
    address: z.string().min(1),
    namespace: z.string().min(1).optional(),
    workflowTaskQueue: z.string().min(1),
    defaultActivityTaskQueue: z.string().min(1).optional(),
    worker: z
      .object({
        buildId: z.string().min(1),
        identity: z.string().min(1).optional(),
        maxConcurrentWorkflowTaskExecutions: z.number().int().positive().optional(),
        maxConcurrentActivityTaskExecutions: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    tls: z
      .object({
        serverNameOverride: z.string().optional(),
        serverRootCACertificate: z.string().optional(),
        clientCertPair: z
          .object({
            crt: z.string(),
            key: z.string(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Manifest schema for the Slingshot orchestration plugin configuration.
 */
export const orchestrationPluginConfigSchema = z
  .object({
    adapter: z
      .object({
        type: z.enum(['memory', 'sqlite', 'bullmq', 'temporal']),
        config: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    tasks: z.array(z.string().min(1)),
    workflows: z.array(z.string().min(1)).optional(),
    routes: z.boolean().optional(),
    routePrefix: z.string().min(1).optional(),
    routeMiddleware: z.array(manifestHandlerRefSchema).optional(),
    resolveRequestContext: manifestHandlerRefSchema.optional(),
    authorizeRun: manifestHandlerRefSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.adapter.type === 'temporal') {
      const parsed = temporalAdapterManifestConfigSchema.safeParse(value.adapter.config ?? {});
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            ...issue,
            path: ['adapter', 'config', ...issue.path],
          });
        }
      }
    }
  });

/**
 * Typed manifest config accepted by the built-in orchestration plugin resolver.
 */
export type OrchestrationPluginManifestConfig = z.infer<typeof orchestrationPluginConfigSchema>;
