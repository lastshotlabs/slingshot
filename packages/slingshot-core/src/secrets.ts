/**
 * Secret repository contracts — read-only abstraction for resolving
 * credentials, API keys, and signing secrets from any backing store.
 *
 * Resolved at startup BEFORE database connections are established.
 * Implementations must be self-contained (no DB dependencies).
 */

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

/**
 * The backing store type for secret resolution.
 *
 * - `'env'`  — reads from process environment variables (always available, zero config)
 * - `'ssm'`  — reads from AWS SSM Parameter Store (production, supports rotation)
 * - `'file'` — reads from a local file (e.g. a `.env.secrets` file)
 */
export type SecretStoreType = 'env' | 'ssm' | 'file';

/**
 * Read-only secret repository. Resolved at startup before any DB connections.
 * Implementations must be self-contained (no DB dependencies).
 *
 * @remarks
 * Providers that support batch loading (e.g., SSM `GetParametersByPath`) should
 * prefetch all secrets in `initialize()` to avoid N+1 latency during bootstrap.
 *
 * @example
 * ```ts
 * import type { SecretRepository } from '@lastshotlabs/slingshot-core';
 *
 * // Access a secret at runtime:
 * const dbPassword = await ctx.secrets.get('DB_PASSWORD');
 * ```
 */
export interface SecretRepository {
  readonly name: string;

  /** Get a single secret by path/key. Returns null if not found. */
  get(key: string): Promise<string | null>;

  /**
   * Get multiple secrets by key list in a single call.
   *
   * @remarks
   * Missing keys are silently omitted from the returned map — the map will only contain
   * entries for keys that were found in the backing store. Callers that need to detect
   * absent keys must compare the input `keys` array against the returned map's keys.
   * No error is thrown for missing keys; use `get()` then check for `null` if you need
   * per-key absence detection.
   */
  getMany(keys: string[]): Promise<ReadonlyMap<string, string>>;

  /**
   * Eagerly load all secrets (called once at startup before DB connections).
   *
   * @remarks
   * **When called:** the framework calls `initialize()` during bootstrap, before any DB
   * connection is established and before plugin `setupMiddleware` runs. Implementations
   * that support batch loading (e.g., SSM `GetParametersByPath`) should prefetch all
   * secrets here to avoid N+1 latency during subsequent `get()` / `getMany()` calls.
   *
   * **Whether mandatory:** `initialize()` is optional (marked `?`). Implementations that
   * resolve secrets lazily on each `get()` call (e.g., the `env` provider) may omit it
   * entirely. The framework checks for its presence before calling — it is never called
   * on an implementation that does not define it.
   */
  initialize?(): Promise<void>;

  /**
   * Refresh cached secrets from the backing store.
   * Called on rotation events or periodic refresh. No-op for env provider.
   */
  refresh?(): Promise<void>;

  /** Release resources (close connections, clear caches). */
  destroy?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Schema types — typed secret declarations
// ---------------------------------------------------------------------------

/**
 * A single secret declaration within a `SecretSchema`.
 *
 * `path` is the key or parameter path used to look up the secret in the backing store.
 * Set `required: false` plus a `default` to make the secret optional with a fallback value.
 *
 * @example
 * ```ts
 * const schema = {
 *   DB_PASSWORD:    { path: '/app/prod/db/password' },
 *   ANALYTICS_KEY:  { path: '/app/prod/analytics/key', required: false, default: '' },
 * };
 * ```
 */
export interface SecretDefinition {
  /** The path/key in the secret store (e.g., '/app/prod/db/password' or 'MONGO_PASSWORD') */
  path: string;
  /**
   * Whether the bootstrap process should fail if this secret is missing.
   *
   * @remarks
   * Default: `true` (omitting `required` is equivalent to `required: true`).
   * When `false`, a missing secret does not cause a startup error — the resolved value
   * will be `undefined` (or the `default` value if specified). Use `required: false`
   * for optional integrations (e.g., an analytics API key that degrades gracefully when
   * absent).
   */
  required?: boolean;
  /**
   * Fallback value used when the secret is not found in the backing store.
   *
   * @remarks
   * Only used when `required: false`. If `required` is `true` (or omitted) and the secret
   * is missing, bootstrap fails regardless of whether `default` is set.
   * An empty string `''` is a valid default and is distinct from `undefined`.
   */
  default?: string;
}

/**
 * A record of named secret declarations, keyed by the property name that will appear
 * on the resolved secrets object.
 *
 * @example
 * ```ts
 * const mySecretSchema: SecretSchema = {
 *   dbPassword:   { path: 'DB_PASSWORD' },
 *   jwtSecret:    { path: 'JWT_SECRET' },
 *   analyticsKey: { path: 'ANALYTICS_KEY', required: false, default: '' },
 * };
 * ```
 */
export type SecretSchema = Record<string, SecretDefinition>;

/**
 * The typed result of resolving a `SecretSchema` against a `SecretRepository`.
 *
 * Required secrets (`required` is `true` or omitted) produce `string` values.
 * Optional secrets (`required: false`) produce `string | undefined`.
 * The resolved object is `Readonly` and frozen — never mutate it.
 *
 * @example
 * ```ts
 * import type { ResolvedSecrets } from '@lastshotlabs/slingshot-core';
 *
 * const schema = {
 *   dbPassword:   { path: 'DB_PASSWORD' },
 *   optionalKey:  { path: 'OPTIONAL_KEY', required: false },
 * } as const;
 *
 * type MySecrets = ResolvedSecrets<typeof schema>;
 * // { readonly dbPassword: string; readonly optionalKey: string | undefined }
 * ```
 */
export type ResolvedSecrets<S extends SecretSchema> = {
  readonly [K in keyof S]: S[K] extends { required: false } ? string | undefined : string;
};
