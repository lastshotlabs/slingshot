/**
 * App Manifest Schema — Zod-validated, JSON-serializable slingshot app specification.
 *
 * The manifest is the single source of truth for config-driven app generation.
 * It contains NO functions, class instances, or imports — only plain data.
 * Function-typed config fields are referenced by name via the handler registry
 * pattern: `{ handler: "name", params?: {} }`.
 *
 * Flow: JSON → validate → resolve constraints → generate CreateServerConfig
 */
import { z } from 'zod';
import { manifestEntitiesSchema } from '@lastshotlabs/slingshot-entity';
import { appManifestHandlerRefSchema, pluginRefSchema } from './helpers';
import { dbSectionSchema, jobsSectionSchema, tenancySectionSchema } from './infrastructure';
import { metaSectionSchema } from './meta';
import {
  loggingSectionSchema,
  metricsSectionSchema,
  observabilitySectionSchema,
  validationSectionSchema,
} from './observability';
import { sseSectionSchema, tlsSectionSchema, wsSectionSchema } from './realtime';
import { eventBusSchema, secretsSchema } from './secrets';
import { securitySectionSchema } from './security';
import { modelSchemasSchema, ssgSectionSchema, versioningSchema } from './ssg';
import { navigationSectionSchema, pagesSectionSchema, ssrSectionSchema } from './ssr';
import { uploadSectionSchema } from './upload';
import { validateManifestCrossFields } from './validation';

const lambdaTriggerSchema = z
  .enum([
    'apigw',
    'apigw-v2',
    'alb',
    'function-url',
    'sqs',
    'msk',
    'kinesis',
    'dynamodb-streams',
    's3',
    'sns',
    'eventbridge',
    'schedule',
  ])
  .describe('Lambda trigger kind consumed by slingshot-runtime-lambda.');

const lambdaIdempotencySchema = z
  .union([
    z.boolean(),
    z
      .object({
        ttl: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('TTL in seconds for persisted idempotency entries.'),
        scope: z
          .enum(['global', 'tenant', 'user'])
          .optional()
          .describe('Identity scope used when deriving the idempotency storage key.'),
        fingerprint: z
          .boolean()
          .optional()
          .describe('Whether request fingerprint mismatches should fail with a conflict.'),
      })
      .strict(),
  ])
  .optional()
  .describe('Optional Lambda idempotency configuration for the handler binding.');

const lambdaBindingSchema = z
  .object({
    handler: z
      .string()
      .min(1)
      .describe('Named SlingshotHandler export resolved from the manifest handler registry.'),
    trigger: lambdaTriggerSchema,
    idempotency: lambdaIdempotencySchema,
  })
  .strict();

// Re-export public API from helpers
export { appManifestHandlerRefSchema, pluginRefSchema, storageRefSchema } from './helpers';
export type { AppManifestHandlerRef, PluginRef, StorageRef } from './helpers';

// ---------------------------------------------------------------------------
// Top-level App Manifest
// ---------------------------------------------------------------------------

