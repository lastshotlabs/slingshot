 
import {
  DEFAULT_MAX_ENTRIES,
  createEvictExpired,
  evictOldest,
  sha256,
} from '@lastshotlabs/slingshot-core';
// ---------------------------------------------------------------------------
// Factory map — add new store types here
// ---------------------------------------------------------------------------

import type { RepoFactories, RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import type { AuthResolvedConfig } from '../config/authConfig';
import type { RedisLike } from '../types/redis';

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for email verification tokens.
 *
 * Verification tokens are created when a user registers (if `emailVerification` is
 * configured) or requests a resend. `consume` is the primary access method — it reads
 * and deletes the token atomically. `get` + `delete` is available for two-step flows
 * that need to inspect the token before consuming it.
 *
 * Tokens are hashed (SHA-256) before storage.
 */
export interface VerificationTokenRepository {
  create(hash: string, userId: string, email: string, ttl: number): Promise<void>;
  get(hash: string): Promise<{ userId: string; email: string } | null>;
  delete(hash: string): Promise<void>;
  consume(hash: string): Promise<{ userId: string; email: string } | null>;
}

// ---------------------------------------------------------------------------
// Memory repository factory
// ---------------------------------------------------------------------------

interface MemoryVerificationEntry {
  userId: string;
  email: string;
  expiresAt: number;
}

/**
 * Creates an in-memory email verification token repository.
 *
 * Tokens are stored in a `Map` with epoch-ms expiry. Expired entries are swept on
 * `create`. Each call returns an independent instance. Suitable for testing.
 *
 * @returns A `VerificationTokenRepository` backed by an in-memory `Map`.
 *
 * @example
 * import { createMemoryVerificationTokenRepository } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const verificationRepo = createMemoryVerificationTokenRepository();
 */
export function createMemoryVerificationTokenRepository(): VerificationTokenRepository {
  const tokens = new Map<string, MemoryVerificationEntry>();
  const evictExpired = createEvictExpired();

  return {
    async create(hash, userId, email, ttl) {
      evictExpired(tokens);
      evictOldest(tokens, DEFAULT_MAX_ENTRIES);
      tokens.set(hash, { userId, email, expiresAt: Date.now() + ttl * 1000 });
    },
    async get(hash) {
      const entry = tokens.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        tokens.delete(hash);
        return null;
      }
      return { userId: entry.userId, email: entry.email };
    },
    async delete(hash) {
      tokens.delete(hash);
    },
    async consume(hash) {
      const entry = tokens.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        tokens.delete(hash);
        return null;
      }
      tokens.delete(hash);
      return { userId: entry.userId, email: entry.email };
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite-backed email verification token repository.
 *
 * The `auth_verification_tokens` table is created on first use (lazy init, idempotent).
 * Tokens are stored as SHA-256 hashes with an epoch-ms `expiresAt`. Expired tokens are
 * filtered by `expiresAt > now` on every read.
 *
 * @param db - The Bun SQLite database handle (`RuntimeSqliteDatabase`).
 * @returns A `VerificationTokenRepository` backed by SQLite.
 *
 * @remarks
 * The table is auto-created on the first call to any method.
 *
 * @example
 * import { createSqliteVerificationTokenRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const verificationRepo = createSqliteVerificationTokenRepository(db);
 */
export function createSqliteVerificationTokenRepository(
  db: RuntimeSqliteDatabase,
): VerificationTokenRepository {
  let initialized = false;

  function init(): void {
    if (initialized) return;
    db.run(`CREATE TABLE IF NOT EXISTS auth_verification_tokens (
      tokenHash TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      email     TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_auth_verification_tokens_expiresAt ON auth_verification_tokens(expiresAt)',
    );
    initialized = true;
  }

  return {
    async create(hash, userId, email, ttl) {
      init();
      const expiresAt = Date.now() + ttl * 1000;
      db.run(
        `INSERT INTO auth_verification_tokens (tokenHash, userId, email, expiresAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tokenHash) DO UPDATE SET userId = excluded.userId, email = excluded.email, expiresAt = excluded.expiresAt`,
        hash,
        userId,
        email,
        expiresAt,
      );
    },
    async get(hash) {
      init();
      const now = Date.now();
      const row = db
        .query(
          'SELECT userId, email FROM auth_verification_tokens WHERE tokenHash = ? AND expiresAt > ?',
        )
        .get(hash, now) as { userId: string; email: string } | null;
      return row ? { userId: row.userId, email: row.email } : null;
    },
    async delete(hash) {
      init();
      db.run('DELETE FROM auth_verification_tokens WHERE tokenHash = ?', hash);
    },
    async consume(hash) {
      init();
      const now = Date.now();
      const row = db
        .query(
          'DELETE FROM auth_verification_tokens WHERE tokenHash = ? AND expiresAt > ? RETURNING userId, email',
        )
        .get(hash, now) as { userId: string; email: string } | null;
      if (!row) return null;
      return { userId: row.userId, email: row.email };
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
 * Creates a Redis-backed email verification token repository.
 *
 * Keys are namespaced as `verify:<appName>:<hash>` with a Redis `EX` TTL. `consume` uses
 * an atomic `GETDEL` (Redis >= 6.2) with a Lua fallback for older versions.
 *
 * @param getRedis - Factory function that returns the `RedisLike` client.
 * @param appName - Application name used as a Redis key namespace prefix.
 * @returns A `VerificationTokenRepository` backed by Redis.
 *
 * @example
 * import { createRedisVerificationTokenRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const verificationRepo = createRedisVerificationTokenRepository(() => redisClient, 'my-app');
 */
export function createRedisVerificationTokenRepository(
  getRedis: () => RedisLike,
  appName: string,
): VerificationTokenRepository {
  return {
    async create(hash, userId, email, ttl) {
      await getRedis().set(
        `verify:${appName}:${hash}`,
        JSON.stringify({ userId, email }),
        'EX',
        ttl,
      );
    },
    async get(hash) {
      const raw = await getRedis().get(`verify:${appName}:${hash}`);
      if (!raw) return null;
      return JSON.parse(raw) as { userId: string; email: string };
    },
    async delete(hash) {
      await getRedis().del(`verify:${appName}:${hash}`);
    },
    async consume(hash) {
      const raw = await redisGetDel(getRedis(), `verify:${appName}:${hash}`);
      if (!raw) return null;
      return JSON.parse(raw) as { userId: string; email: string };
    },
  };
}

// ---------------------------------------------------------------------------
// Mongo repository factory
// ---------------------------------------------------------------------------

interface VerificationDoc {
  token: string;
  userId: string;
  email: string;
  expiresAt: Date;
}

/**
 * Creates a MongoDB-backed email verification token repository.
 *
 * Registers (or retrieves a cached) `EmailVerification` Mongoose model. Documents expire
 * via a MongoDB TTL index on `expiresAt`. `consume` uses `findOneAndDelete` for atomic
 * read-and-delete.
 *
 * @param conn - The Mongoose `Connection` to register the model on.
 * @param mg - The `mongoose` module instance used for `Schema` construction.
 * @returns A `VerificationTokenRepository` backed by MongoDB.
 *
 * @remarks
 * The collection `email_verifications` is auto-created on the first write.
 *
 * @example
 * import { createMongoVerificationTokenRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const verificationRepo = createMongoVerificationTokenRepository(conn, mongoose);
 */
export function createMongoVerificationTokenRepository(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
): VerificationTokenRepository {
  function getModel(): import('mongoose').Model<VerificationDoc> {
    if ('EmailVerification' in conn.models)
      return conn.models[
        'EmailVerification'
      ] as unknown as import('mongoose').Model<VerificationDoc>;
    const { Schema } = mg;
    const schema = new Schema<VerificationDoc>(
      {
        token: { type: String, required: true, unique: true },
        userId: { type: String, required: true },
        email: { type: String, required: true },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'email_verifications' },
    );
    return conn.model('EmailVerification', schema);
  }

  return {
    async create(hash, userId, email, ttl) {
      await getModel().create({
        token: hash,
        userId,
        email,
        expiresAt: new Date(Date.now() + ttl * 1000),
      });
    },
    async get(hash) {
      const doc = await getModel()
        .findOne({ token: hash, expiresAt: { $gt: new Date() } })
        .lean();
      if (!doc) return null;
      return { userId: doc.userId, email: doc.email };
    },
    async delete(hash) {
      await getModel().deleteOne({ token: hash });
    },
    async consume(hash) {
      const doc = await getModel()
        .findOneAndDelete({ token: hash, expiresAt: { $gt: new Date() } })
        .lean();
      if (!doc) return null;
      return { userId: doc.userId, email: doc.email };
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Postgres-backed email verification token repository.
 *
 * The `auth_verification_tokens` table is created on first use (lazy `ensureTable`,
 * idempotent). `consume` uses `DELETE ... RETURNING` for atomic read-and-delete.
 *
 * @param pool - The `pg.Pool` instance to use for queries.
 * @returns A `VerificationTokenRepository` backed by Postgres.
 *
 * @remarks
 * The table is auto-created on the first method call.
 *
 * @example
 * import { createPostgresVerificationTokenRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import { Pool } from 'pg';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const verificationRepo = createPostgresVerificationTokenRepository(pool);
 */
export function createPostgresVerificationTokenRepository(
  pool: import('pg').Pool,
): VerificationTokenRepository {
  let tableReady = false;
  const ensureTable = async (): Promise<void> => {
    if (tableReady) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_verification_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      email      TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    )`);
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_verification_tokens_expires_at ON auth_verification_tokens(expires_at)',
    );
    tableReady = true;
  };

  return {
    async create(hash, userId, email, ttl) {
      await ensureTable();
      const expiresAt = Date.now() + ttl * 1000;
      await pool.query(
        `INSERT INTO auth_verification_tokens (token_hash, user_id, email, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (token_hash) DO UPDATE SET
           user_id    = EXCLUDED.user_id,
           email      = EXCLUDED.email,
           expires_at = EXCLUDED.expires_at`,
        [hash, userId, email, expiresAt],
      );
    },
    async get(hash) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ user_id: string; email: string }>(
        'SELECT user_id, email FROM auth_verification_tokens WHERE token_hash = $1 AND expires_at > $2',
        [hash, now],
      );
      if (!rows[0]) return null;
      return { userId: rows[0].user_id, email: rows[0].email };
    },
    async delete(hash) {
      await ensureTable();
      await pool.query('DELETE FROM auth_verification_tokens WHERE token_hash = $1', [hash]);
    },
    async consume(hash) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ user_id: string; email: string }>(
        `DELETE FROM auth_verification_tokens
         WHERE token_hash = $1 AND expires_at > $2
         RETURNING user_id, email`,
        [hash, now],
      );
      if (!rows[0]) return null;
      return { userId: rows[0].user_id, email: rows[0].email };
    },
  };
}

