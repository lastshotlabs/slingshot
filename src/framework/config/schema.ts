/**
 * Zod schemas for full-depth config validation.
 *
 * These schemas validate the complete shape of `CreateAppConfig` and
 * `CreateServerConfig` at startup — catching typos, wrong types, and structural
 * errors at every nesting level. Type mismatches always throw. Unknown keys
 * throw in production and emit warnings in development.
 *
 * ## Composition
 *
 * The two top-level schemas are built from section schemas, one per config
 * domain. The hierarchy is:
 *
 * ```
 * appConfigSchema
 * ├── meta          → appSectionSchema       (sections/meta.ts)
 * ├── security      → securitySchema          (sections/security.ts)
 * │   ├── cors      → corsObjectSchema
 * │   ├── rateLimit → rateLimitSchema
 * │   ├── botProtection → botProtectionSchema
 * │   ├── signing   → signingSchema
 * │   │   ├── presignedUrls   → signingPresignedUrlsSchema
 * │   │   ├── requestSigning  → signingRequestSigningSchema
 * │   │   └── sessionBinding  → signingSessionBindingSchema
 * │   └── captcha   → captchaSchema
 * ├── db            → dbSchema               (sections/db.ts)
 * │   └── redis     → redisObjectSchema
 * ├── jobs          → jobsSchema             (sections/jobs.ts)
 * ├── tenancy       → tenancySchema          (sections/tenancy.ts)
 * ├── logging       → loggingSchema          (sections/logging.ts)
 * ├── metrics       → metricsSchema          (sections/metrics.ts)
 * ├── validation    → validationSchema       (sections/validation.ts)
 * ├── upload        → uploadSchema           (sections/upload.ts)
 * │   └── presignedUrls → uploadPresignedSchema
 * ├── versioning    → versioningObjectSchema (sections/versioning.ts)
 * └── modelSchemas  → modelSchemasObjectSchema (sections/modelSchemas.ts)
 *
 * serverConfigSchema  (extends appConfigSchema)
 * ├── ...all appConfigSchema fields
 * ├── port, hostname, unix
 * ├── tls           → tlsSchema             (sections/tls.ts)
 * ├── ws            → wsSchema              (sections/ws.ts)
 * │   └── endpoints → wsEndpointSchema
 * ├── sse           → sseSchema             (sections/sse.ts)
 * │   └── endpoints → sseEndpointSchema
 * ├── workersDir, enableWorkers
 * └── maxRequestBodySize
 * ```
 *
 * Every section schema is applied with `.passthrough()` inside the parent so
 * that extra keys at the section level survive the Zod parse and are caught by
 * the separate {@link collectNestedUnknownKeys} traversal, which emits warnings
 * (or throws in production) rather than silently dropping them.
 *
 * ## Adding a new config field
 *
 * 1. Add the field to the relevant section schema in `sections/`.
 * 2. Add the section schema (or nested sub-schema) to {@link SCHEMA_MAP} so
 *    that unknown-key detection covers the new field's siblings.
 * 3. Export the new schema if callers need to reference it directly.
 * 4. Update JSDoc in both the section file and this file.
 */
import { z } from 'zod';
import { dbSchema, redisObjectSchema } from './sections/db';
import { jobsSchema } from './sections/jobs';
import { loggingSchema } from './sections/logging';
import { appSectionSchema } from './sections/meta';
import { metricsSchema } from './sections/metrics';
import { modelSchemasObjectSchema } from './sections/modelSchemas';
import {
  botProtectionSchema,
  captchaSchema,
  corsObjectSchema,
  csrfSchema,
  rateLimitSchema,
  securitySchema,
  signingPresignedUrlsSchema,
  signingRequestSigningSchema,
  signingSchema,
  signingSessionBindingSchema,
} from './sections/security';
import { sseSchema } from './sections/sse';
import { tenancySchema } from './sections/tenancy';
import { tlsSchema } from './sections/tls';
import { uploadPresignedSchema, uploadSchema } from './sections/upload';
import { validationSchema } from './sections/validation';
import { versioningObjectSchema } from './sections/versioning';
import { wsSchema } from './sections/ws';

