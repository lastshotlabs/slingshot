import { z } from 'zod';

const manifestHandlerRefSchema = z
  .object({
    handler: z
      .string()
      .min(1)
      .describe('Export name of the handler function in slingshot.handlers.ts.'),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Static parameters forwarded to the handler at registration time.'),
  })
  .strict()
  .describe('Reference to a named handler export with optional static parameters.');

const temporalAdapterManifestConfigSchema = z
  .object({
    address: z.string().min(1).describe('Temporal server gRPC address (e.g. "localhost:7233").'),
    namespace: z
      .string()
      .min(1)
      .optional()
      .describe('Temporal namespace. Defaults to the server default namespace when omitted.'),
    workflowTaskQueue: z
      .string()
      .min(1)
      .describe('Task queue name used for workflow task polling.'),
    defaultActivityTaskQueue: z
      .string()
      .min(1)
      .optional()
      .describe('Default task queue for activity tasks when not specified per-activity.'),
    worker: z
      .object({
        buildId: z
          .string()
          .min(1)
          .describe('Worker versioning build identifier for deterministic replay.'),
        identity: z
          .string()
          .min(1)
          .optional()
          .describe('Human-readable worker identity reported to the Temporal server.'),
        maxConcurrentWorkflowTaskExecutions: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum concurrent workflow task executions for this worker.'),
        maxConcurrentActivityTaskExecutions: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum concurrent activity task executions for this worker.'),
      })
      .strict()
      .optional()
      .describe('Temporal worker configuration options.'),
    tls: z
      .object({
        serverNameOverride: z
          .string()
          .optional()
          .describe('Override the expected TLS server name for certificate verification.'),
        serverRootCACertificate: z
          .string()
          .optional()
          .describe('PEM-encoded root CA certificate for the Temporal server.'),
        clientCertPair: z
          .object({
            crt: z.string().describe('PEM-encoded client certificate.'),
            key: z.string().describe('PEM-encoded client private key.'),
          })
          .strict()
          .optional()
          .describe('mTLS client certificate pair for authenticating with the Temporal server.'),
      })
      .strict()
      .optional()
      .describe('TLS configuration for connecting to a Temporal server over mTLS.'),
  })
  .strict()
  .describe('Configuration schema for the Temporal orchestration adapter.');

/**
 * Manifest schema for the Slingshot orchestration plugin configuration.
 */
export const orchestrationPluginConfigSchema = z
  .object({
    adapter: z
      .object({
        type: z
          .enum(['memory', 'sqlite', 'bullmq', 'temporal'])
          .describe("Orchestration backend type. Use 'memory' or 'sqlite' for development."),
        config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Adapter-specific configuration. Shape depends on the chosen adapter type ' +
              "(e.g. Temporal address/namespace for 'temporal', Redis connection for 'bullmq').",
          ),
      })
      .strict()
      .describe('Adapter selection and its backend-specific configuration.'),
    tasks: z
      .array(z.string().min(1))
      .describe('Handler names of tasks to register with the orchestration runtime.'),
    workflows: z
      .array(z.string().min(1))
      .optional()
      .describe('Handler names of workflows to register. Omit when only tasks are used.'),
    routes: z
      .boolean()
      .optional()
      .describe('Mount the orchestration HTTP API routes. Defaults to false.'),
    routePrefix: z
      .string()
      .min(1)
      .optional()
      .describe("URL prefix for orchestration routes (e.g. '/orchestration')."),
    routeTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Per-request timeout in milliseconds for orchestration HTTP route adapter calls.'),
    startMaxAttempts: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum number of attempts for adapter.start() in setupPost. Default: 1 (no retry).',
      ),
    startBackoffMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Base backoff delay (ms) for adapter.start() retries. Each retry doubles. Default: 1000.',
      ),
    routeMiddleware: z
      .array(manifestHandlerRefSchema)
      .optional()
      .describe(
        'Middleware handler references applied to every orchestration route. ' +
          'At least one guard is required when routes are enabled.',
      ),
    resolveRequestContext: manifestHandlerRefSchema
      .optional()
      .describe(
        'Handler that extracts tenant/actor metadata from an HTTP request for orchestration runs.',
      ),
    authorizeRun: manifestHandlerRefSchema
      .optional()
      .describe(
        'Handler that authorizes read, cancel, signal, and list operations on individual runs.',
      ),
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
