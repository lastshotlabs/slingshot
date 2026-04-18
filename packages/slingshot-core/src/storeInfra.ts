/**
 * Canonical store infrastructure contract shared across all slingshot packages.
 *
 * Plugin authors import these types from `@lastshotlabs/slingshot-core` to declare
 * repository factories without depending on framework or auth internals.
 *
 * The pattern:
 *   1. Declare `RepoFactories<YourRepo>` with one factory per StoreType
 *   2. Call `resolveRepo(factories, storeType, infra)` at startup
 *   3. The framework provides `StoreInfra` — your factory receives it
 *
 * ## Framework injection symbols
 *
 * The framework bootstrap (`createContextStoreInfra`) injects additional
 * capabilities onto `StoreInfra` via well-known Reflect symbols. Packages
 * that need these capabilities use `Reflect.get(infra, SYMBOL)` — they never
 * receive these as function arguments (CLAUDE.md Rule 16).
 *
 * `RESOLVE_ENTITY_FACTORIES` — injected by the bootstrap with the
 * `createEntityFactories` function. Allows `packages/slingshot-entity` to create
 * `RepoFactories<T>` from entity configs without importing from the root app.
 *
 * `RESOLVE_COMPOSITE_FACTORIES` — injected by the bootstrap with the
 * `createCompositeFactories` function. Used by the composite entity path in
 * `packages/slingshot-entity` to build multi-entity adapter sets.
 */
import type { Connection } from 'mongoose';
import type { Pool } from 'pg';
import type { RedisLike } from './redis';
import type { RuntimeSqliteDatabase } from './runtime';
import type { StoreType } from './storeType';

// ---------------------------------------------------------------------------
// Framework injection symbols
// ---------------------------------------------------------------------------

/**
 * Reflect symbol injected by the framework bootstrap onto `StoreInfra`.
 *
 * The injected value is `createEntityFactories` from the framework's
 * config-driven persistence layer. Use `Reflect.get(infra, RESOLVE_ENTITY_FACTORIES)`
 * inside a `buildAdapter` closure to create `RepoFactories<T>` from an entity
 * config without a direct import from the root app.
 *
 * This is the DI mechanism for manifest-driven entity factory creation.
 * See CLAUDE.md Rule 16.
 */
export const RESOLVE_ENTITY_FACTORIES: symbol = Symbol.for('slingshot.resolveEntityFactories');

/**
 * Reflect symbol injected by the framework bootstrap onto `StoreInfra`.
 *
 * The injected value is `createCompositeFactories` from the framework's
 * config-driven persistence layer. Use `Reflect.get(infra, RESOLVE_COMPOSITE_FACTORIES)`
 * inside a composite `buildAdapter` closure to create `RepoFactories<T>` for a
 * multi-entity composite without a direct import from the root app.
 *
 * See CLAUDE.md Rule 16.
 */
export const RESOLVE_COMPOSITE_FACTORIES: symbol = Symbol.for(
  'slingshot.resolveCompositeFactories',
);

/**
 * Reflect symbol injected onto `StoreInfra` by the entity plugin during `setupPost`.
 *
 * The injected value is `(entityStorageName: string) => AsyncIterable<Record<string, unknown>> | null`.
 *
 * Used by the search admin rebuild route to obtain a full data scan for a given
 * entity without a direct import from the entity plugin. Returns `null` when no
 * scan source is registered for the entity (entity plugin absent, or entity has
 * no search config).
 *
 * See CLAUDE.md Rule 16.
 */
export const RESOLVE_REINDEX_SOURCE: symbol = Symbol.for('slingshot.resolveReindexSource');