/**
 * Zod schema for `CreateAppConfig` — the application-level configuration object.
 *
 * Covers all features that are common to both embedded-app and standalone-server
 * use cases: routing, database, jobs, security, tenancy, logging, metrics,
 * validation, upload, versioning, model schemas, plugins, and the event bus.
 *
 * All top-level fields are optional. The schema uses `.passthrough()` so that
 * unrecognised keys survive parsing; they are detected separately by
 * {@link validateAppConfig} and either warned about (development) or throw
 * (production).
 *
 * @remarks
 * **Top-level fields:**
 * - `routesDir` — Directory from which file-based routes are loaded. Defaults
 *   to `"src/routes"` relative to the project root.
 * - `modelSchemas` — Glob path(s) or object descriptor for entity schema
 *   discovery. See {@link modelSchemasObjectSchema}.
 * - `meta` — Application name and version. See `appSectionSchema`.
 * - `security` — CORS, rate-limiting, signing, captcha, and bot protection.
 *   See {@link securitySchema}.
 * - `middleware` — Array of Hono middleware applied globally before all routes.
 *   Elements are typed as `unknown` to avoid importing Hono types here.
 * - `db` — Database and cache backend configuration. See {@link dbSchema}.
 * - `jobs` — Background-job status endpoint configuration. See `jobsSchema`.
 * - `tenancy` — Multi-tenancy resolution strategy. See `tenancySchema`.
 * - `logging` — Request logger configuration. See `loggingSchema`.
 * - `metrics` — Prometheus metrics endpoint configuration. See `metricsSchema`.
 * - `validation` — Request-body validation error formatting. See `validationSchema`.
 * - `upload` — File-upload handling and storage. See `uploadSchema`.
 * - `versioning` — API versioning: version list or object form. See
 *   `versioningObjectSchema`.
 * - `plugins` — Array of slingshot plugin instances. Typed as `unknown[]` to
 *   avoid circular imports; validated at runtime by the plugin loader.
 * - `eventBus` — Custom `SlingshotEventBus` implementation. Typed as `unknown`
 *   for the same reason. Defaults to `InProcessAdapter` when omitted.
 * - `secrets` — Secrets provider instance (e.g. `EnvSecretsProvider`). Typed
 *   as `unknown`; the framework resolves it via the secrets provider interface.
 */
export const appConfigSchema = z
  .object({
    routesDir: z.string().optional(),
    modelSchemas: z
      .union([z.string(), z.array(z.string()), modelSchemasObjectSchema.loose()])
      .optional(),
    meta: appSectionSchema.loose().optional(),
    security: securitySchema.loose().optional(),
    middleware: z.array(z.unknown()).optional(),
    db: dbSchema.loose().optional(),
    jobs: jobsSchema.loose().optional(),
    tenancy: tenancySchema.loose().optional(),
    logging: loggingSchema.loose().optional(),
    metrics: metricsSchema.loose().optional(),
    validation: validationSchema.loose().optional(),
    upload: uploadSchema.loose().optional(),
    ws: wsSchema.loose().optional(),
    versioning: z.union([versioningObjectSchema.loose(), z.array(z.string())]).optional(),
    plugins: z.array(z.unknown()).optional(),
    packages: z.array(z.unknown()).optional(),
    eventBus: z.unknown().optional(),
    kafkaConnectors: z.unknown().optional(),
    secrets: z.unknown().optional(),
    runtime: z.unknown().optional(),
    permissions: z
      .object({ adapter: z.enum(['sqlite', 'postgres', 'mongo', 'memory']) })
      .optional(),
  })
  .loose();

