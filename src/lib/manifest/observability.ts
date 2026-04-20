import { z } from 'zod';
import { appManifestHandlerRefSchema } from './helpers';

// -- Logging --
export const loggingSectionSchema = z.object({
  enabled: z.boolean().optional(),
  verbose: z.boolean().optional(),
  authTrace: z.boolean().optional(),
  auditWarnings: z.boolean().optional(),
  onLog: z
    .union([
      z
        .enum(['json', 'pretty'])
        .describe(
          'Built-in request log format. ' +
            '"json" emits structured JSON log lines (suitable for production log aggregators). ' +
            '"pretty" emits human-readable colored log lines (suitable for development).',
        ),
      appManifestHandlerRefSchema,
    ])
    .optional()
    .describe('Request log format or handler reference. Omit to use the framework default logger.'),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  excludePaths: z.array(z.string()).optional(),
  excludeMethods: z.array(z.string()).optional(),
});

// -- Metrics --
export const metricsSectionSchema = z.object({
  enabled: z.boolean().optional(),
  auth: z.union([z.enum(['userAuth', 'none']), z.array(appManifestHandlerRefSchema)]).optional(),
  excludePaths: z.array(z.string()).optional(),
  normalizePath: z
    .union([
      z
        .enum(['strip-ids'])
        .describe(
          'Built-in path normalization strategy. ' +
            '"strip-ids" replaces UUID segments and numeric-only segments with ":id" ' +
            'to prevent high-cardinality metric labels.',
        ),
      appManifestHandlerRefSchema,
    ])
    .optional()
    .describe(
      'Metrics path normalization strategy or handler reference. ' +
        'Omit to use raw request paths as metric labels.',
    ),
  queues: z.array(z.string()).optional(),
  unsafePublic: z.boolean().optional(),
});

// -- Tracing --
export const tracingSectionSchema = z.object({
  enabled: z
    .boolean()
    .optional()
    .describe(
      'Enable distributed tracing via OpenTelemetry. When false or omitted, no tracer is created and there is zero runtime overhead.',
    ),
  serviceName: z
    .string()
    .optional()
    .describe(
      'Service name reported in all spans. Defaults to the app name from meta.name or slingshot-app.',
    ),
});

// -- Observability --
export const observabilitySectionSchema = z.object({
  tracing: tracingSectionSchema
    .loose()
    .optional()
    .describe('Distributed tracing configuration. Omit to disable tracing.'),
});

// -- Validation --
export const validationSectionSchema = z.object({
  formatError: z
    .union([
      z
        .enum(['flat', 'grouped'])
        .describe(
          'Built-in validation error format. ' +
            '"flat" returns a flat array of { path, message } objects. ' +
            '"grouped" returns errors grouped by top-level field name.',
        ),
      appManifestHandlerRefSchema,
    ])
    .optional()
    .describe(
      'Validation error formatter or handler reference. ' +
        'Omit to use the framework default Zod error format.',
    ),
});
