import { z } from 'zod';

const temporalTlsSchema = z
  .object({
    serverNameOverride: z
      .string()
      .optional()
      .describe('Override the server name used for TLS verification.'),
    serverRootCACertificate: z
      .string()
      .optional()
      .describe('PEM-encoded root CA certificate for verifying the Temporal server.'),
    clientCertPair: z
      .object({
        crt: z.string().describe('PEM-encoded client certificate.'),
        key: z.string().describe('PEM-encoded client private key.'),
      })
      .strict()
      .optional()
      .describe('Client certificate key pair for mutual TLS authentication.'),
  })
  .strict();

/**
 * Validation schema for manifest-style Temporal connection settings.
 */
export const temporalConnectionConfigSchema = z
  .object({
    address: z.string().min(1).describe('Temporal server host:port address.'),
    namespace: z
      .string()
      .min(1)
      .optional()
      .describe('Temporal namespace to connect to. Defaults to the server default namespace.'),
    workflowTaskQueue: z
      .string()
      .min(1)
      .describe('Task queue used for dispatching workflow tasks.'),
    defaultActivityTaskQueue: z
      .string()
      .min(1)
      .optional()
      .describe('Default task queue for activity tasks when not specified per-activity.'),
    tls: temporalTlsSchema
      .optional()
      .describe('TLS configuration for securing the Temporal connection.'),
  })
  .strict();

/**
 * Validation schema for the server-side Temporal orchestration adapter options.
 *
 * `dataConverter` and `interceptors` are pass-through slots forwarded to both
 * the Temporal `Client` and `Worker` constructors. Use `dataConverter` to
 * install a payload codec for sensitive-data redaction (PII), and
 * `interceptors` to inject auth headers, tracing, or custom workflow/activity
 * interceptor modules.
 */
export const temporalAdapterOptionsSchema = z.object({
  client: z
    .custom<object>(value => typeof value === 'object' && value !== null)
    .describe('Pre-constructed Temporal Client instance.'),
  connection: z
    .custom<object>(value => value === undefined || (typeof value === 'object' && value !== null))
    .optional()
    .describe(
      'Temporal Connection backing the client. Required when ownsConnection is true so the adapter can close it on shutdown.',
    ),
  namespace: z
    .string()
    .min(1)
    .optional()
    .describe('Temporal namespace to target. Defaults to the namespace configured on the client.'),
  workflowTaskQueue: z
    .string()
    .min(1)
    .describe('Task queue used for dispatching workflow tasks.'),
  defaultActivityTaskQueue: z
    .string()
    .min(1)
    .optional()
    .describe('Default task queue for activity tasks when not specified per-activity.'),
  workflowNamePrefix: z
    .string()
    .min(1)
    .optional()
    .describe('Optional prefix prepended to workflow type names to avoid collisions.'),
  visibilityQueryPageSize: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe('Page size for Temporal visibility list queries. Max 1000.'),
  ownsConnection: z
    .boolean()
    .optional()
    .describe(
      'When true the adapter will close the underlying connection on shutdown.',
    ),
  /**
   * Optional Temporal `DataConverter` used for serializing and deserializing
   * payloads. Forwarded to both the `Client` and `Worker` so server-side and
   * worker-side codecs stay symmetric. Default is unchanged (Temporal's
   * default JSON converter).
   */
  dataConverter: z
    .custom<object>(value => value === undefined || (typeof value === 'object' && value !== null))
    .optional()
    .describe(
      'Temporal DataConverter for payload serialization. Forwarded to both Client and Worker for symmetric codec transforms.',
    ),
  /**
   * Optional client/worker interceptors. The shape is the union of
   * `ClientInterceptors` (passed to the `Client`) and the worker-side
   * `WorkerInterceptors` fields (`workflowModules`, `activityInbound`,
   * `activity`) so a single config slot can populate both sides.
   */
  interceptors: z
    .custom<object>(value => value === undefined || (typeof value === 'object' && value !== null))
    .optional()
    .describe(
      'Client and worker interceptors for auth headers, tracing, or custom workflow/activity interception.',
    ),
  /**
   * Maximum time (ms) to wait for a single `maybeQueryState(handle)` poll
   * before considering it hung and giving up. Defaults to 5_000.
   */
  queryTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum time in milliseconds to wait for a single state query before timing out. Defaults to 5000.',
    ),
  /**
   * Optional instrumentation hook fired after every `query()` issued via
   * the adapter. Receives the runId, duration, and an optional error. Default
   * is no-op so existing apps observe no behavior change until they opt in.
   */
  onQuery: z
    .custom<object>(value => value === undefined || typeof value === 'function')
    .optional()
    .describe(
      'Instrumentation hook called after every query. Receives runId, durationMs, and optional error.',
    ),
  /**
   * Optional instrumentation hook fired after every `signal()` issued via
   * the adapter. Same shape as `onQuery`.
   */
  onSignal: z
    .custom<object>(value => value === undefined || typeof value === 'function')
    .optional()
    .describe(
      'Instrumentation hook called after every signal. Receives runId, durationMs, and optional error.',
    ),
});