/**
 * Zod schema for `CreateServerConfig` — the full server configuration object.
 *
 * Extends {@link appConfigSchema} with fields that are only meaningful when
 * running a standalone Bun HTTP server: network binding (`port`, `hostname`,
 * `unix`), TLS termination, WebSocket and SSE endpoints, worker support, and
 * request-body size limits.
 *
 * @remarks
 * **Additional fields (beyond `appConfigSchema`):**
 * - `port` — TCP port the server binds to. Defaults to `3000`.
 * - `hostname` — Hostname or IP address the server binds to. Defaults to
 *   `"0.0.0.0"` (all interfaces). Use `"127.0.0.1"` for loopback-only.
 * - `unix` — Unix domain socket path. When provided, `port` and `hostname` are
 *   ignored. Mutually exclusive with `port`/`hostname`.
 * - `tls` — TLS termination options. See {@link tlsSchema}. When provided,
 *   the server listens on HTTPS without a reverse proxy.
 * - `workersDir` — Directory from which Bun worker scripts are loaded.
 * - `enableWorkers` — When `true`, workers in `workersDir` are started at
 *   server boot. Defaults to `false`.
 * - `ws` — WebSocket endpoint declarations. See `wsSchema`. Server-only.
 * - `sse` — Server-Sent Events endpoint declarations. See `sseSchema`. Server-only.
 * - `maxRequestBodySize` — Maximum allowed request body size in bytes. Requests
 *   exceeding this are rejected with 413 before the body is read. Passed
 *   directly to Bun's server options. Defaults to Bun's built-in default
 *   (128 MB).
 *
 * **Mutual exclusions:**
 * - `unix` and `port`/`hostname` are mutually exclusive. Supplying both results
 *   in `unix` taking precedence (Bun's own behaviour).
 */
export const serverConfigSchema = appConfigSchema
  .extend({
    port: z.number().optional(),
    hostname: z.string().optional(),
    unix: z.string().optional(),
    tls: tlsSchema.loose().optional(),
    workersDir: z.string().optional(),
    enableWorkers: z.boolean().optional(),
    ws: wsSchema.loose().optional(),
    sse: sseSchema.loose().optional(),
    maxRequestBodySize: z.number().optional(),
  })
  .loose();

/**
 * Extracts the set of known top-level keys from a Zod object schema.
 *
 * Used internally to build {@link APP_CONFIG_KEYS} and {@link SERVER_CONFIG_KEYS}
 * so that the unknown-key detection loop can compare config keys against what
 * the schema declares without running a full Zod parse.
 *
 * @param schema - A Zod object schema (`z.object(...)`).
 * @returns A `Set<string>` of the field names declared in the schema's shape.
 * @throws {Error} If `schema` is not a Zod object schema (i.e. its `_def.type`
 *   is not `"object"`). Indicates a programming error — only call this with
 *   schemas produced by `z.object(...)`.
 */
function keysOf(schema: z.ZodType): Set<string> {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (shape) {
    return new Set(Object.keys(shape));
  }
  throw new Error('[slingshot] keysOf() called on non-object schema');
}

/**
 * Registry mapping dot-notation config paths to their corresponding Zod schemas.
 *
 * Used by {@link collectNestedUnknownKeys} to look up the known-key set for any
 * nested config object. When a path exists in this map, the traversal checks
 * that object's keys against the schema's shape and warns (or throws) for
 * unknown keys.
 *
 * **To add a new nested section:**
 * 1. Create and export the section schema in `sections/`.
 * 2. Add an entry here using the dot-notation path as the key.
 *
 * Paths must match the actual key structure of the config object (e.g.
 * `"security.signing.presignedUrls"` matches `config.security.signing.presignedUrls`).
 */
const SCHEMA_MAP: Record<string, z.ZodType> = {
  meta: appSectionSchema,
  security: securitySchema,
  'security.cors': corsObjectSchema,
  'security.rateLimit': rateLimitSchema,
  'security.botProtection': botProtectionSchema,
  'security.signing': signingSchema,
  'security.signing.presignedUrls': signingPresignedUrlsSchema,
  'security.signing.requestSigning': signingRequestSigningSchema,
  'security.signing.sessionBinding': signingSessionBindingSchema,
  'security.captcha': captchaSchema,
  'security.csrf': csrfSchema,
  db: dbSchema,
  'db.redis': redisObjectSchema,
  jobs: jobsSchema,
  tenancy: tenancySchema,
  logging: loggingSchema,
  metrics: metricsSchema,
  validation: validationSchema,
  upload: uploadSchema,
  'upload.presignedUrls': uploadPresignedSchema,
  versioning: versioningObjectSchema,
  modelSchemas: modelSchemasObjectSchema,
  tls: tlsSchema,
  ws: wsSchema,
  sse: sseSchema,
};

