import type { Connection } from 'mongoose';
import type { Pool } from 'pg';
import {
  type CacheAdapter,
  type RuntimeSqliteDatabase,
  createMemoryCacheAdapter,
} from '@lastshotlabs/slingshot-core';
import type { StoreType } from '@lastshotlabs/slingshot-core';

/**
 * Infrastructure handles available to boundary cache factory functions.
 *
 * Each field reflects the connection state resolved during startup. Factories
 * check for `null` and throw a descriptive error when the required backend is
 * unavailable.
 */
export interface BoundaryCacheFactoryContext {
  readonly redis: import('ioredis').default | null;
  readonly mongo: Connection | null;
  readonly sqliteDb: RuntimeSqliteDatabase | null;
  /** Postgres connection pool, or `null` when Postgres is not configured. */
  readonly postgresPool: Pool | null;
}

/**
 * A map from every supported `StoreType` to a factory function that creates the
 * corresponding `CacheAdapter` given a `BoundaryCacheFactoryContext`.
 *
 * Used by the framework bootstrap to instantiate the correct cache backend for
 * the app's configured store type without hard-coding the selection logic at
 * the call site.  See {@link boundaryCacheFactories} for the concrete implementation.
 */
export type BoundaryCacheFactories = Record<
  StoreType,
  (context: BoundaryCacheFactoryContext) => Promise<CacheAdapter> | CacheAdapter
>;

/**
 * Create a `CacheAdapter` backed by a Redis connection.
 *
 * Uses `SET`/`GET`/`DEL` for individual keys and a cursor-based `SCAN` loop
 * for pattern deletion (`delPattern`).
 *
 * @param redisClient - An active `ioredis` client instance.
 * @returns A synchronously ready `CacheAdapter` (`isReady()` always returns `true`).
 */
export function createRedisBoundaryCacheAdapter(
  redisClient: import('ioredis').default,
): CacheAdapter {
  return {
    name: 'redis',
    async get(key: string) {
      return redisClient.get(key);
    },
    async set(key: string, value: string, ttl?: number) {
      if (ttl) {
        await redisClient.setex(key, ttl, value);
        return;
      }
      await redisClient.set(key, value);
    },
    async del(key: string) {
      await redisClient.del(key);
    },
    async delPattern(pattern: string) {
      let cursor = '0';
      do {
        const [next, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        if (keys.length > 0) {
          await redisClient.del(...keys);
        }
      } while (cursor !== '0');
    },
    isReady() {
      return true;
    },
  };
}

/**
 * Create a `CacheAdapter` backed by a SQLite database.
 *
 * Delegates to `createSqliteCacheAdapter` from `@auth/lib/cache` which
 * manages the cache table schema and TTL enforcement.
 *
 * @param sqliteDb - An open `RuntimeSqliteDatabase` instance.
 * @returns A promise that resolves to a `CacheAdapter` backed by SQLite.
 */
export async function createSqliteBoundaryCacheAdapter(
  sqliteDb: RuntimeSqliteDatabase,
): Promise<CacheAdapter> {
  const { createSqliteCacheAdapter } = await import('@auth/lib/cache');
  return createSqliteCacheAdapter(sqliteDb);
}

/**
 * Create a `CacheAdapter` backed by a MongoDB connection.
 *
 * Stores cache entries in the `cache_entries` collection via a Mongoose model.
 * TTL expiry is enforced by a MongoDB TTL index on the `expiresAt` field
 * (MongoDB's background reaper, not application-side TTL).  Pattern deletion
 * converts glob patterns to anchored regular expressions.
 *
 * `isReady()` reflects the Mongoose connection `readyState` (1 = connected).
 *
 * @param appConnection - An open Mongoose `Connection` for the application database.
 * @returns A promise that resolves to a `CacheAdapter` backed by MongoDB.
 */
export async function createMongoBoundaryCacheAdapter(
  appConnection: Connection,
): Promise<CacheAdapter> {
  const { getCacheModel } = await import('@framework/middleware/cacheResponse');
  const cacheModel = getCacheModel(appConnection);

  return {
    name: 'mongo',
    async get(key: string) {
      const doc = await cacheModel.findOne({ key }, 'value').lean();
      return doc ? doc.value : null;
    },
    async set(key: string, value: string, ttl?: number) {
      const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : undefined;
      await cacheModel.updateOne(
        { key },
        { $set: { value, ...(expiresAt ? { expiresAt } : {}) } },
        { upsert: true },
      );
    },
    async del(key: string) {
      await cacheModel.deleteOne({ key });
    },
    async delPattern(pattern: string) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
      await cacheModel.deleteMany({ key: regex });
    },
    isReady() {
      return (appConnection.readyState as number) === 1;
    },
  };
}

/**
 * Default {@link BoundaryCacheFactories} used by the framework bootstrap.
 *
 * Dispatches to the correct `CacheAdapter` factory based on the resolved store
 * type.  Each factory validates that the required connection is available in
 * the context and throws a descriptive error if not, enabling early detection
 * of misconfiguration at startup rather than at request time.
 *
 * Store coverage:
 * - `"memory"` — in-process `Map` (development/testing only).
 * - `"redis"` — ioredis-backed adapter.
 * - `"sqlite"` — SQLite-backed adapter via `@auth/lib/cache`.
 * - `"mongo"` — MongoDB-backed adapter with TTL index.
 * - `"postgres"` — native Postgres-backed adapter with TTL and background cleanup.
 */
export const boundaryCacheFactories: BoundaryCacheFactories = {
  memory: () => createMemoryCacheAdapter(),
  redis: context => {
    if (!context.redis) {
      throw new Error(
        '[framework/boundaryAdapters] Redis cache adapter requested without a Redis client',
      );
    }
    return createRedisBoundaryCacheAdapter(context.redis);
  },
  sqlite: context => {
    if (!context.sqliteDb) {
      throw new Error(
        '[framework/boundaryAdapters] SQLite cache adapter requested without a SQLite database',
      );
    }
    return createSqliteBoundaryCacheAdapter(context.sqliteDb);
  },
  mongo: context => {
    if (!context.mongo) {
      throw new Error(
        '[framework/boundaryAdapters] Mongo cache adapter requested without a Mongo connection',
      );
    }
    return createMongoBoundaryCacheAdapter(context.mongo);
  },
  postgres: async context => {
    if (!context.postgresPool) {
      throw new Error(
        '[framework/boundaryAdapters] Postgres cache adapter requested without a Postgres pool',
      );
    }
    const { createPostgresCacheAdapter } = await import('./postgresCacheAdapter');
    return createPostgresCacheAdapter(context.postgresPool);
  },
};
