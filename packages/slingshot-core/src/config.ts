/**
 * Typed, env-validated app config — the canonical answer to "where does this
 * setting come from and what shape must it have?"
 *
 * Slingshot already has a secret-resolution layer ({@link SecretRepository})
 * that answers "where does this VALUE come from" (env var, AWS SSM, Vault,
 * etc.). `defineConfig` answers the orthogonal question "what SHAPE does this
 * app require, and where do those typed fields live in env." Most apps need
 * both; they're complementary.
 *
 * A config definition declares a `namespace` and a Zod `schema`. At app boot,
 * the framework reads `process.env` (or a custom source), maps each schema
 * field to a `NAMESPACE_FIELD` env var, validates the whole thing through Zod,
 * and caches the result. After boot, anywhere in your app, `cfg.get()` returns
 * the typed validated values — fail-fast at startup, not at the first request.
 *
 * @example
 * ```ts
 * // src/config/db.ts
 * import { defineConfig } from '@lastshotlabs/slingshot';
 * import { z } from 'zod';
 *
 * export const dbConfig = defineConfig({
 *   namespace: 'database',
 *   schema: z.object({
 *     host: z.string(),
 *     port: z.coerce.number().default(5432),
 *     poolSize: z.coerce.number().default(10),
 *   }),
 * });
 *
 * // app.config.ts
 * import { defineApp } from '@lastshotlabs/slingshot';
 * import { dbConfig } from './src/config/db';
 *
 * export default defineApp({
 *   configs: [dbConfig],
 *   // ...
 * });
 *
 * // Anywhere in your app, after boot:
 * const { host, port } = dbConfig.get();   // typed { host: string; port: number; poolSize: number }
 * ```
 *
 * Env var mapping for the example above (namespace `'database'`):
 * - `DATABASE_HOST`     → `host`
 * - `DATABASE_PORT`     → `port`
 * - `DATABASE_POOL_SIZE` → `poolSize` (camelCase → SCREAMING_SNAKE_CASE)
 */
import type { z } from 'zod';

/** Source for a config definition's values. */
export type ConfigSource = 'env';

/**
 * A typed config handle returned by {@link defineConfig}. Read with `get()`
 * after the framework has loaded the values at boot.
 *
 * @typeParam T - The Zod-inferred shape of the validated values.
 */
export interface ConfigDefinition<T> {
  /** Stable namespace used as the env-var prefix (e.g. `'database'` → `DATABASE_*`). */
  readonly namespace: string;
  /** Where the values are read from. Currently only `'env'` is supported. */
  readonly source: ConfigSource;
  /** The Zod schema declaring the validated shape. */
  readonly schema: z.ZodObject;
  /**
   * Read the typed validated values. Throws if called before the framework has
   * loaded this config — that means it wasn't passed to
   * `defineApp({ configs: [...] })`, or `get()` was called during module-load
   * time before `createApp()` resolved.
   */
  get(): T;
}

interface InternalConfigDefinition<T> extends ConfigDefinition<T> {
  /**
   * Internal: load values from the given env-like map and cache them. Called
   * once by the framework during boot. Throws on validation failure with a
   * structured message listing every missing or invalid field.
   */
  __load(env: Readonly<Record<string, string | undefined>>): T;
}

const LOAD_SYMBOL = Symbol.for('slingshot.config.load');

/**
 * Camelcase to SCREAMING_SNAKE_CASE for the env-var lookup key.
 *
 * @example
 * ```ts
 * fieldToEnvKey('poolSize')   // 'POOL_SIZE'
 * fieldToEnvKey('apiBaseUrl') // 'API_BASE_URL'
 * fieldToEnvKey('host')       // 'HOST'
 * ```
 */
function fieldToEnvKey(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function namespaceToPrefix(namespace: string): string {
  return namespace.replace(/[.-]/g, '_').toUpperCase() + '_';
}

/**
 * Declare a typed, validated config namespace.
 *
 * @param spec.namespace - Stable string used as the env-var prefix. Lowercase
 *   convention, dots and hyphens are mapped to underscores
 *   (`'feature.flags'` → `FEATURE_FLAGS_*`).
 * @param spec.schema - Zod schema describing the validated shape. Must be a
 *   {@link z.ZodObject} so the framework can introspect its keys for env-var
 *   lookup.
 * @param spec.source - Where to read values from. Currently only `'env'` is
 *   supported; `'secrets'` is reserved for a future extension that pulls from
 *   the framework's secret provider chain.
 * @returns A typed handle. Call `get()` after boot to read the validated values.
 *
 * @throws {Error} At call time only when the schema isn't a `ZodObject`. All
 *   other validation runs at app boot when the framework loads the definition.
 */
export function defineConfig<S extends z.ZodObject>(spec: {
  readonly namespace: string;
  readonly schema: S;
  readonly source?: ConfigSource;
}): ConfigDefinition<z.infer<S>> {
  const namespace = spec.namespace;
  const schema = spec.schema;
  const source: ConfigSource = spec.source ?? 'env';

  if (!('shape' in schema)) {
    throw new Error(
      `[slingshot] defineConfig({ namespace: '${namespace}' }) requires a ZodObject schema — ` +
        `got ${(schema as object).constructor.name}.`,
    );
  }

  let cached: z.infer<S> | undefined;

  type Inferred = z.infer<S>;
  const definition: InternalConfigDefinition<Inferred> = {
    namespace,
    source,
    schema,
    get(): Inferred {
      if (cached === undefined) {
        throw new Error(
          `[slingshot] Config '${namespace}' has not been loaded yet. ` +
            `Pass it to defineApp({ configs: [${namespace}Config] }) so the ` +
            `framework loads it at boot.`,
        );
      }
      return cached;
    },
    __load(env: Readonly<Record<string, string | undefined>>): Inferred {
      const prefix = namespaceToPrefix(namespace);
      const shape = (schema as { shape: Record<string, unknown> }).shape;
      const raw: Record<string, unknown> = {};
      for (const field of Object.keys(shape)) {
        const envKey = prefix + fieldToEnvKey(field);
        const value = env[envKey];
        if (value !== undefined) raw[field] = value;
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map(
            issue => `  ${prefix}${fieldToEnvKey(String(issue.path[0] ?? ''))}: ${issue.message}`,
          )
          .join('\n');
        throw new Error(`[slingshot] Config '${namespace}' validation failed:\n${issues}`);
      }
      cached = parsed.data as Inferred;
      return cached;
    },
  };

  // Stash the loader behind a Symbol so framework boot can reach it without
  // exposing it on the public type surface.
  (definition as unknown as Record<symbol, unknown>)[LOAD_SYMBOL] = definition.__load;

  return definition;
}

/**
 * Internal: load all registered configs at app boot. Throws on the first
 * validation failure with a structured per-field message.
 */
export function loadConfigs(
  configs: readonly ConfigDefinition<unknown>[],
  env: Readonly<Record<string, string | undefined>> = process.env as Readonly<
    Record<string, string | undefined>
  >,
): void {
  for (const config of configs) {
    const loader = (config as unknown as Record<symbol, unknown>)[LOAD_SYMBOL];
    if (typeof loader !== 'function') {
      throw new Error(
        `[slingshot] Config '${config.namespace}' was not produced by defineConfig() — ` +
          `it is missing the internal load hook.`,
      );
    }
    (loader as (env: Readonly<Record<string, string | undefined>>) => unknown)(env);
  }
}
