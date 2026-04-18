/**
 * Auth boundary adapter assembly.
 *
 * Resolves the default rate limiter, fingerprint builder, and cache adapters
 * for a single app instance. Plugins may still override these defaults
 * through the registrar during setupMiddleware.
 */
import { boundaryCacheFactories } from '@framework/boundaryAdapters/cacheFactories';
import type { Connection } from 'mongoose';
import type { Pool } from 'pg';
import {
  type CacheAdapter,
  type CoreRegistrar,
  type FingerprintBuilder,
  type RateLimitAdapter,
  type RuntimeSqliteDatabase,
  createDefaultFingerprintBuilder,
  createMemoryRateLimitAdapter,
} from '@lastshotlabs/slingshot-core';
import type { StoreType } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Infrastructure availability context passed to {@link resolveBoundaryAdapters}.
 *
 * Each field reflects the connection state resolved during `createApp()` startup.
 * Adapters are only registered for backends that are actively connected — the
 * framework does not attempt to use a backend that is disabled or unavailable.
 */
export interface RegisterBoundaryAdaptersOptions {
  /** Whether Redis is connected and available. */
  redisEnabled: boolean;
  /** Mongo connection mode — `false` means no Mongo is configured. */
  mongoMode: 'single' | 'separate' | false;
  /** Live ioredis client handle, or `null` when Redis is disabled. */
  redis: import('ioredis').default | null;
  /** App Mongo connection, or `null` when Mongo is disabled. */
  appConnection: Connection | null;
  /** SQLite database handle, or `null` when SQLite is not configured. */
  sqliteDb: RuntimeSqliteDatabase | null;
  /** Postgres connection pool, or `null` when Postgres is not configured. */
  postgresPool: Pool | null;
}

/**
 * Resolved boundary adapters for a single app instance.
 *
 * Produced by {@link resolveBoundaryAdapters} and consumed by
 * {@link applyBoundaryAdapters}. The snapshot is immutable — adapters are
 * resolved once at startup and never replaced during the app's lifetime.
 *
 * - `rateLimitAdapter` — in-memory rate limiter (always present; Redis-backed
 *   adapters may be substituted in a future release).
 * - `fingerprintBuilder` — default fingerprint builder using IP + User-Agent.
 * - `cacheAdapters` — map of `StoreType → CacheAdapter` for every backend
 *   that is connected at startup (always includes `'memory'`).
 */
export interface BoundaryAdaptersSnapshot {
  readonly rateLimitAdapter: RateLimitAdapter;
  readonly fingerprintBuilder: FingerprintBuilder;
  readonly cacheAdapters: ReadonlyMap<StoreType, CacheAdapter>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function resolveOptionalCacheAdapters(
  options: RegisterBoundaryAdaptersOptions,
): Promise<ReadonlyMap<StoreType, CacheAdapter>> {
  const redisClient = options.redisEnabled && options.redis ? options.redis : null;
  const context = {
    redis: redisClient,
    mongo: options.mongoMode !== false ? options.appConnection : null,
    sqliteDb: options.sqliteDb,
    postgresPool: options.postgresPool ?? null,
  };

  const stores: StoreType[] = ['memory'];
  if (context.redis) stores.push('redis');
  if (context.sqliteDb) stores.push('sqlite');
  if (context.mongo) stores.push('mongo');
  if (context.postgresPool) stores.push('postgres');

  const resolved = await Promise.all(
    stores.map(async store => [store, await boundaryCacheFactories[store](context)] as const),
  );

  return new Map(resolved);
}

/**
 * Resolve boundary adapters from the current infrastructure availability.
 *
 * Constructs the full {@link BoundaryAdaptersSnapshot} by:
 * 1. Creating the default in-memory rate-limit adapter.
 * 2. Creating the default fingerprint builder (IP + User-Agent hashing).
 * 3. Resolving cache adapters for every connected backend (memory always included;
 *    Redis, SQLite, and Mongo are added when the respective connections are live).
 *
 * All adapter factories are called concurrently via `Promise.all`. Errors from
 * individual factory calls propagate and abort startup.
 *
 * This function is called once per `createApp()` invocation during the
 * `setupMiddleware` bootstrap phase.
 *
 * @param options - Current infrastructure state resolved at startup.
 * @returns A frozen-by-convention `BoundaryAdaptersSnapshot`.
 *
 * @example
 * ```ts
 * const snapshot = await resolveBoundaryAdapters({
 *   redisEnabled: true,
 *   mongoMode: 'single',
 *   redis: redisClient,
 *   appConnection: mongoConn,
 *   sqliteDb: null,
 * });
 * applyBoundaryAdapters(registrar, snapshot);
 * ```
 */
export async function resolveBoundaryAdapters(
  options: RegisterBoundaryAdaptersOptions,
): Promise<BoundaryAdaptersSnapshot> {
  return {
    rateLimitAdapter: createMemoryRateLimitAdapter(),
    fingerprintBuilder: createDefaultFingerprintBuilder(),
    cacheAdapters: await resolveOptionalCacheAdapters(options),
  };
}

/**
 * Apply a resolved {@link BoundaryAdaptersSnapshot} to a `CoreRegistrar`.
 *
 * Registers the rate-limit adapter, fingerprint builder, and all cache adapters
 * onto the registrar supplied by the framework's `setupMiddleware` phase. Extracted
 * from {@link registerBoundaryAdapters} to allow callers that pre-resolve the
 * snapshot (e.g., for testing) to apply it independently.
 *
 * @param registrar - The `CoreRegistrar` instance provided by the framework during
 *   `setupMiddleware`. Typically accessed as the third argument of the plugin callback.
 * @param boundaryAdapters - Snapshot produced by {@link resolveBoundaryAdapters}.
 */
export function applyBoundaryAdapters(
  registrar: CoreRegistrar,
  boundaryAdapters: BoundaryAdaptersSnapshot,
): void {
  registrar.setRateLimitAdapter(boundaryAdapters.rateLimitAdapter);
  registrar.setFingerprintBuilder(boundaryAdapters.fingerprintBuilder);
  for (const [store, adapter] of boundaryAdapters.cacheAdapters) {
    registrar.addCacheAdapter(store, adapter);
  }
}

/**
 * Convenience wrapper: resolve and apply boundary adapters in a single call.
 *
 * Combines {@link resolveBoundaryAdapters} and {@link applyBoundaryAdapters}.
 * This is the primary entry point used by `createApp()` during the
 * `setupMiddleware` bootstrap phase. Use the two-step variant when you need to
 * inspect or cache the snapshot before applying it.
 *
 * @param registrar - The `CoreRegistrar` instance for the current app.
 * @param options - Infrastructure availability state.
 * @returns Resolves once all adapters have been registered on the registrar.
 *
 * @example
 * ```ts
 * // Inside createApp() bootstrap — called automatically:
 * await registerBoundaryAdapters(registrar, {
 *   redisEnabled: !!redis,
 *   mongoMode: config.mongo?.mode ?? false,
 *   redis,
 *   appConnection: mongoConn,
 *   sqliteDb,
 * });
 * ```
 */
export async function registerBoundaryAdapters(
  registrar: CoreRegistrar,
  options: RegisterBoundaryAdaptersOptions,
): Promise<void> {
  applyBoundaryAdapters(registrar, await resolveBoundaryAdapters(options));
}