/**
 * Postgres connection bundle passed through {@link StoreInfra} to repository factories.
 *
 * The concrete implementation (`DrizzlePostgresDb`) lives in `@lastshotlabs/slingshot-postgres`
 * and satisfies this interface at runtime. `db` is typed as `unknown` in core to avoid a
 * hard dependency on drizzle-orm — import from `slingshot-postgres` when you need the full
 * `NodePgDatabase` type for query building.
 *
 * @remarks
 * Always obtain this bundle via `infra.getPostgres()` inside a repository factory.
 * Do not call `infra.getPostgres()` at module load time — the Postgres pool is initialised
 * lazily and may not be ready until the framework bootstrap completes.
 *
 * @example
 * ```ts
 * import type { PostgresBundle, StoreInfra } from '@lastshotlabs/slingshot-core';
 * import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
 *
 * function createPostgresMyRepo(infra: StoreInfra): MyRepo {
 *   const { pool, db } = infra.getPostgres() as PostgresBundle & { db: NodePgDatabase };
 *   return new MyPostgresRepo(pool, db);
 * }
 * ```
 */
export interface PostgresBundle {
  /** The raw `pg` connection pool. Use for raw queries or pool health checks. */
  readonly pool: Pool;
  /**
   * The Drizzle ORM database instance.
   * Typed as `unknown` in core — cast to `NodePgDatabase` from `slingshot-postgres` for full type safety.
   */
  readonly db: unknown;
}

/**
 * Infrastructure accessor bundle passed to every repository factory at startup.
 *
 * `StoreInfra` provides lazy accessor functions for each backing store so that a
 * repository factory can reach the correct client without depending on the concrete
 * initialisation path. The framework constructs a single `StoreInfra` per app instance
 * and passes it to every factory invocation via {@link resolveRepo} or {@link resolveRepoAsync}.
 *
 * @remarks
 * All accessor methods throw if the corresponding store is not configured for this app
 * instance. Always call only the accessor that matches the active `StoreType` — never
 * call `infra.getRedis()` inside a Postgres factory, for example.
 * Do not call any accessor at module load time. Accessors are safe to call only from
 * inside a repository factory function, after the framework bootstrap has completed.
 * `appName` is available for namespacing store keys, table prefixes, or index names.
 *
 * @example
 * ```ts
 * import type { StoreInfra } from '@lastshotlabs/slingshot-core';
 *
 * function createRedisMyRepo(infra: StoreInfra): MyRepo {
 *   const redis = infra.getRedis(); // safe — called inside factory, not at module scope
 *   return new MyRedisRepo(redis, infra.appName);
 * }
 * ```
 */
export interface StoreInfra {
  /** The application name — used as a namespace prefix for store keys/tables. */
  readonly appName: string;
  /**
   * Returns the Redis client for this app instance.
   * @throws If Redis is not configured for this app.
   */
  readonly getRedis: () => RedisLike;
  /**
   * Returns the Mongoose connection and the `mongoose` module for this app instance.
   * @throws If MongoDB is not configured for this app.
   */
  readonly getMongo: () => { conn: Connection; mg: typeof import('mongoose') };
  /**
   * Returns the SQLite database handle for this app instance.
   * @throws If SQLite is not configured for this app.
   */
  readonly getSqliteDb: () => RuntimeSqliteDatabase;
  /**
   * Returns the Postgres pool and Drizzle db instance for this app instance.
   * @throws If Postgres is not configured for this app.
   */
  readonly getPostgres: () => PostgresBundle;
}

/**
 * A record of repository factories keyed by `StoreType`.
 *
 * Every key (`redis`, `mongo`, `sqlite`, `memory`, `postgres`) must be present.
 * At runtime, only the factory matching the configured store type is called.
 * The others are never invoked and may throw if their infra is unavailable.
 *
 * @template T - The repository interface the factories return.
 *
 * @example
 * ```ts
 * import type { RepoFactories, StoreInfra } from '@lastshotlabs/slingshot-core';
 *
 * export const myRepoFactories: RepoFactories<MyRepo> = {
 *   memory: () => createMemoryMyRepo(),
 *   sqlite: (infra) => createSqliteMyRepo(infra.getSqliteDb()),
 *   redis:  (infra) => createRedisMyRepo(infra.getRedis()),
 *   mongo:  (infra) => createMongoMyRepo(infra.getMongo()),
 *   postgres: (infra) => createPostgresMyRepo(infra.getPostgres()),
 * };
 * ```
 */