export const verificationTokenFactories: RepoFactories<VerificationTokenRepository> = {
  memory: () => createMemoryVerificationTokenRepository(),
  sqlite: infra => createSqliteVerificationTokenRepository(infra.getSqliteDb()),
  redis: infra => createRedisVerificationTokenRepository(infra.getRedis, infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoVerificationTokenRepository(conn, mg);
  },
  postgres: infra => createPostgresVerificationTokenRepository(infra.getPostgres().pool),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const createVerificationToken = async (
  repo: VerificationTokenRepository,
  userId: string,
  email: string,
  config: AuthResolvedConfig,
): Promise<string> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Buffer.from(bytes).toString('base64url');
  const hash = sha256(token);
  const ttl = config.emailVerification?.tokenExpiry ?? 86400;
  await repo.create(hash, userId, email, ttl);
  return token;
};

export const getVerificationToken = async (
  repo: VerificationTokenRepository,
  token: string,
): Promise<{ userId: string; email: string } | null> => {
  const hash = sha256(token);
  return repo.get(hash);
};

export const deleteVerificationToken = async (
  repo: VerificationTokenRepository,
  token: string,
): Promise<void> => {
  const hash = sha256(token);
  await repo.delete(hash);
};

export const consumeVerificationToken = async (
  repo: VerificationTokenRepository,
  token: string,
): Promise<{ userId: string; email: string } | null> => {
  const hash = sha256(token);
  return repo.consume(hash);
};