/**
 * Pre-computed map from dot-notation config path to the set of known field
 * names at that path, derived from {@link SCHEMA_MAP}.
 *
 * Cached at module load time so that per-request (or per-startup) validation
 * does not need to re-extract schema shapes on every call.
 */
const NESTED_KNOWN_KEYS: Partial<Record<string, Set<string>>> = Object.fromEntries(
  Object.entries(SCHEMA_MAP).map(([path, schema]) => [path, keysOf(schema)]),
);

/** Known top-level keys for `CreateAppConfig`, derived from {@link appConfigSchema}. */
const APP_CONFIG_KEYS = keysOf(appConfigSchema);

/** Known top-level keys for `CreateServerConfig`, derived from {@link serverConfigSchema}. */
const SERVER_CONFIG_KEYS = keysOf(serverConfigSchema);

/**
 * Top-level keys whose values are opaque arrays or objects that the framework
 * does not introspect for unknown nested keys.
 *
 * `middleware` and `plugins` are arrays of arbitrary Hono/plugin instances.
 * `eventBus` is an opaque adapter object. Unknown-key detection is skipped for
 * these at the top level (`parentPath === ""`); they are still validated by the
 * Zod schema at the type level.
 */
const SKIP_NESTED_CHECK = Object.freeze(
  new Set(['middleware', 'plugins', 'eventBus', 'kafkaConnectors']),
);

/**
 * Result returned by {@link validateAppConfig} and {@link validateServerConfig}.
 *
 * `warnings` is empty when the config is fully clean. In development, warnings
 * are logged by the caller; in production, any warnings cause those functions
 * to throw instead of returning.
 */
export interface ConfigValidationResult {
  /** Warning messages for unknown config keys. Empty when the config is valid and clean. */
  warnings: string[];
}

export interface ConfigValidationOptions {
  /**
   * Whether production-mode strictness should be applied.
   *
   * When omitted, validation falls back to `process.env.NODE_ENV === "production"`.
   * Framework bootstrap should pass this explicitly so instance behavior is
   * determined at startup rather than ambient reads deep in the call stack.
   */
  isProd?: boolean;
}

/**
 * Validates a raw config object against the `CreateAppConfig` schema.
 *
 * Performs two passes:
 * 1. **Type validation** — Runs `appConfigSchema.safeParse(config)`. Any type
 *    mismatch or constraint violation throws immediately with a formatted error
 *    message listing every failing field.
 * 2. **Unknown-key detection** — Walks the config object recursively and
 *    compares keys against {@link SCHEMA_MAP}. Unknown keys are collected as
 *    warning strings. In production (`NODE_ENV === "production"`) warnings are
 *    escalated to a thrown error; in development they are returned to the
 *    caller for logging.
 *
 * @param config - Raw config object to validate, typically the value passed
 *   to `createApp()`.
 * @returns A {@link ConfigValidationResult} containing any unknown-key warnings.
 *   The result object is only returned when the config passes type validation.
 * @throws {Error} If type validation fails (always), or if unknown keys are
 *   detected in production (`NODE_ENV === "production"`).
 *
 * @example
 * ```ts
 * const { warnings } = validateAppConfig(rawConfig);
 * for (const w of warnings) console.warn(w);
 * ```
 */
export function validateAppConfig(
  config: Record<string, unknown>,
  options?: ConfigValidationOptions,
): ConfigValidationResult {
  return validateConfig(config, appConfigSchema, APP_CONFIG_KEYS, options);
}

/**
 * Validates a raw config object against the `CreateServerConfig` schema.
 *
 * Identical in behaviour to {@link validateAppConfig} but uses
 * {@link serverConfigSchema} which includes the additional server-only fields
 * (`port`, `hostname`, `unix`, `tls`, `ws`, `sse`, `workersDir`,
 * `enableWorkers`, `maxRequestBodySize`).
 *
 * @param config - Raw config object to validate, typically the value passed
 *   to `createServer()`.
 * @returns A {@link ConfigValidationResult} containing any unknown-key warnings.
 * @throws {Error} If type validation fails, or if unknown keys are detected in
 *   production.
 *
 * @example
 * ```ts
 * const { warnings } = validateServerConfig(rawConfig);
 * for (const w of warnings) console.warn(w);
 * ```
 */
