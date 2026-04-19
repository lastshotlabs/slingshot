 
import { DEFAULT_MAX_ENTRIES, evictOldest } from '@lastshotlabs/slingshot-core';
import type { RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import type { RedisLike } from '../types/redis';

// ---------------------------------------------------------------------------
// Cache adapter interface
// ---------------------------------------------------------------------------

/**
 * Common interface for auth cache backends.
 *
 * Used internally by slingshot-auth for short-lived ephemeral data (rate-limit
 * buckets, nonces, etc.) that must survive across requests but not necessarily
 * across process restarts.  Three implementations are provided:
 * `createMemoryCacheAdapter`, `createSqliteCacheAdapter`, and
 * `createRedisCacheAdapter`.
 *
 * @remarks
 * All key and pattern arguments are unscoped — callers must include any
 * required prefixes.  The Redis adapter automatically namespaces under
 * `cache:<appName>:`.
 */
export interface ICacheAdapter {
  /** Human-readable backend name, e.g. `"memory"`, `"sqlite"`, `"redis"`. */
  name: string;

  /**
   * Retrieves the value stored under `key`.
   *
   * @param key - Cache key.
   * @returns The stored string, or `null` if missing or expired.
   */
  get(key: string): Promise<string | null>;

  /**
   * Stores a value under `key`.
   *
   * @param key - Cache key.
   * @param value - String value to store.
   * @param ttl - Optional time-to-live in **seconds**.  When omitted the entry
   *   does not expire (or relies on the backend's own eviction policy).
   */
  set(key: string, value: string, ttl?: number): Promise<void>;

  /**
   * Deletes the entry for `key`.  No-ops if the key does not exist.
   *
   * @param key - Cache key to delete.
   */
  del(key: string): Promise<void>;

  /**
   * Deletes all keys matching a glob-style `pattern`.
   *
   * The only supported wildcard is `*` (matches any sequence of characters).
   * Example: `"rate:*"` deletes every key whose name starts with `"rate:"`.
   *
   * @param pattern - Glob pattern where `*` is a wildcard.
   */
  delPattern(pattern: string): Promise<void>;

  /**
   * Returns `true` when the adapter is ready to accept operations.
   *
   * The memory and SQLite adapters always return `true`.  The Redis adapter
   * returns `false` when the Redis getter throws (connection not yet
   * established or broken).
   */
  isReady(): boolean;
}

// ---------------------------------------------------------------------------
// Memory cache factory
// ---------------------------------------------------------------------------

interface MemoryCacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * Creates an in-memory cache adapter.
 *
 * All entries are stored in a process-local `Map`.  Suitable for development,
 * testing, and single-server deployments where cache durability across
 * restarts is not required.
 *
 * Each call produces an independent instance with its own closure-owned `Map`
 * — no shared module-level state (factory pattern, Rule 3).
 *
 * Entries are evicted when either:
 * - the per-entry TTL has elapsed (checked lazily on `get`), or
 * - the store reaches `DEFAULT_MAX_ENTRIES` (oldest-first eviction on `set`).
 *
 * @returns An `ICacheAdapter` backed by an in-memory `Map`.
 *
 * @example
 * const cache = createMemoryCacheAdapter();
 * await cache.set('nonce:abc123', '1', 60);
 * const val = await cache.get('nonce:abc123'); // '1'
 * await cache.del('nonce:abc123');
 */
export function createMemoryCacheAdapter(): ICacheAdapter {
  const store = new Map<string, MemoryCacheEntry>();

  return {
    name: 'memory',
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttl) {
      evictOldest(store, DEFAULT_MAX_ENTRIES);
      const expiresAt = ttl ? Date.now() + ttl * 1000 : 0;
      store.set(key, { value, expiresAt });
    },
    async del(key) {
      store.delete(key);
    },
    async delPattern(pattern) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      for (const key of store.keys()) {
        if (regex.test(key)) store.delete(key);
      }
    },
    isReady() {
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite cache factory
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite-backed cache adapter.
 *
 * Stores entries in an `auth_cache` table (created lazily on the first
 * operation).  TTL is tracked as a Unix-millisecond timestamp in the
 * `expiresAt` column; expired rows are filtered at query time, not swept
 * proactively.
 *
 * Suitable for single-server deployments that already use SQLite for
 * persistence and want durable caching across process restarts.
 *
 * @param db - An open `RuntimeSqliteDatabase` handle.
 * @returns An `ICacheAdapter` backed by SQLite.
 *
 * @example
 * const db = sqlite.open('/data/auth.db');
 * const cache = createSqliteCacheAdapter(db);
 * await cache.set('rate:user-1', '5', 60);
 */
export function createSqliteCacheAdapter(db: RuntimeSqliteDatabase): ICacheAdapter {
  let initialized = false;

  function init(): void {
    if (initialized) return;
    db.run(`CREATE TABLE IF NOT EXISTS auth_cache (
      key       TEXT PRIMARY KEY,
      value     TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_auth_cache_expiresAt ON auth_cache(expiresAt)');
    initialized = true;
  }

  return {
    name: 'sqlite',
    async get(key) {
      init();
      const now = Date.now();
      const row = db
        .query('SELECT value FROM auth_cache WHERE key = ? AND (expiresAt = 0 OR expiresAt > ?)')
        .get(key, now) as { value: string } | null;
      return row?.value ?? null;
    },
    async set(key, value, ttl) {
      init();
      const expiresAt = ttl ? Date.now() + ttl * 1000 : 0;
      db.run(
        `INSERT INTO auth_cache (key, value, expiresAt)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expiresAt = excluded.expiresAt`,
        key,
        value,
        expiresAt,
      );
    },
    async del(key) {
      init();
      db.run('DELETE FROM auth_cache WHERE key = ?', key);
    },
    async delPattern(pattern) {
      init();
      const likePattern = pattern.replace(/\*/g, '%');
      db.run('DELETE FROM auth_cache WHERE key LIKE ?', likePattern);
    },
    isReady() {
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Redis cache factory
// ---------------------------------------------------------------------------

/**
 * Creates a Redis-backed cache adapter.
 *
 * All keys are automatically namespaced as `cache:<appName>:<key>` to prevent
 * collisions with other Redis users in the same instance.  TTL is enforced
 * natively via Redis `EX` (seconds).
 *
 * `isReady()` returns `false` when the `getRedis` getter throws, making it
 * safe to use as a health-check signal before attempting operations.
 *
 * @param getRedis - Factory that returns the active `RedisLike` connection.
 *   Called on every operation so the adapter automatically picks up reconnected
 *   clients.
 * @param appName - Application name used as the key namespace prefix.
 * @returns An `ICacheAdapter` backed by Redis.
 *
 * @example
 * const cache = createRedisCacheAdapter(() => redisClient, 'my-app');
 * await cache.set('nonce:xyz', '1', 300);
 * const val = await cache.get('nonce:xyz'); // '1'
 * await cache.delPattern('nonce:*');
 */
export function createRedisCacheAdapter(getRedis: () => RedisLike, appName: string): ICacheAdapter {
  return {
    name: 'redis',
    async get(key) {
      return getRedis().get(`cache:${appName}:${key}`);
    },
    async set(key, value, ttl) {
      if (ttl) {
        await getRedis().set(`cache:${appName}:${key}`, value, 'EX', ttl);
      } else {
        await getRedis().set(`cache:${appName}:${key}`, value);
      }
    },
    async del(key) {
      await getRedis().del(`cache:${appName}:${key}`);
    },
    async delPattern(pattern) {
      const redis = getRedis();
      const fullPattern = `cache:${appName}:${pattern.replace(/\*/g, '*')}`;
      const keys = await redis.keys(fullPattern);
      if (keys.length > 0) await redis.del(...keys);
    },
    isReady() {
      try {
        getRedis();
        return true;
      } catch {
        return false;
      }
    },
  };
}