export const appManifestSchema = z
  .object({
    /**
     * Manifest format version. Enables future migrations.
     */
    manifestVersion: z.literal(1).describe('Manifest format version. Must be 1.'),

    /**
     * Handler file configuration for the manifest pipeline.
     *
     * - `string` — path to a single handlers file, relative to the manifest file.
     *   Example: `"slingshot.handlers.ts"`, `"./src/handlers.ts"`.
     * - `{ dir: string }` — path to a directory of handler files. All `.ts` and `.js`
     *   files in the directory (non-recursive) are imported and their exports registered.
     *   Example: `{ "dir": "./handlers" }`.
     * - `false` — explicitly disable handler auto-loading.
     *
     * When omitted, defaults to `"slingshot.handlers.ts"` (resolved relative to the manifest file).
     */
    handlers: z
      .union([
        z.string().describe('Path to a single handlers file, relative to the manifest.'),
        z
          .object({
            dir: z
              .string()
              .describe('Path to a directory of handler files, relative to the manifest.'),
          })
          .strict(),
        z.literal(false).describe('Disable handler auto-loading.'),
      ])
      .optional()
      .describe(
        'Handler file or directory for named function handlers and lifecycle hooks. ' +
          'Defaults to "slingshot.handlers.ts" adjacent to the manifest when omitted.',
      ),

    /**
     * Absolute path to the service's routes directory.
     * Supports `${importMetaDir}` placeholder for `import.meta.dir`.
     */
    routesDir: z
      .string()
      .optional()
      .describe(
        'Absolute path to the service routes directory. Supports ${importMetaDir}. Omit when routes are registered elsewhere.',
      ),

    /** Model schema paths/config. */
    modelSchemas: modelSchemasSchema
      .optional()
      .describe(
        'Model schema registration paths or configuration. Omit to register no additional model schemas.',
      ),

    /** App metadata (name, version). */
    meta: metaSectionSchema
      .optional()
      .describe(
        'Application metadata such as name and version. Omit to leave metadata unspecified.',
      ),

    /** Security configuration. */
    security: securitySectionSchema
      .loose()
      .optional()
      .describe('Application-wide security configuration. Omit to use the framework defaults.'),

    /** Named middleware references, applied in order after plugins. */
    middleware: z
      .array(appManifestHandlerRefSchema)
      .optional()
      .describe(
        'Named middleware handlers applied after plugins. Omit to register no extra middleware.',
      ),

    /** Database and store configuration. */
    db: dbSectionSchema
      .loose()
      .optional()
      .describe(
        'Database and store configuration for framework subsystems. Omit to use runtime defaults.',
      ),

    /** Job queue configuration. */
    jobs: jobsSectionSchema
      .loose()
      .optional()
      .describe(
        'Job queue endpoint and authorization configuration. Omit to use the framework defaults.',
      ),

    /** Multi-tenancy configuration. */
    tenancy: tenancySectionSchema
      .loose()
      .optional()
      .describe(
        'Multi-tenancy resolution and caching configuration. Omit to disable manifest-level tenancy handling.',
      ),

    /** Logging configuration. */
    logging: loggingSectionSchema
      .loose()
      .optional()
      .describe(
        'Request logging configuration. Omit to use the framework default logging behavior.',
      ),

    /** Metrics endpoint configuration. */
    metrics: metricsSectionSchema
      .loose()
      .optional()
      .describe(
        'Metrics endpoint configuration. Omit to use the framework default metrics behavior.',
      ),

    /** Observability configuration (tracing, future: profiling). */
    observability: observabilitySectionSchema
      .loose()
      .optional()
      .describe(
        'Observability configuration including distributed tracing. Omit to use the framework defaults.',
      ),

    /** Validation error formatting. */
    validation: validationSectionSchema
      .loose()
      .optional()
      .describe('Validation error formatting hooks. Omit to use the framework default formatter.'),

    /** File upload configuration. */
    upload: uploadSectionSchema
      .loose()
      .optional()
      .describe(
        'Application-wide upload configuration. Omit to disable manifest-level upload setup.',
      ),

    /**
     * First-class SSR runtime configuration.
     *
     * Prefer this top-level section over `plugins[].config` when wiring the
     * built-in `slingshot-ssr` plugin from a manifest.
     */
    ssr: ssrSectionSchema
      .loose()
      .optional()
      .describe('First-class SSR runtime configuration. Omit to disable manifest-level SSR setup.'),

    /**
     * Static generation policy.
     *
     * Shared paths inherit from the `ssr` section when omitted here.
     */
    ssg: ssgSectionSchema
      .loose()
      .optional()
      .describe('Static site generation policy. Omit to disable manifest-level SSG setup.'),

    /** API versioning. */
    versioning: versioningSchema
      .optional()
      .describe('API versioning configuration. Omit to disable version-aware routing.'),

    /** Plugin references with config. */
    plugins: z
      .array(pluginRefSchema)
      .optional()
      .describe(
        'Plugin declarations instantiated during manifest bootstrap. Omit to register no explicit plugins.',
      ),

    /** Event bus type. */
    eventBus: eventBusSchema
      .optional()
      .describe('Event-bus backend configuration. Omit to use the in-process default event bus.'),

    /** Secret provider configuration. */
    secrets: secretsSchema
      .optional()
      .describe(
        'Secret provider configuration used during bootstrap. Omit to resolve secrets from the default provider.',
      ),

    /**
     * Server-level permissions bootstrap. When set, the framework creates a shared
     * permissions adapter, registry, and evaluator from the existing infra connection
     * and makes them available to all plugins via `ctx.pluginState`.
     *
     * Requires `@lastshotlabs/slingshot-permissions` to be installed.
     */
    permissions: z
      .object({
        /** Which store backend to use. Must match a store configured in `db`. */
        adapter: z
          .enum(['sqlite', 'postgres', 'mongo', 'memory'])
          .describe(
            'Store backend used by the shared permissions services. One of: sqlite, postgres, mongo, memory.',
          ),
      })
      .optional()
      .describe(
        'Shared permissions bootstrap configuration. Omit to skip manifest-level permissions setup.',
      ),

    /**
     * Entity definitions (JSON-serializable).
     *
     * Each key is the entity name. Each value defines fields, indexes,
     * operations, and other entity config — the JSON equivalent of
     * defineEntity() + defineOperations().
     *
     * `createServerFromManifest()` automatically synthesizes a `slingshot-entity`
     * plugin from this section. Use `manifestEntitiesToConfigs()` when you need
     * resolved `ResolvedEntityConfig` objects for lower-level composition.
     *
     * @example
     * {
     *   User: {
     *     fields: {
     *       id: { type: 'string', primary: true, default: 'uuid' },
     *       email: { type: 'string' },
     *     },
     *   },
     * }
     */
    entities: manifestEntitiesSchema
      .optional()
      .describe(
        'Entity definitions keyed by entity name. Omit to create an app with no manifest-defined entities.',
      ),

    /**
     * Entity lifecycle hooks.
     *
     * `afterAdapters` hooks run after all entity adapters are created, giving
     * custom operation handlers access to other entity adapters through the
     * repository pattern. This is the same mechanism plugins like
     * `slingshot-assets` use internally.
     *
     * Each hook is resolved by name from the manifest handler registry
     * (exported via the `hooks` object in `slingshot.handlers.ts`).
     *
     * @example
     * ```json
     * {
     *   "hooks": {
     *     "afterAdapters": [
     *       { "handler": "captureAdapters" }
     *     ]
     *   }
     * }
     * ```
     */
    hooks: z
      .object({
        afterAdapters: z
          .array(appManifestHandlerRefSchema)
          .optional()
          .describe(
            'Hooks executed after entity adapters are created. Use to capture adapter references for cross-entity custom operations.',
          ),
      })
      .optional()
      .describe(
        'Entity lifecycle hooks for manifest-driven apps. Omit when no cross-entity adapter access is needed.',
      ),

    /**
     * Declarative Lambda function bindings consumed by
     * `@lastshotlabs/slingshot-runtime-lambda`.
     *
     * The server bootstrap path validates this section but otherwise ignores it.
     */
    lambdas: z
      .record(z.string(), lambdaBindingSchema)
      .optional()
      .describe(
        'Lambda function bindings keyed by export name. Consumed by slingshot-runtime-lambda, ignored by the HTTP server bootstrap path.',
      ),

    /**
     * URL prefix applied to all entity-generated routes.
     * E.g. `"/api"` mounts routes at `/api/accounts`, `/api/merchants`, etc.
     * Defaults to `""` (no prefix).
     */
    apiPrefix: z
      .string()
      .optional()
      .describe(
        'URL prefix applied to all entity-generated routes. Omit to mount entity routes with no extra prefix.',
      ),

    /** Renderer-agnostic entity-driven SSR page declarations. */
    pages: pagesSectionSchema.describe(
      'Renderer-agnostic page declarations for manifest-driven SSR.',
    ),

    /** Optional shell/navigation config passed through to SSR renderers. */
    navigation: navigationSectionSchema
      .optional()
      .describe(
        'Shell and navigation configuration passed through to SSR renderers. Omit to render without manifest-level navigation config.',
      ),

    // -- Server-level fields --

    /** Server port. */
    port: z
      .number()
      .optional()
      .describe('TCP port the server listens on. Omit to use the runtime default port.'),

    /** Bind address. */
    hostname: z
      .string()
      .optional()
      .describe('Bind address for the HTTP server. Omit to use the runtime default hostname.'),

    /** Unix socket path. */
    unix: z
      .string()
      .optional()
      .describe('Unix socket path for the server. Omit to listen on TCP instead.'),

    /** TLS configuration. */
    tls: tlsSectionSchema
      .loose()
      .optional()
      .describe('TLS configuration for HTTPS servers. Omit to serve plain HTTP.'),

    /** Workers directory path. */
    workersDir: z
      .string()
      .optional()
      .describe(
        'Directory containing worker modules. Omit to use the framework default worker discovery path.',
      ),

    /** Enable auto-loading workers. */
    enableWorkers: z
      .boolean()
      .optional()
      .describe(
        'Whether workers are auto-loaded from workersDir. Omit to use the framework default worker-loading behavior.',
      ),

    /** WebSocket configuration. */
    ws: wsSectionSchema
      .loose()
      .optional()
      .describe(
        'WebSocket endpoint configuration. Omit to disable manifest-level WebSocket setup.',
      ),

    /** SSE configuration. */
    sse: sseSectionSchema
      .loose()
      .optional()
      .describe(
        'Server-sent events endpoint configuration. Omit to disable manifest-level SSE setup.',
      ),

    /** Max request body size in bytes. */
    maxRequestBodySize: z
      .number()
      .optional()
      .describe('Maximum request body size in bytes. Omit to use the framework default limit.'),

    /**
     * Seed data applied on first boot.
     *
     * Users listed here are created only if they do not already exist (checked by
     * email). When `superAdmin: true`, a global super-admin grant is created for
     * the user via the permissions plugin (if installed).
     *
     * Passwords are hashed at seed time and never stored in plaintext. This
     * section is intended for local development and initial deployment bootstrap
     * — rotate credentials immediately after first login in production.
     *
     * @example
     * ```json
     * {
     *   "seed": {
     *     "users": [
     *       { "email": "admin@example.com", "password": "changeme", "superAdmin": true }
     *     ]
     *   }
     * }
     * ```
     */
    seed: z
      .object({
        users: z
          .array(
            z.object({
              email: z.email().describe('Email address of the seeded user.'),
              password: z.string().min(1).describe('Plaintext password hashed at seed time.'),
              superAdmin: z
                .boolean()
                .optional()
                .describe(
                  'Whether the seeded user receives a global super-admin grant. Omit to create a regular user.',
                ),
            }),
          )
          .optional(),
        orgs: z
          .array(
            z.object({
              name: z.string().min(1).describe('Display name of the seeded organization.'),
              /** URL-safe slug: lowercase letters, digits, hyphens, underscores. */
              slug: z
                .string()
                .regex(
                  /^[a-z0-9_-]+$/,
                  'slug must be lowercase alphanumeric with hyphens/underscores',
                )
                .describe('URL-safe slug used to identify the seeded organization.'),
              tenantId: z
                .string()
                .optional()
                .describe(
                  'Tenant ID associated with the seeded organization. Omit to let the app derive the tenant ID.',
                ),
              metadata: z
                .record(z.string(), z.unknown())
                .optional()
                .describe(
                  'Additional metadata stored on the seeded organization. Omit to seed the organization without metadata.',
                ),
              /**
               * Users to add as members on creation.
               * Each entry references a seed user by email (or any existing user).
               */
              members: z
                .array(
                  z.object({
                    email: z
                      .email()
                      .describe('Email address of the member to add to the seeded organization.'),
                    roles: z
                      .array(z.string())
                      .optional()
                      .describe(
                        'Roles granted to the seeded organization member. Omit to add the member without explicit roles.',
                      ),
                  }),
                )
                .optional(),
            }),
          )
          .optional(),
      })
      .optional()
      .describe('Seed data applied on first boot. Omit to skip manifest-driven seeding.'),
  })
  .loose()
  .superRefine(validateManifestCrossFields);

export type AppManifest = z.infer<typeof appManifestSchema>;
/** First-class SSR manifest section. */
export type AppManifestSsrSection = z.infer<typeof ssrSectionSchema>;
/** First-class SSG manifest section. */
export type AppManifestSsgSection = z.infer<typeof ssgSectionSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface AppManifestValidationResult {
  success: true;
  manifest: AppManifest;
  warnings: string[];
}

export interface AppManifestValidationError {
  success: false;
  errors: string[];
}

/**
 * Parse and validate a raw app manifest object.
 * Returns typed manifest on success, structured errors on failure.
 */
export function validateAppManifest(
  raw: unknown,
): AppManifestValidationResult | AppManifestValidationError {
  const result = appManifestSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.issues.map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return { success: false, errors };
  }

  const warnings: string[] = [];
  const manifest = result.data;

  if (manifest.unix && manifest.port !== undefined) {
    warnings.push('unix and port are mutually exclusive — port will be ignored');
  }
  if (manifest.unix && manifest.tls) {
    warnings.push('unix sockets do not support TLS — tls will be ignored');
  }

  return { success: true, manifest, warnings };
}