export function validateServerConfig(
  config: Record<string, unknown>,
  options?: ConfigValidationOptions,
): ConfigValidationResult {
  return validateConfig(config, serverConfigSchema, SERVER_CONFIG_KEYS, options);
}

/**
 * Core implementation shared by {@link validateAppConfig} and
 * {@link validateServerConfig}.
 *
 * Runs Zod schema validation, then performs a recursive unknown-key walk using
 * {@link collectNestedUnknownKeys}. Escalates warnings to errors in production.
 *
 * @param config - Raw config object to validate.
 * @param schema - The Zod schema to validate against.
 * @param knownKeys - Pre-computed set of top-level keys declared by `schema`.
 * @returns A {@link ConfigValidationResult} with any unknown-key warnings.
 * @throws {Error} On type validation failure, or on unknown keys in production.
 */
function validateConfig(
  config: Record<string, unknown>,
  schema: z.ZodType,
  knownKeys: Set<string>,
  options?: ConfigValidationOptions,
): ConfigValidationResult {
  const result = schema.safeParse(config);

  if (!result.success) {
    const issues = result.error.issues
      .map(issue => {
        const path = issue.path.join('.');
        return path ? `  - ${path}: ${issue.message}` : `  - ${issue.message}`;
      })
      .join('\n');
    throw new Error(`[slingshot] Invalid config:\n${issues}`);
  }

  const warnings: string[] = [];
  for (const key of Object.keys(config)) {
    if (!knownKeys.has(key)) {
      warnings.push(`[slingshot] Unknown config key "${key}" — will be ignored. Check for typos.`);
    }
  }

  collectNestedUnknownKeys(config, '', warnings);

  const isProd = options?.isProd ?? process.env.NODE_ENV === 'production';
  if (warnings.length > 0 && isProd) {
    throw new Error(
      `[slingshot] Config validation failed in production:\n${warnings.join('\n')}\n` +
        `Fix the config keys above or remove them. Unknown keys are not allowed in production.`,
    );
  }

  return { warnings };
}

/**
 * Recursively walks a config object and collects warnings for any keys that are
 * not declared in the corresponding section schema.
 *
 * For each nested object value, the function looks up the current dot-notation
 * path in {@link NESTED_KNOWN_KEYS}. When a match is found, it compares the
 * nested object's keys against the known set and appends a warning for each
 * unknown key. It then recurses into the nested object to check deeper levels.
 *
 * Top-level keys listed in {@link SKIP_NESTED_CHECK} (`middleware`, `plugins`,
 * `eventBus`) are skipped because their values are opaque arrays/objects that
 * the framework does not own.
 *
 * @param obj - The object to inspect at this level of recursion.
 * @param parentPath - Dot-notation path of `obj` within the root config (empty
 *   string for the root call).
 * @param warnings - Mutable array to which warning strings are appended.
 */
function collectNestedUnknownKeys(
  obj: Record<string, unknown>,
  parentPath: string,
  warnings: string[],
): void {
  const nestedKnownKeys = NESTED_KNOWN_KEYS;

  for (const [key, value] of Object.entries(obj)) {
    if (SKIP_NESTED_CHECK.has(key) && parentPath === '') continue;

    const currentPath = parentPath ? `${parentPath}.${key}` : key;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const knownKeys = nestedKnownKeys[currentPath];
      if (knownKeys) {
        const nested = value as Record<string, unknown>;
        for (const nestedKey of Object.keys(nested)) {
          if (!knownKeys.has(nestedKey)) {
            warnings.push(
              `[slingshot] Unknown config key "${currentPath}.${nestedKey}" — will be ignored. Check for typos.`,
            );
          }
        }
        collectNestedUnknownKeys(nested, currentPath, warnings);
      }
    }
  }
}
