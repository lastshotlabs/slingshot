import type { CoreRegistrar } from '../coreContracts';
import type { DataEncryptionKey } from '../crypto';
import type { EntityRegistry } from '../entityRegistry';
import type { RuntimePassword } from '../runtime';
import type { SigningConfig } from '../signing';
import type { StoreInfra } from '../storeInfra';
import type { StoreType } from '../storeType';

/**
 * Resolved store selections — which backing store each framework subsystem uses.
 *
 * Defined here (not in framework internals) so plugins can reference the type
 * without importing from the framework's private modules.
 */
export interface ResolvedStores {
  /** Backing store for session data (tokens, refresh tokens). */
  sessions: StoreType;
  /** Backing store for OAuth state parameters (PKCE, nonces). */
  oauthState: StoreType;
  /** Backing store for response and application caching. */
  cache: StoreType;
  /** Backing store for user/auth records. */
  authStore: StoreType;
  /** Filesystem path to the SQLite database file, or `undefined` when SQLite is not used. */
  sqlite: string | undefined;
}

/**
 * Resolved framework configuration passed to plugin lifecycle hooks.
 *
 * Plugins receive this object in all four lifecycle methods (`setupMiddleware`, `setupRoutes`,
 * `setupPost`, `setup`). It provides resolved config values and infrastructure handles
 * needed to initialise plugin state without depending on `SlingshotContext` directly.
 *
 * @remarks
 * Extracted from `SlingshotContext` to break the `SlingshotContext ↔ SlingshotPlugin` type cycle —
 * this file has no dependency on either. Plugins should treat this object as read-only.
 */
export interface SlingshotFrameworkConfig {
  /** Which backing store each subsystem is configured to use. */
  resolvedStores: ResolvedStores;
  /** Resolved framework logging policy shared with plugins. */
  logging: {
    /** Whether the HTTP request logger middleware is mounted. */
    enabled: boolean;
    /** Whether non-request diagnostic console logging is enabled. */
    verbose: boolean;
    /** Whether auth trace logging is enabled. */
    authTrace: boolean;
    /** Whether non-fatal audit-log provider warnings are emitted. */
    auditWarnings: boolean;
  };
  /** CORS configuration (allowed origins for cross-origin requests). */
  security: {
    cors: string | readonly string[];
    csrf?: {
      exemptPaths?: readonly string[];
      disabled?: boolean;
    };
  };
  /** Signing/HMAC configuration, or `null` if not configured. */
  signing: SigningConfig | null;
  /** Active data encryption keys for field-level encryption. Empty array when not configured. */
  dataEncryptionKeys: readonly DataEncryptionKey[];
  /** The ioredis/Redis client instance, or `undefined` when Redis is not configured. */
  redis: unknown;
  /**
   * Mongoose connection handles (separate auth and app connections),
   * or `undefined` when Mongo is not configured.
   */
  mongo: { auth: unknown; app: unknown } | undefined;
  /** CAPTCHA provider configuration, or `null` when not configured. */
  captcha: unknown;
  /**
   * Trusted proxy depth for IP extraction.
   * `false` = no proxy trust (use socket IP); number N = trust N upstream proxies.
   */
  trustProxy: false | number;
  /**
   * The mutable registrar for auth-boundary dependencies.
   *
   * @remarks
   * `registrar` is intentionally mutable during the plugin `setupPost` phase — each
   * plugin calls `registrar.set*` and `registrar.add*` to register its user resolver,
   * rate limit adapter, cache adapters, and email templates. After all `setupPost`
   * hooks have run, `createApp()` calls `drain()` on the backing `createCoreRegistrar()`
   * pair and snapshots the collected values immutably into `SlingshotContext`.
   *
   * Do NOT call `registrar` methods outside of `setupPost`. Reading from
   * `SlingshotContext.*` (e.g. `ctx.userResolver`) is correct after bootstrap completes;
   * writing goes through `registrar` only during the setup lifecycle.
   */
  registrar: CoreRegistrar;
  /**
   * Per-app entity registry — all entities registered by plugins for this app instance.
   *
   * @remarks
   * Plugins call `entityRegistry.register(entityConfig)` during `setupPost` to make
   * their entities discoverable by search indexing, admin UIs, and schema generators.
   * Registration is only valid during the `setupPost` phase — entities registered after
   * `createApp()` resolves will not be visible to infrastructure that reads the registry
   * at startup (e.g. the search plugin's `ensureConfigEntity` sweep).
   *
   * The registry is instance-scoped: each `createApp()` call receives its own
   * `EntityRegistry`. Never share a registry across app instances.
   */
  entityRegistry: EntityRegistry;
  /** Runtime password hasher/verifier — used by the auth and M2M packages. */
  password: RuntimePassword;
  /** SQLite database opener — used by auth and other packages that need SQLite. */
  sqlite?: { open(path: string): import('../runtime').RuntimeSqliteDatabase };
  /**
   * Store infrastructure for resolving plugin-owned persistence adapters.
   *
   * Plugins call `resolveRepo(factories, storeType, storeInfra)` during `setupRoutes`
   * or `setupPost` to create their backing adapters from the active backend connections
   * (Redis, Mongo, SQLite, Postgres). This is the typed, direct alternative to the
   * previous pattern of casting `registrar` to `StoreInfra`.
   */
  storeInfra: StoreInfra;
}
