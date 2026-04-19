 
import { DEFAULT_MAX_ENTRIES, evictOldest } from '@lastshotlabs/slingshot-core';
// ---------------------------------------------------------------------------
// Factory map — add new store types here
// ---------------------------------------------------------------------------

import type { RepoFactories, RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import { createSqliteInitializer } from './sqliteInit';
import type { RedisLike } from '../types/redis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Persisted state for a single rate-limit bucket.
 */
export interface AuthRateLimitEntry {
  /** Number of attempts recorded within the current window. */
  count: number;
  /** Epoch milliseconds at which the current window expires and the counter resets. */
  resetAt: number;
}

/**
 * Window and ceiling configuration for a single rate-limit check.
 *
 * Passed to `isLimited` and `trackAttempt` to define the sliding window and maximum
 * allowed attempts within that window. Comes from `AuthRateLimitConfig` on each endpoint.
 */
export interface LimitOpts {
  /** Length of the sliding window in milliseconds. */
  windowMs: number;
  /** Maximum number of attempts allowed within the window before the key is blocked. */
  max: number;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

/**
 * Service interface for auth-specific rate limiting.
 *
 * Each `key` typically encodes the subject being limited — for example,
 * `login:{ip}` or `register:{ip}`. The `opts` window and max are per-endpoint
 * and come from `AuthRateLimitConfig`.
 *
 * @remarks
 * Prefer `trackAttempt` over separate `isLimited` + increment calls — `trackAttempt`
 * is atomic in Redis-backed stores. Use `bustAuthLimit` to clear the counter after
 * a successful login.
 */
export interface AuthRateLimitService {
  isLimited(key: string, opts: LimitOpts): Promise<boolean>;
  trackAttempt(key: string, opts: LimitOpts): Promise<boolean>;
  bustAuthLimit(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for auth rate limit counters.
 *
 * `increment` is an optional performance optimization for Redis and Postgres backends —
 * it performs an atomic increment in a single round-trip. Memory and SQLite backends
 * omit it and fall back to the read-modify-write path in `createAuthRateLimitService`.
 */
export interface AuthRateLimitRepository {
  get(key: string): Promise<AuthRateLimitEntry | null>;
  set(key: string, entry: AuthRateLimitEntry, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Atomically increments the attempt counter for `key` within the given window and returns
   * the new count.
   *
   * @param key - The rate-limit bucket key (e.g., `'login:user@example.com'`).
   * @param windowMs - Sliding-window length in milliseconds. Used to set `resetAt` on a new
   *   bucket or to preserve the existing `resetAt` when the bucket already exists.
   * @returns The updated attempt count after the increment.
   *
   * @remarks
   * This method is an **optional performance optimization** for backends that support
   * true atomic increment in a single round-trip (Redis Lua script, Postgres `ON CONFLICT`
   * upsert). Memory and SQLite implementations omit it; the service layer falls back to a
   * read-modify-write sequence which is safe for single-process deployments but not for
   * multi-instance setups (use Redis for those).
   */
  increment?(key: string, windowMs: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Memory repository factory
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory rate limit repository.
 *
 * Entries are lazily evicted when read after expiry. Suitable for single-process
 * development/testing. For multi-instance deployments use a Redis-backed repository
 * so counters are shared across all server processes.
 *
 * @returns An `AuthRateLimitRepository` backed by an in-memory `Map`.
 *
 * @example
 * import { createMemoryAuthRateLimitRepository, createAuthRateLimitService } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const repo = createMemoryAuthRateLimitRepository();
 * const service = createAuthRateLimitService(repo);
 */
export function createMemoryAuthRateLimitRepository(): AuthRateLimitRepository {
  const store = new Map<string, AuthRateLimitEntry>();

  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.resetAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry;
    },
    async set(key, entry) {
      evictOldest(store, DEFAULT_MAX_ENTRIES);
      store.set(key, entry);
    },
    async delete(key) {
      store.delete(key);
    },
    // No increment — memory store uses the read-modify-write fallback (single-process, acceptable)
  };
}

// ---------------------------------------------------------------------------
// SQLite repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite-backed auth rate limit repository.
 *
 * The `auth_rate_limit` table is created on first use (lazy init, idempotent).
 * Expired entries are purged inline during `get` to avoid unbounded table growth.
 * No atomic `increment` is provided — the service falls back to a read-modify-write
 * sequence, which is safe for single-process SQLite deployments.
 *
 * @param db - The Bun SQLite database handle (`RuntimeSqliteDatabase`).
 * @returns An `AuthRateLimitRepository` backed by SQLite.
 *
 * @remarks
 * The table is auto-created on the first call to any method. Subsequent calls skip
 * initialisation via a closure-owned `initialized` flag.
 *
 * @example
 * import { createSqliteAuthRateLimitRepository, createAuthRateLimitService } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const repo = createSqliteAuthRateLimitRepository(db);
 * const service = createAuthRateLimitService(repo);
 */
export function createSqliteAuthRateLimitRepository(
  db: RuntimeSqliteDatabase,
): AuthRateLimitRepository {
  const init = createSqliteInitializer(db, () => {
    db.run(`CREATE TABLE IF NOT EXISTS auth_rate_limit (
      subjectKey TEXT PRIMARY KEY,
      count      INTEGER NOT NULL,
      resetAt    INTEGER NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_auth_rate_limit_resetAt ON auth_rate_limit(resetAt)');
  });

  return {
    async get(key) {
      init();
      const now = Date.now();
      const row = db
        .query('SELECT count, resetAt FROM auth_rate_limit WHERE subjectKey = ? AND resetAt > ?')
        .get(key, now) as { count: number; resetAt: number } | null;
      if (row) return { count: row.count, resetAt: row.resetAt };
      db.run('DELETE FROM auth_rate_limit WHERE subjectKey = ? AND resetAt <= ?', key, now);
      return null;
    },
    async set(key, entry) {
      init();
      db.run(
        `INSERT INTO auth_rate_limit (subjectKey, count, resetAt)
         VALUES (?, ?, ?)
         ON CONFLICT(subjectKey) DO UPDATE SET count = excluded.count, resetAt = excluded.resetAt`,
        key,
        entry.count,
        entry.resetAt,
      );
    },
    async delete(key) {
      init();
      db.run('DELETE FROM auth_rate_limit WHERE subjectKey = ?', key);
    },
  };
}

// ---------------------------------------------------------------------------
// Redis repository factory
// ---------------------------------------------------------------------------

// Lua script: atomically read + increment + write JSON entry, preserving { count, resetAt } format.
// Returns the new count as a number.
const TRACK_SCRIPT = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local raw = redis.call("GET", key)
local count, resetAt

if raw then
  local entry = cjson.decode(raw)
  count = entry.count + 1
  resetAt = entry.resetAt
else
  count = 1
  resetAt = now + windowMs
end

local ttl = math.max(1, resetAt - now)
local payload = cjson.encode({count = count, resetAt = resetAt})
redis.call("SET", key, payload, "PX", ttl)
return count
`;

/**
 * Creates a Redis-backed auth rate limit repository.
 *
 * Keys are namespaced as `rl:<appName>:<key>` to avoid collisions across apps sharing a
 * Redis instance. Provides a Lua-based atomic `increment` for single-round-trip upserts.
 *
 * @param getRedis - Factory function that returns the `RedisLike` client. Called once at
 *   creation time — the client is captured in the closure.
 * @param appName - Application name used as a Redis key namespace prefix.
 * @returns An `AuthRateLimitRepository` backed by Redis with atomic `increment` support.
 *
 * @example
 * import { createRedisAuthRateLimitRepository, createAuthRateLimitService } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const repo = createRedisAuthRateLimitRepository(() => redisClient, 'my-app');
 * const service = createAuthRateLimitService(repo);
 */
export function createRedisAuthRateLimitRepository(
  getRedis: () => RedisLike,
  appName: string,
): AuthRateLimitRepository {
  const redis = getRedis();

  return {
    async get(key) {
      const raw = await redis.get(`rl:${appName}:${key}`);
      if (!raw) return null;
      const entry = JSON.parse(raw) as AuthRateLimitEntry;
      if (entry.resetAt <= Date.now()) return null;
      return entry;
    },
    async set(key, entry, ttlMs) {
      await redis.set(`rl:${appName}:${key}`, JSON.stringify(entry), 'PX', ttlMs);
    },
    async delete(key) {
      await redis.del(`rl:${appName}:${key}`);
    },
    async increment(key, windowMs) {
      const fullKey = `rl:${appName}:${key}`;
      const now = Date.now();
      const count = (await redis.eval(TRACK_SCRIPT, 1, fullKey, windowMs, now)) as number;
      return count;
    },
  };
}

// ---------------------------------------------------------------------------
// Mongo repository factory
// ---------------------------------------------------------------------------

interface AuthRateLimitDoc {
  subjectKey: string;
  count: number;
  resetAt: number;
  expiresAt: Date;
}

/**
 * Creates a MongoDB-backed auth rate limit repository.
 *
 * Registers (or retrieves a cached) `AuthRateLimit` Mongoose model on the provided connection.
 * Documents expire via a MongoDB TTL index on `expiresAt` (set to the same value as `resetAt`).
 * No atomic `increment` is provided — the service uses read-modify-write with `upsert`.
 *
 * @param conn - The Mongoose `Connection` to register the model on.
 * @param mg - The `mongoose` module instance used for `Schema` construction.
 * @returns An `AuthRateLimitRepository` backed by MongoDB.
 *
 * @remarks
 * The collection `auth_rate_limits` is auto-created on the first write. The TTL index
 * is registered at schema definition time; MongoDB background reaper enforces expiry
 * (typically within 60 seconds of `expiresAt`).
 *
 * @example
 * import { createMongoAuthRateLimitRepository, createAuthRateLimitService } from '@lastshotlabs/slingshot-auth/plugin';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const repo = createMongoAuthRateLimitRepository(conn, mongoose);
 * const service = createAuthRateLimitService(repo);
 */
export function createMongoAuthRateLimitRepository(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
): AuthRateLimitRepository {
  function getModel(): import('mongoose').Model<AuthRateLimitDoc> {
    if ('AuthRateLimit' in conn.models) {
      return conn.models['AuthRateLimit'] as unknown as import('mongoose').Model<AuthRateLimitDoc>;
    }
    const { Schema } = mg;
    const schema = new Schema<AuthRateLimitDoc>(
      {
        subjectKey: { type: String, required: true, unique: true },
        count: { type: Number, required: true },
        resetAt: { type: Number, required: true },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'auth_rate_limits' },
    );
    return conn.model('AuthRateLimit', schema) as import('mongoose').Model<AuthRateLimitDoc>;
  }

  return {
    async get(key) {
      const now = Date.now();
      const doc = await getModel()
        .findOne({
          subjectKey: key,
          resetAt: { $gt: now },
        })
        .lean();
      if (!doc) return null;
      return { count: doc.count, resetAt: doc.resetAt };
    },
    async set(key, entry) {
      await getModel().updateOne(
        { subjectKey: key },
        {
          $set: {
            count: entry.count,
            resetAt: entry.resetAt,
            expiresAt: new Date(entry.resetAt),
          },
        },
        { upsert: true },
      );
    },
    async delete(key) {
      await getModel().deleteOne({ subjectKey: key });
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Postgres-backed auth rate limit repository.
 *
 * The `auth_rate_limits` table is created on first use (lazy `ensureTable`, idempotent).
 * Provides a Postgres `ON CONFLICT` atomic `increment` that resets the counter when the
 * existing row's `reset_at` has passed — fully safe under concurrent load.
 *
 * @param pool - The `pg.Pool` instance to use for queries.
 * @returns An `AuthRateLimitRepository` backed by Postgres with atomic `increment` support.
 *
 * @remarks
 * The table is auto-created on the first method call. Expired rows are not reaped
 * automatically — they are effectively ignored by the `reset_at > now` filter and
 * overwritten on the next write for the same key.
 *
 * @example
 * import { createPostgresAuthRateLimitRepository, createAuthRateLimitService } from '@lastshotlabs/slingshot-auth/plugin';
 * import { Pool } from 'pg';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const repo = createPostgresAuthRateLimitRepository(pool);
 * const service = createAuthRateLimitService(repo);
 */
export function createPostgresAuthRateLimitRepository(
  pool: import('pg').Pool,
): AuthRateLimitRepository {
  let tableReady = false;
  const ensureTable = async (): Promise<void> => {
    if (tableReady) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_rate_limits (
      subject_key TEXT PRIMARY KEY,
      count       INTEGER NOT NULL,
      reset_at    BIGINT NOT NULL
    )`);
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_reset_at ON auth_rate_limits(reset_at)',
    );
    tableReady = true;
  };

  return {
    async get(key) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ count: number; reset_at: string }>(
        'SELECT count, reset_at FROM auth_rate_limits WHERE subject_key = $1 AND reset_at > $2',
        [key, now],
      );
      if (!rows[0]) return null;
      return { count: rows[0].count, resetAt: Number(rows[0].reset_at) };
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by interface, Postgres uses reset_at instead of TTL
    async set(key, entry, _ttlMs) {
      await ensureTable();
      await pool.query(
        `INSERT INTO auth_rate_limits (subject_key, count, reset_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (subject_key) DO UPDATE SET
           count    = EXCLUDED.count,
           reset_at = EXCLUDED.reset_at`,
        [key, entry.count, entry.resetAt],
      );
    },
    async delete(key) {
      await ensureTable();
      await pool.query('DELETE FROM auth_rate_limits WHERE subject_key = $1', [key]);
    },
    async increment(key, windowMs) {
      await ensureTable();
      const now = Date.now();
      const resetAt = now + windowMs;
      // Atomic upsert: if new row, start count=1; if existing and not expired, increment; if expired, reset.
      const { rows } = await pool.query<{ count: number }>(
        `INSERT INTO auth_rate_limits (subject_key, count, reset_at)
         VALUES ($1, 1, $2)
         ON CONFLICT (subject_key) DO UPDATE SET
           count    = CASE
             WHEN auth_rate_limits.reset_at <= $3 THEN 1
             ELSE auth_rate_limits.count + 1
           END,
           reset_at = CASE
             WHEN auth_rate_limits.reset_at <= $3 THEN $2
             ELSE auth_rate_limits.reset_at
           END
         RETURNING count`,
        [key, resetAt, now],
      );
      return rows[0]?.count ?? 1;
    },
  };
}

export const authRateLimitFactories: RepoFactories<AuthRateLimitRepository> = {
  memory: () => createMemoryAuthRateLimitRepository(),
  sqlite: infra => createSqliteAuthRateLimitRepository(infra.getSqliteDb()),
  redis: infra => createRedisAuthRateLimitRepository(infra.getRedis, infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoAuthRateLimitRepository(conn, mg);
  },
  postgres: infra => createPostgresAuthRateLimitRepository(infra.getPostgres().pool),
};

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

/**
 * Creates the auth rate limit service that wraps a repository with business logic.
 *
 * `trackAttempt` increments the counter and returns `true` when the limit is exceeded.
 * It is atomic in Redis-backed stores (Lua script) and uses a read-modify-write fallback
 * for in-process stores. `bustAuthLimit` clears the counter on successful login.
 *
 * @param repo - The backing `AuthRateLimitRepository`.
 * @returns An `AuthRateLimitService` instance.
 *
 * @example
 * import { createMemoryAuthRateLimitRepository, createAuthRateLimitService } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const service = createAuthRateLimitService(createMemoryAuthRateLimitRepository());
 * const blocked = await service.trackAttempt('login:127.0.0.1', { windowMs: 60000, max: 5 });
 * if (blocked) return c.json({ error: 'Too many attempts' }, 429);
 */
export function createAuthRateLimitService(repo: AuthRateLimitRepository): AuthRateLimitService {
  return {
    async isLimited(key: string, opts: LimitOpts): Promise<boolean> {
      const entry = await repo.get(key);
      if (!entry) return false;
      return entry.count >= opts.max;
    },

    async trackAttempt(key: string, opts: LimitOpts): Promise<boolean> {
      if (repo.increment) {
        const count = await repo.increment(key, opts.windowMs);
        return count >= opts.max;
      }
      // Read-modify-write fallback for memory store (single-process — no lost increments)
      const now = Date.now();
      const existing = await repo.get(key);
      if (!existing) {
        await repo.set(key, { count: 1, resetAt: now + opts.windowMs }, opts.windowMs);
        return 1 >= opts.max;
      }
      const updated: AuthRateLimitEntry = { count: existing.count + 1, resetAt: existing.resetAt };
      const remaining = Math.max(1, existing.resetAt - now);
      await repo.set(key, updated, remaining);
      return updated.count >= opts.max;
    },

    async bustAuthLimit(key: string): Promise<void> {
      await repo.delete(key);
    },
  };
}
