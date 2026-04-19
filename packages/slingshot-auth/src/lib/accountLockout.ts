 
import {
  DEFAULT_MAX_ENTRIES,
  RedisLike,
  createEvictExpired,
  evictOldest,
} from '@lastshotlabs/slingshot-core';
// ---------------------------------------------------------------------------
// Factory map - add new store types here
// ---------------------------------------------------------------------------

import type { RepoFactories, RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import { createSqliteInitializer } from './sqliteInit';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Configuration for the account lockout service.
 *
 * Configures the threshold and duration for account lockout after repeated failed login
 * attempts. Set on `AuthPluginConfig.auth.lockout`.
 *
 * @example
 * createAuthPlugin({
 *   auth: {
 *     lockout: {
 *       maxAttempts: 5,
 *       lockoutDuration: 900, // 15 minutes
 *       onLocked: async (userId, identifier) => {
 *         await notifyUser(identifier, 'Your account has been temporarily locked.');
 *       },
 *     },
 *   },
 * });
 */
export interface LockoutConfig {
  /** Failed attempts before account lockout. */
  maxAttempts: number;
  /** Duration to stay locked in seconds. */
  lockoutDuration: number;
  /** Reset failure counter on successful login. Default: true. */
  resetOnSuccess?: boolean;
  /** Called when an account is locked. Non-blocking - errors are swallowed. */
  onLocked?: (userId: string, identifier: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for account lockout state.
 *
 * Tracks failed attempt counts and locked-account markers. Each `key` is the user ID.
 * Implementations: memory, SQLite, Redis, MongoDB, Postgres (all resolved via `lockoutFactories`).
 */
export interface LockoutRepository {
  /**
   * Returns the current failed-attempt count for `key` (user ID), or `0` if no
   * unexpired entry exists.
   */
  getAttempts(key: string): Promise<number>;
  /**
   * Persists the failed-attempt count for `key` with a TTL. Overwrites any existing
   * entry. Typically called with `ttlMs = lockoutDuration * 2 * 1000` so the counter
   * outlives the lock itself.
   */
  setAttempts(key: string, count: number, ttlMs: number): Promise<void>;
  /** Removes the failed-attempt counter for `key`. Called on successful login when `resetOnSuccess` is enabled. */
  deleteAttempts(key: string): Promise<void>;
  /**
   * Marks `key` as locked for `ttlMs` milliseconds. Idempotent — re-locking an already
   * locked account extends (or replaces) the lock expiry.
   */
  setLocked(key: string, ttlMs: number): Promise<void>;
  /**
   * Returns `true` if the account identified by `key` is currently locked (lock record
   * exists and has not expired), `false` otherwise.
   */
  isLocked(key: string): Promise<boolean>;
  /** Removes the lock record for `key`, immediately unlocking the account. */
  deleteLocked(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

/**
 * Service interface for account lockout logic.
 *
 * Used by the login route to record failed attempts and gate subsequent attempts.
 * The `config` property exposes the `LockoutConfig` for consumers that need the
 * threshold values (e.g. to build error messages).
 *
 * @remarks
 * **Required call order**: always call `isAccountLocked` (via `SecurityGate.lockoutCheck`)
 * *before* calling `recordFailedAttempt`. Checking the lock status first ensures that
 * already-locked accounts are rejected without needlessly incrementing the counter (which
 * would extend the counter TTL and mask the original lock timestamp in audit logs).
 *
 * Typical login-failure flow:
 * 1. `gate.preAuthCheck(ip, identifier)` — pre-bcrypt (stuffing + rate limit)
 * 2. bcrypt verify password
 * 3. `gate.lockoutCheck(userId)` — post-bcrypt lockout check
 * 4. `lockoutService.recordFailedAttempt(userId)` — increment counter
 * 5. If count >= `config.maxAttempts`: `lockoutService.lockAccount(userId)`
 */
export interface LockoutService {
  /**
   * Increments the failed-attempt counter for `userId` and returns the new count.
   *
   * @param userId - The user ID whose attempt counter should be incremented.
   * @returns The new failed-attempt count after the increment.
   *
   * @remarks
   * The failure counter is stored with a TTL of `lockoutDuration × 2` seconds so that
   * the counter outlives the lock itself. This matters for audit — after a lock expires
   * naturally the counter is still present, so a fresh failure immediately after the lock
   * lifts will resume from the stored count rather than resetting to 1. The 2× multiplier
   * ensures the counter is not prematurely evicted while the account is still locked.
   */
  recordFailedAttempt(userId: string): Promise<number>;
  /**
   * Returns `true` if the account is currently locked (hard lock record exists and has
   * not expired). Does not check the attempt count — call `recordFailedAttempt` for that.
   */
  isAccountLocked(userId: string): Promise<boolean>;
  /**
   * Writes a hard lock record for `userId` with TTL = `config.lockoutDuration` seconds.
   * The lock expires automatically; no explicit unlock is needed for time-based release.
   */
  lockAccount(userId: string): Promise<void>;
  /**
   * Immediately removes the lock record and clears the failed-attempt counter for `userId`.
   * Used by admin unlock flows.
   */
  unlockAccount(userId: string): Promise<void>;
  /**
   * Clears the failed-attempt counter for `userId` without removing the lock record.
   * Called after a successful login when `config.resetOnSuccess` is `true` (default).
   */
  resetFailureCount(userId: string): Promise<void>;
  /** The lockout policy config this service was created with. Exposed for error-message construction. */
  readonly config: LockoutConfig;
}

// ---------------------------------------------------------------------------
// Memory repository factory
// ---------------------------------------------------------------------------

interface MemoryLockEntry {
  count: number;
  expiresAt: number;
}

/**
 * Creates an in-memory lockout repository.
 *
 * Uses two Maps: one for failed-attempt counters (with TTL), one for locked markers.
 * Entries are evicted opportunistically. Suitable for single-process dev/test.
 *
 * @returns A `LockoutRepository` backed by in-memory Maps.
 *
 * @example
 * import { createMemoryLockoutRepository, createLockoutService } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const repo = createMemoryLockoutRepository();
 * const service = createLockoutService({ maxAttempts: 5, lockoutDuration: 900 }, repo);
 */
export function createMemoryLockoutRepository(): LockoutRepository {
  const attempts = new Map<string, MemoryLockEntry>();
  const locked = new Map<string, number>();
  const evictExpired = createEvictExpired();

  return {
    async getAttempts(key) {
      const entry = attempts.get(key);
      if (!entry) return 0;
      if (entry.expiresAt <= Date.now()) {
        attempts.delete(key);
        return 0;
      }
      return entry.count;
    },
    async setAttempts(key, count, ttlMs) {
      evictExpired(attempts);
      evictOldest(attempts, DEFAULT_MAX_ENTRIES);
      attempts.set(key, { count, expiresAt: Date.now() + ttlMs });
    },
    async deleteAttempts(key) {
      attempts.delete(key);
    },
    async setLocked(key, ttlMs) {
      evictOldest(locked, DEFAULT_MAX_ENTRIES);
      locked.set(key, Date.now() + ttlMs);
    },
    async isLocked(key) {
      const expiresAt = locked.get(key);
      if (!expiresAt) return false;
      if (expiresAt <= Date.now()) {
        locked.delete(key);
        return false;
      }
      return true;
    },
    async deleteLocked(key) {
      locked.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite-backed lockout repository.
 *
 * Maintains two tables — `auth_lockout_attempts` (failed attempt counters) and
 * `auth_locked_accounts` (hard lock markers) — both created on first use.
 * Expired entries are purged inline during `getAttempts` and `isLocked` reads.
 *
 * @param db - The Bun SQLite database handle (`RuntimeSqliteDatabase`).
 * @returns A `LockoutRepository` backed by SQLite.
 *
 * @remarks
 * Both tables are auto-created on the first method call via a shared `init()` helper.
 *
 * @example
 * import { createSqliteLockoutRepository, createLockoutService } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const repo = createSqliteLockoutRepository(db);
 * const service = createLockoutService({ maxAttempts: 5, lockoutDuration: 900 }, repo);
 */
export function createSqliteLockoutRepository(db: RuntimeSqliteDatabase): LockoutRepository {
  const init = createSqliteInitializer(db, () => {
    db.run(`CREATE TABLE IF NOT EXISTS auth_lockout_attempts (
      subjectKey TEXT PRIMARY KEY,
      count      INTEGER NOT NULL,
      expiresAt  INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS auth_locked_accounts (
      subjectKey TEXT PRIMARY KEY,
      expiresAt  INTEGER NOT NULL
    )`);
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_auth_lockout_attempts_expiresAt ON auth_lockout_attempts(expiresAt)',
    );
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_auth_locked_accounts_expiresAt ON auth_locked_accounts(expiresAt)',
    );
  });

  return {
    async getAttempts(key) {
      init();
      const now = Date.now();
      const row = db
        .query('SELECT count FROM auth_lockout_attempts WHERE subjectKey = ? AND expiresAt > ?')
        .get(key, now) as { count: number } | null;
      if (row) return row.count;
      db.run('DELETE FROM auth_lockout_attempts WHERE subjectKey = ? AND expiresAt <= ?', key, now);
      return 0;
    },
    async setAttempts(key, count, ttlMs) {
      init();
      const expiresAt = Date.now() + ttlMs;
      db.run(
        `INSERT INTO auth_lockout_attempts (subjectKey, count, expiresAt)
         VALUES (?, ?, ?)
         ON CONFLICT(subjectKey) DO UPDATE SET count = excluded.count, expiresAt = excluded.expiresAt`,
        key,
        count,
        expiresAt,
      );
    },
    async deleteAttempts(key) {
      init();
      db.run('DELETE FROM auth_lockout_attempts WHERE subjectKey = ?', key);
    },
    async setLocked(key, ttlMs) {
      init();
      const expiresAt = Date.now() + ttlMs;
      db.run(
        `INSERT INTO auth_locked_accounts (subjectKey, expiresAt)
         VALUES (?, ?)
         ON CONFLICT(subjectKey) DO UPDATE SET expiresAt = excluded.expiresAt`,
        key,
        expiresAt,
      );
    },
    async isLocked(key) {
      init();
      const now = Date.now();
      const row = db
        .query('SELECT expiresAt FROM auth_locked_accounts WHERE subjectKey = ? AND expiresAt > ?')
        .get(key, now) as { expiresAt: number } | null;
      if (row) return true;
      db.run('DELETE FROM auth_locked_accounts WHERE subjectKey = ? AND expiresAt <= ?', key, now);
      return false;
    },
    async deleteLocked(key) {
      init();
      db.run('DELETE FROM auth_locked_accounts WHERE subjectKey = ?', key);
    },
  };
}

// ---------------------------------------------------------------------------
// Redis repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Redis-backed lockout repository.
 *
 * Uses two key namespaces per app: `lockout:attempts:<appName>:<key>` (plain string count
 * with Redis TTL) and `lockout:locked:<appName>:<key>` (presence-based lock flag).
 * All operations are single round-trips. No atomic `increment` — the service uses
 * `getAttempts` + `setAttempts` (acceptable for lockout; false negatives are harmless).
 *
 * @param getRedis - Factory function that returns the `RedisLike` client.
 * @param appName - Application name used as a Redis key namespace prefix.
 * @returns A `LockoutRepository` backed by Redis.
 *
 * @example
 * import { createRedisLockoutRepository, createLockoutService } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const repo = createRedisLockoutRepository(() => redisClient, 'my-app');
 * const service = createLockoutService({ maxAttempts: 5, lockoutDuration: 900 }, repo);
 */
export function createRedisLockoutRepository(
  getRedis: () => RedisLike,
  appName: string,
): LockoutRepository {
  const redis = getRedis();

  return {
    async getAttempts(key) {
      const raw = await redis.get(`lockout:attempts:${appName}:${key}`);
      if (!raw) return 0;
      const value = parseInt(raw, 10);
      return Number.isFinite(value) ? value : 0;
    },
    async setAttempts(key, count, ttlMs) {
      await redis.set(`lockout:attempts:${appName}:${key}`, String(count), 'PX', ttlMs);
    },
    async deleteAttempts(key) {
      await redis.del(`lockout:attempts:${appName}:${key}`);
    },
    async setLocked(key, ttlMs) {
      await redis.set(`lockout:locked:${appName}:${key}`, '1', 'PX', ttlMs);
    },
    async isLocked(key) {
      const raw = await redis.get(`lockout:locked:${appName}:${key}`);
      return raw !== null;
    },
    async deleteLocked(key) {
      await redis.del(`lockout:locked:${appName}:${key}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Mongo repository factory
// ---------------------------------------------------------------------------

interface LockoutAttemptDoc {
  subjectKey: string;
  count: number;
  expiresAt: Date;
}

interface LockedAccountDoc {
  subjectKey: string;
  expiresAt: Date;
}

/**
 * Creates a MongoDB-backed lockout repository.
 *
 * Registers (or retrieves cached) `AuthLockoutAttempt` and `AuthLockedAccount` Mongoose
 * models on the provided connection. Both use MongoDB TTL indexes for automatic expiry.
 *
 * @param conn - The Mongoose `Connection` to register the models on.
 * @param mg - The `mongoose` module instance used for `Schema` construction.
 * @returns A `LockoutRepository` backed by MongoDB.
 *
 * @remarks
 * Collections `auth_lockout_attempts` and `auth_locked_accounts` are auto-created on the
 * first write to each model.
 *
 * @example
 * import { createMongoLockoutRepository, createLockoutService } from '@lastshotlabs/slingshot-auth/plugin';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const repo = createMongoLockoutRepository(conn, mongoose);
 * const service = createLockoutService({ maxAttempts: 5, lockoutDuration: 900 }, repo);
 */
export function createMongoLockoutRepository(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
): LockoutRepository {
  function getAttemptsModel(): import('mongoose').Model<LockoutAttemptDoc> {
    if ('AuthLockoutAttempt' in conn.models) {
      return conn.models[
        'AuthLockoutAttempt'
      ] as unknown as import('mongoose').Model<LockoutAttemptDoc>;
    }
    const { Schema } = mg;
    const schema = new Schema<LockoutAttemptDoc>(
      {
        subjectKey: { type: String, required: true, unique: true },
        count: { type: Number, required: true },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'auth_lockout_attempts' },
    );
    return conn.model('AuthLockoutAttempt', schema) as import('mongoose').Model<LockoutAttemptDoc>;
  }

  function getLockedModel(): import('mongoose').Model<LockedAccountDoc> {
    if ('AuthLockedAccount' in conn.models) {
      return conn.models[
        'AuthLockedAccount'
      ] as unknown as import('mongoose').Model<LockedAccountDoc>;
    }
    const { Schema } = mg;
    const schema = new Schema<LockedAccountDoc>(
      {
        subjectKey: { type: String, required: true, unique: true },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'auth_locked_accounts' },
    );
    return conn.model('AuthLockedAccount', schema) as import('mongoose').Model<LockedAccountDoc>;
  }

  return {
    async getAttempts(key) {
      const doc = await getAttemptsModel()
        .findOne({
          subjectKey: key,
          expiresAt: { $gt: new Date() },
        })
        .lean();
      return doc?.count ?? 0;
    },
    async setAttempts(key, count, ttlMs) {
      await getAttemptsModel().updateOne(
        { subjectKey: key },
        { $set: { count, expiresAt: new Date(Date.now() + ttlMs) } },
        { upsert: true },
      );
    },
    async deleteAttempts(key) {
      await getAttemptsModel().deleteOne({ subjectKey: key });
    },
    async setLocked(key, ttlMs) {
      await getLockedModel().updateOne(
        { subjectKey: key },
        { $set: { expiresAt: new Date(Date.now() + ttlMs) } },
        { upsert: true },
      );
    },
    async isLocked(key) {
      const doc = await getLockedModel()
        .findOne({
          subjectKey: key,
          expiresAt: { $gt: new Date() },
        })
        .lean();
      return doc !== null;
    },
    async deleteLocked(key) {
      await getLockedModel().deleteOne({ subjectKey: key });
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Postgres-backed lockout repository.
 *
 * Maintains two tables — `auth_lockout_attempts` and `auth_locked_accounts` — both
 * created on first use via `ensureTable`. All writes use `ON CONFLICT ... DO UPDATE`
 * for idempotent upserts. Expired rows are ignored by `expires_at > now` filters; they
 * are not reaped automatically.
 *
 * @param pool - The `pg.Pool` instance to use for queries.
 * @returns A `LockoutRepository` backed by Postgres.
 *
 * @example
 * import { createPostgresLockoutRepository, createLockoutService } from '@lastshotlabs/slingshot-auth/plugin';
 * import { Pool } from 'pg';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const repo = createPostgresLockoutRepository(pool);
 * const service = createLockoutService({ maxAttempts: 5, lockoutDuration: 900 }, repo);
 */
export function createPostgresLockoutRepository(pool: import('pg').Pool): LockoutRepository {
  let tableReady = false;
  const ensureTable = async (): Promise<void> => {
    if (tableReady) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_lockout_attempts (
      subject_key TEXT PRIMARY KEY,
      count       INTEGER NOT NULL,
      expires_at  BIGINT NOT NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_locked_accounts (
      subject_key TEXT PRIMARY KEY,
      expires_at  BIGINT NOT NULL
    )`);
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_lockout_attempts_expires_at ON auth_lockout_attempts(expires_at)',
    );
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_locked_accounts_expires_at ON auth_locked_accounts(expires_at)',
    );
    tableReady = true;
  };

  return {
    async getAttempts(key) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ count: number }>(
        'SELECT count FROM auth_lockout_attempts WHERE subject_key = $1 AND expires_at > $2',
        [key, now],
      );
      return rows[0]?.count ?? 0;
    },
    async setAttempts(key, count, ttlMs) {
      await ensureTable();
      const expiresAt = Date.now() + ttlMs;
      await pool.query(
        `INSERT INTO auth_lockout_attempts (subject_key, count, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (subject_key) DO UPDATE SET
           count      = EXCLUDED.count,
           expires_at = EXCLUDED.expires_at`,
        [key, count, expiresAt],
      );
    },
    async deleteAttempts(key) {
      await ensureTable();
      await pool.query('DELETE FROM auth_lockout_attempts WHERE subject_key = $1', [key]);
    },
    async setLocked(key, ttlMs) {
      await ensureTable();
      const expiresAt = Date.now() + ttlMs;
      await pool.query(
        `INSERT INTO auth_locked_accounts (subject_key, expires_at)
         VALUES ($1, $2)
         ON CONFLICT (subject_key) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [key, expiresAt],
      );
    },
    async isLocked(key) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ subject_key: string }>(
        'SELECT subject_key FROM auth_locked_accounts WHERE subject_key = $1 AND expires_at > $2',
        [key, now],
      );
      return rows.length > 0;
    },
    async deleteLocked(key) {
      await ensureTable();
      await pool.query('DELETE FROM auth_locked_accounts WHERE subject_key = $1', [key]);
    },
  };
}

export const lockoutRepositoryFactories: RepoFactories<LockoutRepository> = {
  memory: () => createMemoryLockoutRepository(),
  sqlite: infra => createSqliteLockoutRepository(infra.getSqliteDb()),
  redis: infra => createRedisLockoutRepository(infra.getRedis, infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoLockoutRepository(conn, mg);
  },
  postgres: infra => createPostgresLockoutRepository(infra.getPostgres().pool),
};

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

/**
 * Creates the account lockout service.
 *
 * Wraps a `LockoutRepository` with business logic for recording failed attempts,
 * checking lockout status, and managing account locks. The `lockoutDuration` from
 * `config` controls how long the lock persists; failure counters are stored with
 * a 2× TTL to survive the lockout window.
 *
 * @param config - Lockout policy (max attempts, duration, callback).
 * @param repo - The backing `LockoutRepository`.
 * @returns A `LockoutService` instance.
 *
 * @example
 * import { createMemoryLockoutRepository, createLockoutService } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const service = createLockoutService(
 *   { maxAttempts: 5, lockoutDuration: 900 },
 *   createMemoryLockoutRepository(),
 * );
 * const count = await service.recordFailedAttempt(userId);
 * if (count >= 5) await service.lockAccount(userId);
 */
export function createLockoutService(
  config: LockoutConfig,
  repo: LockoutRepository,
): LockoutService {
  return {
    config,

    async recordFailedAttempt(userId: string): Promise<number> {
      const ttlMs = config.lockoutDuration * 2 * 1000;
      const current = await repo.getAttempts(userId);
      const next = current + 1;
      await repo.setAttempts(userId, next, ttlMs);
      return next;
    },

    async isAccountLocked(userId: string): Promise<boolean> {
      return repo.isLocked(userId);
    },

    async lockAccount(userId: string): Promise<void> {
      await repo.setLocked(userId, config.lockoutDuration * 1000);
    },

    async unlockAccount(userId: string): Promise<void> {
      await repo.deleteLocked(userId);
      await repo.deleteAttempts(userId);
    },

    async resetFailureCount(userId: string): Promise<void> {
      await repo.deleteAttempts(userId);
    },
  };
}