/**
 * Validation schema for the Temporal worker bootstrap options.
 */
export const temporalWorkerOptionsSchema = z.object({
  connection: z
    .custom<object>(value => typeof value === 'object' && value !== null)
    .describe('Temporal NativeConnection or Connection instance for the worker.'),
  ownsConnection: z
    .boolean()
    .optional()
    .describe('When true the worker will close the connection on shutdown.'),
  namespace: z
    .string()
    .min(1)
    .optional()
    .describe('Temporal namespace the worker connects to.'),
  workflowTaskQueue: z
    .string()
    .min(1)
    .describe('Task queue the worker polls for workflow tasks.'),
  defaultActivityTaskQueue: z
    .string()
    .min(1)
    .optional()
    .describe('Default task queue for activity tasks when not specified per-activity.'),
  buildId: z
    .string()
    .trim()
    .min(1)
    .describe('Build identifier used for Temporal worker versioning.'),
  definitionsModulePath: z
    .string()
    .trim()
    .min(1)
    .describe('Absolute or resolvable path to the module exporting task and workflow definitions.'),
  taskNames: z
    .array(z.string().trim().min(1))
    .optional()
    .describe('Explicit list of task names to register. When omitted all exported tasks are used.'),
  workflowNames: z
    .array(z.string().trim().min(1))
    .optional()
    .describe(
      'Explicit list of workflow names to register. When omitted all exported workflows are used.',
    ),
  generatedWorkflowsDir: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Directory containing generated Temporal workflow bundles.'),
  eventSink: z
    .custom<object>(value => value === undefined || (typeof value === 'object' && value !== null))
    .optional()
    .describe('Event sink for forwarding worker lifecycle events to the application event bus.'),
  identity: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Human-readable identity string reported to the Temporal server for this worker.',
    ),
  maxConcurrentWorkflowTaskExecutions: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of workflow tasks executed concurrently by this worker.'),
  maxConcurrentActivityTaskExecutions: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of activity tasks executed concurrently by this worker.'),
  /**
   * Optional Temporal `DataConverter` used for serializing and deserializing
   * payloads. Should match the converter installed on the server-side
   * `Client` so that codec transforms are symmetric.
   */
  dataConverter: z
    .custom<object>(value => value === undefined || (typeof value === 'object' && value !== null))
    .optional()
    .describe(
      'Temporal DataConverter for payload serialization. Should match the converter on the server-side Client.',
    ),
  /**
   * Optional worker interceptors (`WorkerInterceptors`) including
   * `workflowModules`, `activityInbound`, and `activity`. Pipe-through to
   * `Worker.create({ interceptors })`.
   */
  interceptors: z
    .custom<object>(value => value === undefined || (typeof value === 'object' && value !== null))
    .optional()
    .describe(
      'Worker interceptors (workflowModules, activityInbound, activity) forwarded to Worker.create().',
    ),
});

/**
 * Typed manifest-style Temporal connection settings.
 */
export type TemporalConnectionConfig = z.infer<typeof temporalConnectionConfigSchema>;
/**
 * Typed options accepted by `createTemporalOrchestrationAdapter()`.
 */
export type TemporalOrchestrationAdapterOptions = z.infer<typeof temporalAdapterOptionsSchema>;
/**
 * Typed options accepted by `createTemporalOrchestrationWorker()`.
 */
export type TemporalOrchestrationWorkerOptions = z.infer<typeof temporalWorkerOptionsSchema>;
