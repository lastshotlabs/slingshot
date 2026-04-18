/* eslint-disable @typescript-eslint/require-await */
import { DEFAULT_MAX_ENTRIES, createEvictExpired, evictOldest } from '@lastshotlabs/slingshot-core';
import { sha256 as hashToken } from '@lastshotlabs/slingshot-core';
// ---------------------------------------------------------------------------
// Factory map — add new store types here
// ---------------------------------------------------------------------------

import type { RepoFactories, RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import type { RedisLike } from '../types/redis';

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for queued account deletion cancel tokens.
 *
 * When account deletion is queued with a grace period, a cancel token is sent to the user.
 * `consume` atomically retrieves and deletes the token — if the token is valid, the caller
 * uses the returned `jobId` to cancel the scheduled BullMQ deletion job.
 */
export interface DeletionCancelTokenRepository {
  store(hash: string, userId: string, jobId: string, ttl: number): Promise<void>;
  consume(hash: string): Promise<{ userId: string; jobId: string } | null>;
}

// ---------------------------------------------------------------------------
// Memory repository factory
// ---------------------------------------------------------------------------

interface MemoryCancelEntry {
  userId: string;
  jobId: string;
  expiresAt: number;
}

/**
 * Creates an in-memory deletion cancel token repository.
 *
 * Tokens are stored in a `Map` with epoch-ms expiry. Each call returns an independent
 * instance with closure-owned state. Suitable for testing queued account deletion flows.
 *
 * @returns A `DeletionCancelTokenRepository` backed by an in-memory `Map`.
 *
 * @example
 * import { createMemoryDeletionCancelTokenRepository } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const cancelTokenRepo = createMemoryDeletionCancelTokenRepository();
 */
export function createMemoryDeletionCancelTokenRepository(): DeletionCancelTokenRepository {
  const tokens = new Map<string, MemoryCancelEntry>();
  const evictExpired = createEvictExpired();

  return {
    async store(hash, userId, jobId, ttl) {
      evictExpired(tokens);
      evictOldest(tokens, DEFAULT_MAX_ENTRIES);
      tokens.set(hash, { userId, jobId, expiresAt: Date.now() + ttl * 1000 });
    },
    async consume(hash) {
      const entry = tokens.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        tokens.delete(hash);
        return null;
      }
      tokens.delete(hash);
      return { userId: entry.userId, jobId: entry.jobId };
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite-backed deletion cancel token repository.
 *
 * The `auth_deletion_cancel_tokens` table is created on first use (lazy init, idempotent).
 * `consume` is implemented as a select + delete (not wrapped in an explicit transaction;
 * acceptable for single-writer SQLite).
 *
 * @param db - The Bun SQLite database handle (`RuntimeSqliteDatabase`).
 * @returns A `DeletionCancelTokenRepository` backed by SQLite.
 *
 * @remarks
 * The table is auto-created on the first call to any method.
 *
 * @example
 * import { createSqliteDeletionCancelTokenRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const cancelTokenRepo = createSqliteDeletionCancelTokenRepository(db);
 */
export function createSqliteDeletionCancelTokenRepository(
  db: RuntimeSqliteDatabase,
): DeletionCancelTokenRepository {
  let initialized = false;

  function init(): void {
    if (initialized) return;
    db.run(`CREATE TABLE IF NOT EXISTS auth_deletion_cancel_tokens (
      tokenHash TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      jobId     TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_auth_deletion_cancel_tokens_expiresAt ON auth_deletion_cancel_tokens(expiresAt)',
    );
    initialized = true;
  }

  return {
    async store(hash, userId, jobId, ttl) {
      init();
      const expiresAt = Date.now() + ttl * 1000;
      db.run(
        `INSERT INTO auth_deletion_cancel_tokens (tokenHash, userId, jobId, expiresAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tokenHash) DO UPDATE SET userId = excluded.userId, jobId = excluded.jobId, expiresAt = excluded.expiresAt`,
        hash,
        userId,
        jobId,
        expiresAt,
      );
    },
    async consume(hash) {
      init();
      const now = Date.now();
      const row = db
        .query(
          'SELECT userId, jobId FROM auth_deletion_cancel_tokens WHERE tokenHash = ? AND expiresAt > ?',
        )
        .get(hash, now) as { userId: string; jobId: string } | null;
      db.run('DELETE FROM auth_deletion_cancel_tokens WHERE tokenHash = ?', hash);
      if (!row) return null;
      return { userId: row.userId, jobId: row.jobId };
    },
  };
}

// ---------------------------------------------------------------------------
// Redis repository factory
// ---------------------------------------------------------------------------

/** Atomically GET+DEL a key. Uses native GETDEL (Redis >= 6.2) with a Lua fallback. */
async function redisGetDel(redis: RedisLike, key: string): Promise<string | null> {
  if (typeof redis.getdel === 'function') {
    try {
      return await redis.getdel(key);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (!/unknown command|ERR unknown command/i.test(msg)) throw err;
    }
  }
  const result = await redis.eval(
    "local v = redis.call('GET', KEYS[1])\nif v then redis.call('DEL', KEYS[1]) end\nreturn v",
    1,
    key,
  );
  return (result as string | null) ?? null;
}

/**
 * Creates a Redis-backed deletion cancel token repository.
 *
 * Keys are namespaced as `delcancel:<appName>:<hash>` with a Redis `EX` TTL. The payload
 * (`{ userId, jobId }`) is stored as JSON. `consume` uses an atomic `GETDEL` (Redis >= 6.2)
 * with a Lua fallback for older Redis versions.
 *
 * @param getRedis - Factory function that returns the `RedisLike` client.
 * @param appName - Application name used as a Redis key namespace prefix.
 * @returns A `DeletionCancelTokenRepository` backed by Redis.
 *
 * @example
 * import { createRedisDeletionCancelTokenRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const cancelTokenRepo = createRedisDeletionCancelTokenRepository(() => redisClient, 'my-app');
 */
export function createRedisDeletionCancelTokenRepository(
  getRedis: () => RedisLike,
  appName: string,
): DeletionCancelTokenRepository {
  return {
    async store(hash, userId, jobId, ttl) {
      await getRedis().set(
        `delcancel:${appName}:${hash}`,
        JSON.stringify({ userId, jobId }),
        'EX',
        ttl,
      );
    },
    async consume(hash) {
      const raw = await redisGetDel(getRedis(), `delcancel:${appName}:${hash}`);
      if (!raw) return null;
      return JSON.parse(raw) as { userId: string; jobId: string };
    },
  };
}

// ---------------------------------------------------------------------------
// Mongo repository factory
// ---------------------------------------------------------------------------

interface DeletionCancelDoc {
  token: string;
  userId: string;
  jobId: string;
  expiresAt: Date;
}

/**
 * Creates a MongoDB-backed deletion cancel token repository.
 *
 * Registers (or retrieves a cached) `DeletionCancelToken` Mongoose model. Documents expire
 * via a MongoDB TTL index on `expiresAt`. `consume` uses `findOneAndDelete` for atomic
 * read-and-delete.
 *
 * @param conn - The Mongoose `Connection` to register the model on.
 * @param mg - The `mongoose` module instance used for `Schema` construction.
 * @returns A `DeletionCancelTokenRepository` backed by MongoDB.
 *
 * @remarks
 * The collection `deletion_cancel_tokens` is auto-created on the first write.
 *
 * @example
 * import { createMongoDeletionCancelTokenRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const cancelTokenRepo = createMongoDeletionCancelTokenRepository(conn, mongoose);
 */
export function createMongoDeletionCancelTokenRepository(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
): DeletionCancelTokenRepository {
  function getModel(): import('mongoose').Model<DeletionCancelDoc> {
    if ('DeletionCancelToken' in conn.models)
      return conn.models[
        'DeletionCancelToken'
      ] as unknown as import('mongoose').Model<DeletionCancelDoc>;
    const { Schema } = mg;
    const schema = new Schema<DeletionCancelDoc>(
      {
        token: { type: String, required: true, unique: true },
        userId: { type: String, required: true },
        jobId: { type: String, required: true },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'deletion_cancel_tokens' },
    );
    return conn.model('DeletionCancelToken', schema);
  }

  return {
    async store(hash, userId, jobId, ttl) {
      await getModel().create({
        token: hash,
        userId,
        jobId,
        expiresAt: new Date(Date.now() + ttl * 1000),
      });
    },
    async consume(hash) {
      const doc = await getModel()
        .findOneAndDelete({ token: hash, expiresAt: { $gt: new Date() } })
        .lean();
      if (!doc) return null;
      return { userId: doc.userId, jobId: doc.jobId };
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Postgres-backed deletion cancel token repository.
 *
 * The `auth_deletion_cancel_tokens` table is created on first use (lazy `ensureTable`,
 * idempotent). `consume` uses `DELETE ... RETURNING` for atomic read-and-delete.
 *
 * @param pool - The `pg.Pool` instance to use for queries.
 * @returns A `DeletionCancelTokenRepository` backed by Postgres.
 *
 * @remarks
 * The table is auto-created on the first method call.
 *
 * @example
 * import { createPostgresDeletionCancelTokenRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import { Pool } from 'pg';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const cancelTokenRepo = createPostgresDeletionCancelTokenRepository(pool);
 */
export function createPostgresDeletionCancelTokenRepository(
  pool: import('pg').Pool,
): DeletionCancelTokenRepository {
  let tableReady = false;
  const ensureTable = async (): Promise<void> => {
    if (tableReady) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_deletion_cancel_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      job_id     TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    )`);
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_deletion_cancel_tokens_expires_at ON auth_deletion_cancel_tokens(expires_at)',
    );
    tableReady = true;
  };

  return {
    async store(hash, userId, jobId, ttl) {
      await ensureTable();
      const expiresAt = Date.now() + ttl * 1000;
      await pool.query(
        `INSERT INTO auth_deletion_cancel_tokens (token_hash, user_id, job_id, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (token_hash) DO UPDATE SET
           user_id    = EXCLUDED.user_id,
           job_id     = EXCLUDED.job_id,
           expires_at = EXCLUDED.expires_at`,
        [hash, userId, jobId, expiresAt],
      );
    },
    async consume(hash) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ user_id: string; job_id: string }>(
        `DELETE FROM auth_deletion_cancel_tokens
         WHERE token_hash = $1 AND expires_at > $2
         RETURNING user_id, job_id`,
        [hash, now],
      );
      if (!rows[0]) return null;
      return { userId: rows[0].user_id, jobId: rows[0].job_id };
    },
  };
}

export const deletionCancelTokenFactories: RepoFactories<DeletionCancelTokenRepository> = {
  memory: () => createMemoryDeletionCancelTokenRepository(),
  sqlite: infra => createSqliteDeletionCancelTokenRepository(infra.getSqliteDb()),
  redis: infra => createRedisDeletionCancelTokenRepository(infra.getRedis, infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoDeletionCancelTokenRepository(conn, mg);
  },
  postgres: infra => createPostgresDeletionCancelTokenRepository(infra.getPostgres().pool),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const createDeletionCancelToken = async (
  repo: DeletionCancelTokenRepository,
  userId: string,
  jobId: string,
  gracePeriodSeconds: number,
): Promise<string> => {
  const token = crypto.randomUUID();
  const hash = hashToken(token);
  const ttl = gracePeriodSeconds + 300;
  await repo.store(hash, userId, jobId, ttl);
  return token;
};

export const consumeDeletionCancelToken = async (
  repo: DeletionCancelTokenRepository,
  token: string,
): Promise<{ userId: string; jobId: string } | null> => {
  const hash = hashToken(token);
  return repo.consume(hash);
};