export type RepoFactories<T> = Record<StoreType, (infra: StoreInfra) => T>;

/**
 * Like {@link RepoFactories}`<T>` but the `memory` factory accepts an optional infra
 * argument, enabling direct `.memory()` calls in unit tests without constructing a real
 * `StoreInfra` instance.
 *
 * @template T - The repository interface the factories return.
 *
 * @remarks
 * `TestableRepoFactories<T>` is structurally assignable to `RepoFactories<T>` because
 * a function that accepts an optional parameter also satisfies a type that requires it.
 * This means you can pass a `TestableRepoFactories<T>` directly to {@link resolveRepo}
 * without a cast.
 * In test code, call `.memory()` with no arguments to get a fresh in-memory instance.
 * Each call returns an independent instance — no shared state between calls.
 *
 * @example
 * ```ts
 * import type { TestableRepoFactories } from '@lastshotlabs/slingshot-core';
 *
 * export const myRepoFactories: TestableRepoFactories<MyRepo> = {
 *   memory:   () => createMemoryMyRepo(),           // no infra needed in tests
 *   sqlite:   (infra) => createSqliteMyRepo(infra.getSqliteDb()),
 *   redis:    (infra) => createRedisMyRepo(infra.getRedis()),
 *   mongo:    (infra) => createMongoMyRepo(infra.getMongo()),
 *   postgres: (infra) => createPostgresMyRepo(infra.getPostgres()),
 * };
 *
 * // In tests:
 * const repo = myRepoFactories.memory(); // no infra required
 * ```
 */
export type TestableRepoFactories<T> = Omit<RepoFactories<T>, 'memory'> & {
  memory: (infra?: StoreInfra) => T;
};

/**
 * Resolve a repository instance from a `RepoFactories` map for the configured store type.
 *
 * Dispatches to the correct factory based on `storeType`, passing `infra` as the
 * dependency bundle. Throws if the store type is not present in the factory map.
 *
 * @param factories - All factory implementations keyed by `StoreType`.
 * @param storeType - The active store type from the app config.
 * @param infra - The infrastructure accessor bundle.
 * @returns The repository instance produced by the selected factory.
 * @throws If `storeType` is not a key in `factories`.
 *
 * @example
 * ```ts
 * import { resolveRepo } from '@lastshotlabs/slingshot-core';
 *
 * const repo = resolveRepo(myRepoFactories, config.store, infra);
 * ```
 */
export function resolveRepo<T>(
  factories: RepoFactories<T>,
  storeType: StoreType,
  infra: StoreInfra,
): T {
  return factories[storeType](infra);
}

/**
 * Like `resolveRepo` but supports factories that return a `Promise`.
 *
 * Use this when the selected adapter requires async initialization (e.g., running
 * database migrations or establishing a persistent connection on first use).
 *
 * @param factories - All factory implementations keyed by `StoreType`. Each factory may
 *   return `T` or `Promise<T>`.
 * @param storeType - The active store type from the app config.
 * @param infra - The infrastructure accessor bundle.
 * @returns A promise that resolves to the repository instance.
 * @throws If `storeType` is not a key in `factories`.
 *
 * @example
 * ```ts
 * import { resolveRepoAsync } from '@lastshotlabs/slingshot-core';
 *
 * const repo = await resolveRepoAsync(myRepoFactories, config.store, infra);
 * ```
 */
export async function resolveRepoAsync<T>(
  factories: Record<StoreType, (infra: StoreInfra) => T | Promise<T>>,
  storeType: StoreType,
  infra: StoreInfra,
): Promise<T> {
  return factories[storeType](infra);
}
