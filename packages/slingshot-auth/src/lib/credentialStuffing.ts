import { DEFAULT_MAX_ENTRIES, evictOldest } from '@lastshotlabs/slingshot-core';
import type { RepoFactories, RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import type { RedisLike } from '../types/redis';
import { createPostgresInitializer } from './postgresInit';
import { createSqliteInitializer } from './sqliteInit';

/**
 * Configuration for the credential stuffing detection service.
 *
 * Controls the two detection signals and an optional notification callback. Both signals
 * use sliding windows: the count tracks **distinct** identifiers (accounts per IP or IPs
 * per account), not the total number of attempts. This means the effective count can
 * decrease as old entries slide out of the window.
 *
 * Set on `AuthPluginConfig.auth.credentialStuffing`.
 */
export interface CredentialStuffingConfig {
  /**
   * Block when a single IP has attempted login against this many distinct accounts within
   * the window. Default: `{ count: 5, windowMs: 900_000 }` (5 accounts per 15 minutes).
   */
  maxAccountsPerIp?: { count: number; windowMs: number };
  /**
   * Block when a single account has been attempted from this many distinct IPs within
   * the window. Default: `{ count: 10, windowMs: 900_000 }` (10 IPs per 15 minutes).
   */
  maxIpsPerAccount?: { count: number; windowMs: number };
  /**
   * Called when a stuffing threshold is crossed. Non-blocking — errors are swallowed so
   * a failing callback never disrupts the login flow.
   */
  onDetected?: (signal: { type: 'ip' | 'account'; key: string; count: number }) => void;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

/**
 * Service interface for credential stuffing detection.
 *
 * Tracks two signals: the number of distinct accounts attempted from a single IP, and
 * the number of distinct IPs attempting a single account. When either threshold is
 * exceeded the service returns `true` (blocked) so callers can gate the response.
 *
 * @remarks
 * **Set semantics vs counter semantics**: The underlying repository tracks distinct
 * members in a sliding-window set, not a simple incrementing counter. This means:
 * - Repeated attempts by the same IP against the same account count as **one** entry,
 *   not many — the IP/account pair is deduplicated.
 * - As old entries age out of the window the effective count can **decrease** below the
 *   threshold, lifting the block automatically without manual intervention. An IP that
 *   was blocked because it hit 5 distinct accounts may drop back below the threshold
 *   once those window entries expire, without any manual unblocking.
 *
 * Treat the return value of `trackFailedLogin` as a blocking decision — it returns
 * `true` when the attempt pushes the counter over the threshold for the first time.
 * Subsequent calls to `isStuffingBlocked` check the current counter without incrementing.
 */
export interface CredentialStuffingService {
  /**
   * Records a failed login attempt and checks whether the stuffing thresholds are
   * now exceeded.
   *
   * @param ip - The client IP address.
   * @param identifier - The submitted login identifier (email, username, etc.).
   * @returns `true` when **this call** crosses a threshold for the first time;
   *   `false` on all subsequent calls after the threshold is already exceeded, and
   *   `false` when no threshold is crossed at all.
   *
   * @remarks
   * **First-crossing semantics**: `true` is returned **only** on the call that pushes
   * the distinct-member count from below the threshold to at or above it. Subsequent
   * calls while the count remains at or above the threshold return `false`. This means
   * a `true` return is a suitable trigger for a one-time alert (e.g., notify an admin
   * channel), while `isStuffingBlocked` should be used to gate individual requests.
   *
   * Both the IP→accounts signal and the account→IPs signal are updated in a single
   * call. The method returns `true` as soon as the first signal crosses its threshold —
   * the second signal check is skipped in that case.
   */
  trackFailedLogin(ip: string, identifier: string): Promise<boolean>;
  isStuffingBlocked(ip: string, identifier: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for credential stuffing sliding-window sets.
 *
 * Each `key` names a set (e.g. `ip:1.2.3.4` or `account:user@example.com`).
 * `addToSet` inserts a `member` into the windowed set and returns the current set size.
 * `getSetSize` returns the current size without modifying the set.
 */
export interface CredentialStuffingRepository {
  /**
   * Inserts `member` into the windowed set identified by `key` and returns the current
   * distinct member count after the insertion.
   *
   * @param key - Set key (e.g., `'ip:1.2.3.4'` or `'account:user@example.com'`).
   * @param member - The value to add (e.g., the account identifier for an IP set, or the
   *   IP address for an account set).
   * @param windowMs - Sliding-window duration in milliseconds. Entries older than this are
   *   excluded from the count and evicted on the next write.
   */
  addToSet(key: string, member: string, windowMs: number): Promise<number>;
  /**
   * Returns the number of distinct members currently in the windowed set for `key`.
   * Does not modify the set.
   *
   * @param key - Set key to query.
   * @param windowMs - Sliding-window duration in milliseconds used to filter stale members.
   */
  getSetSize(key: string, windowMs: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Redis scripts
// ---------------------------------------------------------------------------

const REDIS_ADD_TO_SET_LUA = `
local key = KEYS[1]
local member = ARGV[1]
local now = tonumber(ARGV[2])
local windowStart = tonumber(ARGV[3])
local windowMs = tonumber(ARGV[4])
redis.call('ZADD', key, now, member)
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
redis.call('PEXPIRE', key, windowMs)
return redis.call('ZCARD', key)
`;

const REDIS_GET_SET_SIZE_LUA = `
local key = KEYS[1]
local windowStart = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
return redis.call('ZCARD', key)
`;

// ---------------------------------------------------------------------------
// Memory repository factory
// ---------------------------------------------------------------------------

interface BoundedSet {
  members: Set<string>;
  expiresAt: number;
}

/**
 * Creates an in-memory credential stuffing repository.
 *
 * Uses `Map`s of bounded `Set`s with per-entry TTLs. Expired entries are swept on
 * each `addToSet` call. Suitable for single-process development and testing.
 *
 * @returns A `CredentialStuffingRepository` backed by in-memory `Map`s.
 *
 * @example
 * import { createMemoryCredentialStuffingRepository, createCredentialStuffingService } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const service = createCredentialStuffingService(
 *   { maxAccountsPerIp: { count: 5, windowMs: 900_000 } },
 *   createMemoryCredentialStuffingRepository(),
 * );
 */
export function createMemoryCredentialStuffingRepository(): CredentialStuffingRepository {
  const store = new Map<string, BoundedSet>();

  function cleanExpired(): void {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt < now) store.delete(key);
    }
  }

  return {
    async addToSet(key, member, windowMs) {
      cleanExpired();
      const now = Date.now();
      let entry = store.get(key);
      if (!entry || entry.expiresAt < now) {
        entry = { members: new Set(), expiresAt: now + windowMs };
        evictOldest(store, DEFAULT_MAX_ENTRIES);
        store.set(key, entry);
      }
      entry.members.add(member);
      return entry.members.size;
    },
    async getSetSize(key) {
      cleanExpired();
      const now = Date.now();
      const entry = store.get(key);
      if (!entry || entry.expiresAt < now) return 0;
      return entry.members.size;
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite-backed credential stuffing repository.
 *
 * The `auth_credential_stuffing` table stores `(bucketKey, member, expiresAt)` triplets
 * with a composite primary key on `(bucketKey, member)`. Expired rows are purged inline
 * during each `addToSet` / `getSetSize` call for the matching bucket. The table and its
 * indexes are created on first use.
 *
 * @param db - The Bun SQLite database handle (`RuntimeSqliteDatabase`).
 * @returns A `CredentialStuffingRepository` backed by SQLite.
 *
 * @remarks
 * The table is auto-created on the first method call.
 *
 * @example
 * import { createSqliteCredentialStuffingRepository, createCredentialStuffingService } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const repo = createSqliteCredentialStuffingRepository(db);
 * const service = createCredentialStuffingService({ maxAccountsPerIp: { count: 5, windowMs: 900_000 } }, repo);
 */
export function createSqliteCredentialStuffingRepository(
  db: RuntimeSqliteDatabase,
): CredentialStuffingRepository {
  const init = createSqliteInitializer(db, () => {
    db.run(`CREATE TABLE IF NOT EXISTS auth_credential_stuffing (
      bucketKey TEXT NOT NULL,
      member    TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      PRIMARY KEY (bucketKey, member)
    )`);
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_auth_credential_stuffing_expiresAt ON auth_credential_stuffing(expiresAt)',
    );
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_auth_credential_stuffing_bucketKey ON auth_credential_stuffing(bucketKey)',
    );
  });

  return {
    async addToSet(key, member, windowMs) {
      init();
      const now = Date.now();
      const expiresAt = now + windowMs;
      db.run(
        'DELETE FROM auth_credential_stuffing WHERE bucketKey = ? AND expiresAt <= ?',
        key,
        now,
      );
      db.run(
        `INSERT INTO auth_credential_stuffing (bucketKey, member, expiresAt)
         VALUES (?, ?, ?)
         ON CONFLICT(bucketKey, member) DO UPDATE SET expiresAt = excluded.expiresAt`,
        key,
        member,
        expiresAt,
      );
      const row = db
        .query(
          'SELECT COUNT(*) AS count FROM auth_credential_stuffing WHERE bucketKey = ? AND expiresAt > ?',
        )
        .get(key, now) as { count: number } | null;
      return row?.count ?? 0;
    },
    async getSetSize(key) {
      init();
      const now = Date.now();
      db.run(
        'DELETE FROM auth_credential_stuffing WHERE bucketKey = ? AND expiresAt <= ?',
        key,
        now,
      );
      const row = db
        .query(
          'SELECT COUNT(*) AS count FROM auth_credential_stuffing WHERE bucketKey = ? AND expiresAt > ?',
        )
        .get(key, now) as { count: number } | null;
      return row?.count ?? 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Redis repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Redis-backed credential stuffing repository.
 *
 * Uses Redis sorted sets (ZADD/ZREMRANGEBYSCORE/ZCARD) with scores set to the current
 * epoch-ms timestamp, enabling true sliding-window semantics. All operations are Lua
 * scripts for atomic round-trip execution. Keys are namespaced as
 * `credstuffing:<appName>:<key>` and expire after `windowMs` via `PEXPIRE`.
 *
 * @param getRedis - Factory function that returns the `RedisLike` client.
 * @param appName - Application name used as a Redis key namespace prefix.
 * @returns A `CredentialStuffingRepository` backed by Redis.
 *
 * @example
 * import { createRedisCredentialStuffingRepository, createCredentialStuffingService } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const repo = createRedisCredentialStuffingRepository(() => redisClient, 'my-app');
 * const service = createCredentialStuffingService({ maxAccountsPerIp: { count: 5, windowMs: 900_000 } }, repo);
 */
export function createRedisCredentialStuffingRepository(
  getRedis: () => RedisLike,
  appName: string,
): CredentialStuffingRepository {
  const redis = getRedis();

  return {
    async addToSet(key, member, windowMs) {
      const now = Date.now();
      const windowStart = now - windowMs;
      const fullKey = `credstuffing:${appName}:${key}`;
      return redis.eval(
        REDIS_ADD_TO_SET_LUA,
        1,
        fullKey,
        member,
        now,
        windowStart,
        windowMs,
      ) as Promise<number>;
    },
    async getSetSize(key, windowMs) {
      const now = Date.now();
      const windowStart = now - windowMs;
      const fullKey = `credstuffing:${appName}:${key}`;
      return redis.eval(REDIS_GET_SET_SIZE_LUA, 1, fullKey, windowStart) as Promise<number>;
    },
  };
}

// ---------------------------------------------------------------------------
// Mongo repository factory
// ---------------------------------------------------------------------------

interface CredentialStuffingDoc {
  bucketKey: string;
  member: string;
  expiresAt: Date;
}

/**
 * Creates a MongoDB-backed credential stuffing repository.
 *
 * Registers (or retrieves a cached) `CredentialStuffing` Mongoose model with a compound
 * unique index on `(bucketKey, member)` and a TTL index on `expiresAt`. `addToSet` uses
 * an upsert to insert-or-refresh the expiry, then `countDocuments` for the set size.
 * Note: the two operations are not atomic — a concurrent prune between the upsert and
 * count could under-report by at most one, which is acceptable for detection purposes.
 *
 * @param conn - The Mongoose `Connection` to register the model on.
 * @param mg - The `mongoose` module instance used for `Schema` construction.
 * @returns A `CredentialStuffingRepository` backed by MongoDB.
 *
 * @remarks
 * The collection `credential_stuffing` is auto-created on the first write.
 *
 * @example
 * import { createMongoCredentialStuffingRepository, createCredentialStuffingService } from '@lastshotlabs/slingshot-auth/plugin';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const repo = createMongoCredentialStuffingRepository(conn, mongoose);
 */
export function createMongoCredentialStuffingRepository(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
): CredentialStuffingRepository {
  function getModel(): import('mongoose').Model<CredentialStuffingDoc> {
    if ('CredentialStuffing' in conn.models) {
      return conn.models[
        'CredentialStuffing'
      ] as unknown as import('mongoose').Model<CredentialStuffingDoc>;
    }
    const { Schema } = mg;
    const schema = new Schema<CredentialStuffingDoc>(
      {
        bucketKey: { type: String, required: true, index: true },
        member: { type: String, required: true },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'credential_stuffing' },
    );
    schema.index({ bucketKey: 1, member: 1 }, { unique: true });
    return conn.model(
      'CredentialStuffing',
      schema,
    ) as import('mongoose').Model<CredentialStuffingDoc>;
  }

  return {
    async addToSet(key, member, windowMs) {
      const expiresAt = new Date(Date.now() + windowMs);
      await getModel().updateOne(
        { bucketKey: key, member },
        { $set: { expiresAt } },
        { upsert: true },
      );
      return getModel().countDocuments({
        bucketKey: key,
        expiresAt: { $gt: new Date() },
      });
    },
    async getSetSize(key) {
      return getModel().countDocuments({
        bucketKey: key,
        expiresAt: { $gt: new Date() },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Postgres-backed credential stuffing repository.
 *
 * The `auth_credential_stuffing` table uses a composite primary key on `(bucket_key, member)`
 * and is created on first use via `ensureTable`. Expired rows are purged inline per-bucket
 * during each `addToSet` / `getSetSize` call. The upsert refreshes the `expires_at` of
 * existing members so members observed repeatedly stay alive for the full window.
 *
 * @param pool - The `pg.Pool` instance to use for queries.
 * @returns A `CredentialStuffingRepository` backed by Postgres.
 *
 * @example
 * import { createPostgresCredentialStuffingRepository, createCredentialStuffingService } from '@lastshotlabs/slingshot-auth/plugin';
 * import { Pool } from 'pg';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const repo = createPostgresCredentialStuffingRepository(pool);
 */
export function createPostgresCredentialStuffingRepository(
  pool: import('pg').Pool,
): CredentialStuffingRepository {
  const ensureTable = createPostgresInitializer(pool, async client => {
    await client.query(`CREATE TABLE IF NOT EXISTS auth_credential_stuffing (
      bucket_key TEXT    NOT NULL,
      member     TEXT    NOT NULL,
      expires_at BIGINT  NOT NULL,
      PRIMARY KEY (bucket_key, member)
    )`);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_credential_stuffing_expires_at ON auth_credential_stuffing(expires_at)',
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_credential_stuffing_bucket_key ON auth_credential_stuffing(bucket_key)',
    );
  });

  return {
    async addToSet(key, member, windowMs) {
      await ensureTable();
      const now = Date.now();
      const expiresAt = now + windowMs;
      // Purge expired entries for this bucket, upsert the member, then count.
      await pool.query(
        'DELETE FROM auth_credential_stuffing WHERE bucket_key = $1 AND expires_at <= $2',
        [key, now],
      );
      await pool.query(
        `INSERT INTO auth_credential_stuffing (bucket_key, member, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (bucket_key, member) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [key, member, expiresAt],
      );
      const { rows } = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM auth_credential_stuffing WHERE bucket_key = $1 AND expires_at > $2',
        [key, now],
      );
      return Number(rows[0]?.count ?? 0);
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by interface, Postgres purges inline per-bucket
    async getSetSize(key, _windowMs) {
      await ensureTable();
      const now = Date.now();
      await pool.query(
        'DELETE FROM auth_credential_stuffing WHERE bucket_key = $1 AND expires_at <= $2',
        [key, now],
      );
      const { rows } = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM auth_credential_stuffing WHERE bucket_key = $1 AND expires_at > $2',
        [key, now],
      );
      return Number(rows[0]?.count ?? 0);
    },
  };
}

// ---------------------------------------------------------------------------
// Factory map
// ---------------------------------------------------------------------------

export const credentialStuffingFactories: RepoFactories<CredentialStuffingRepository> = {
  memory: () => createMemoryCredentialStuffingRepository(),
  sqlite: infra => createSqliteCredentialStuffingRepository(infra.getSqliteDb()),
  redis: infra => createRedisCredentialStuffingRepository(infra.getRedis, infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoCredentialStuffingRepository(conn, mg);
  },
  postgres: infra => createPostgresCredentialStuffingRepository(infra.getPostgres().pool),
};

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

/**
 * Creates the credential stuffing detection service.
 *
 * Wraps a `CredentialStuffingRepository` with the threshold logic from `config`.
 * Default thresholds: 5 distinct accounts per IP per 15 min (`maxAccountsPerIp`),
 * 10 distinct IPs per account per 15 min (`maxIpsPerAccount`).
 *
 * @param config - Detection thresholds and optional `onDetected` callback.
 * @param repo - The backing `CredentialStuffingRepository`.
 * @returns A `CredentialStuffingService` instance.
 *
 * @example
 * import {
 *   createMemoryCredentialStuffingRepository,
 *   createCredentialStuffingService,
 * } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const service = createCredentialStuffingService(
 *   {
 *     maxAccountsPerIp: { count: 3, windowMs: 60_000 },
 *     onDetected: ({ type, key }) => console.warn(`Stuffing detected: ${type}=${key}`),
 *   },
 *   createMemoryCredentialStuffingRepository(),
 * );
 */
export function createCredentialStuffingService(
  config: CredentialStuffingConfig,
  repo: CredentialStuffingRepository,
): CredentialStuffingService {
  return {
    async trackFailedLogin(ip: string, identifier: string): Promise<boolean> {
      const ipMax = config.maxAccountsPerIp?.count ?? 5;
      const accountMax = config.maxIpsPerAccount?.count ?? 10;
      const ipWindowMs = config.maxAccountsPerIp?.windowMs ?? 15 * 60 * 1000;
      const accountWindowMs = config.maxIpsPerAccount?.windowMs ?? 15 * 60 * 1000;

      const ipCount = await repo.addToSet(`ip:${ip}`, identifier, ipWindowMs);
      if (ipCount >= ipMax) {
        try {
          config.onDetected?.({ type: 'ip', key: ip, count: ipCount });
        } catch {
          /* swallowed — callback errors must not disrupt the login flow */
        }
        return true;
      }

      const accountCount = await repo.addToSet(`account:${identifier}`, ip, accountWindowMs);
      if (accountCount >= accountMax) {
        try {
          config.onDetected?.({ type: 'account', key: identifier, count: accountCount });
        } catch {
          /* swallowed — callback errors must not disrupt the login flow */
        }
        return true;
      }

      return false;
    },

    async isStuffingBlocked(ip: string, identifier: string): Promise<boolean> {
      const ipMax = config.maxAccountsPerIp?.count ?? 5;
      const accountMax = config.maxIpsPerAccount?.count ?? 10;
      const ipWindowMs = config.maxAccountsPerIp?.windowMs ?? 15 * 60 * 1000;
      const accountWindowMs = config.maxIpsPerAccount?.windowMs ?? 15 * 60 * 1000;

      const ipCount = await repo.getSetSize(`ip:${ip}`, ipWindowMs);
      if (ipCount >= ipMax) return true;

      const accountCount = await repo.getSetSize(`account:${identifier}`, accountWindowMs);
      if (accountCount >= accountMax) return true;

      return false;
    },
  };
}
