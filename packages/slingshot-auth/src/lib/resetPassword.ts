 
import {
  DEFAULT_MAX_ENTRIES,
  createEvictExpired,
  evictOldest,
  sha256 as hashToken,
} from '@lastshotlabs/slingshot-core';
// ---------------------------------------------------------------------------
// Factory map — add new store types here
// ---------------------------------------------------------------------------

import type { RepoFactories, RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import type { AuthResolvedConfig } from '../config/authConfig';
import { createPostgresInitializer } from './postgresInit';
import { createSqliteInitializer } from './sqliteInit';
import type { RedisLike } from '../types/redis';

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for password reset tokens.
 *
 * Reset tokens are single-use — `consume` reads and deletes atomically. Tokens are
 * hashed (SHA-256) before storage; the plain token is sent to the user's email only.
 * Default TTL is 3600s (1 hour), configurable via `auth.passwordReset.tokenExpiry`.
 */
export interface ResetTokenRepository {
  create(hash: string, userId: string, email: string, ttl: number): Promise<void>;
  consume(hash: string): Promise<{ userId: string; email: string } | null>;
}

// ---------------------------------------------------------------------------
// Memory repository factory
// ---------------------------------------------------------------------------

interface MemoryResetEntry {
  userId: string;
  email: string;
  expiresAt: number;
}

/**
 * Creates an in-memory password reset token repository.
 *
 * Tokens are stored in a `Map` with epoch-ms expiry. Expired entries are swept on
 * `create`. Each call returns an independent instance. Suitable for testing.
 *
 * @returns A `ResetTokenRepository` backed by an in-memory `Map`.
 *
 * @example
 * import { createMemoryResetTokenRepository } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const resetTokenRepo = createMemoryResetTokenRepository();
 */
export function createMemoryResetTokenRepository(): ResetTokenRepository {
  const tokens = new Map<string, MemoryResetEntry>();
  const evictExpired = createEvictExpired();

  return {
    async create(hash, userId, email, ttl) {
      evictExpired(tokens);
      evictOldest(tokens, DEFAULT_MAX_ENTRIES);
      tokens.set(hash, { userId, email, expiresAt: Date.now() + ttl * 1000 });
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
 * Creates a SQLite-backed password reset token repository.
 *
 * The `auth_reset_tokens` table is created on first use (lazy init, idempotent).
 * `consume` uses `DELETE ... RETURNING` for atomic read-and-delete.
 *
 * @param db - The Bun SQLite database handle (`RuntimeSqliteDatabase`).
 * @returns A `ResetTokenRepository` backed by SQLite.
 *
 * @remarks
 * The table is auto-created on the first call to any method.
 *
 * @example
 * import { createSqliteResetTokenRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const resetTokenRepo = createSqliteResetTokenRepository(db);
 */
export function createSqliteResetTokenRepository(db: RuntimeSqliteDatabase): ResetTokenRepository {
  const init = createSqliteInitializer(db, () => {
    db.run(`CREATE TABLE IF NOT EXISTS auth_reset_tokens (
      tokenHash TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      email     TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_auth_reset_tokens_expiresAt ON auth_reset_tokens(expiresAt)',
    );
  });

  return {
    async create(hash, userId, email, ttl) {
      init();
      const expiresAt = Date.now() + ttl * 1000;
      db.run(
        `INSERT INTO auth_reset_tokens (tokenHash, userId, email, expiresAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tokenHash) DO UPDATE SET userId = excluded.userId, email = excluded.email, expiresAt = excluded.expiresAt`,
        hash,
        userId,
        email,
        expiresAt,
      );
    },
    async consume(hash) {
      init();
      const now = Date.now();
      const row = db
        .query(
          'DELETE FROM auth_reset_tokens WHERE tokenHash = ? AND expiresAt > ? RETURNING userId, email',
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
 * Creates a Redis-backed password reset token repository.
 *
 * Keys are namespaced as `reset:<appName>:<hash>` with a Redis `EX` TTL. The payload
 * (`{ userId, email }`) is stored as JSON. `consume` uses an atomic `GETDEL` (Redis >= 6.2)
 * with a Lua fallback for older Redis versions.
 *
 * @param getRedis - Factory function that returns the `RedisLike` client.
 * @param appName - Application name used as a Redis key namespace prefix.
 * @returns A `ResetTokenRepository` backed by Redis.
 *
 * @example
 * import { createRedisResetTokenRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const resetTokenRepo = createRedisResetTokenRepository(() => redisClient, 'my-app');
 */
export function createRedisResetTokenRepository(
  getRedis: () => RedisLike,
  appName: string,
): ResetTokenRepository {
  return {
    async create(hash, userId, email, ttl) {
      await getRedis().set(
        `reset:${appName}:${hash}`,
        JSON.stringify({ userId, email }),
        'EX',
        ttl,
      );
    },
    async consume(hash) {
      const raw = await redisGetDel(getRedis(), `reset:${appName}:${hash}`);
      if (!raw) return null;
      return JSON.parse(raw) as { userId: string; email: string };
    },
  };
}

// ---------------------------------------------------------------------------
// Mongo repository factory
// ---------------------------------------------------------------------------

interface ResetDoc {
  token: string;
  userId: string;
  email: string;
  expiresAt: Date;
}

/**
 * Creates a MongoDB-backed password reset token repository.
 *
 * Registers (or retrieves a cached) `PasswordReset` Mongoose model. Documents expire via
 * a MongoDB TTL index on `expiresAt`. `consume` uses `findOneAndDelete` for atomic
 * read-and-delete.
 *
 * @param conn - The Mongoose `Connection` to register the model on.
 * @param mg - The `mongoose` module instance used for `Schema` construction.
 * @returns A `ResetTokenRepository` backed by MongoDB.
 *
 * @remarks
 * The collection `password_resets` is auto-created on the first write.
 *
 * @example
 * import { createMongoResetTokenRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const resetTokenRepo = createMongoResetTokenRepository(conn, mongoose);
 */
export function createMongoResetTokenRepository(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
): ResetTokenRepository {
  function getModel(): import('mongoose').Model<ResetDoc> {
    if ('PasswordReset' in conn.models)
      return conn.models['PasswordReset'] as unknown as import('mongoose').Model<ResetDoc>;
    const { Schema } = mg;
    const schema = new Schema<ResetDoc>(
      {
        token: { type: String, required: true, unique: true },
        userId: { type: String, required: true },
        email: { type: String, required: true },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'password_resets' },
    );
    return conn.model('PasswordReset', schema);
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
 * Creates a Postgres-backed password reset token repository.
 *
 * The `auth_reset_tokens` table is created on first use (lazy `ensureTable`, idempotent).
 * `consume` uses `DELETE ... RETURNING` for atomic read-and-delete.
 *
 * @param pool - The `pg.Pool` instance to use for queries.
 * @returns A `ResetTokenRepository` backed by Postgres.
 *
 * @remarks
 * The table is auto-created on the first method call.
 *
 * @example
 * import { createPostgresResetTokenRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import { Pool } from 'pg';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const resetTokenRepo = createPostgresResetTokenRepository(pool);
 */
export function createPostgresResetTokenRepository(pool: import('pg').Pool): ResetTokenRepository {
  const ensureTable = createPostgresInitializer(pool, async client => {
    await client.query(`CREATE TABLE IF NOT EXISTS auth_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      email      TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    )`);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_reset_tokens_expires_at ON auth_reset_tokens(expires_at)',
    );
  });

  return {
    async create(hash, userId, email, ttl) {
      await ensureTable();
      const expiresAt = Date.now() + ttl * 1000;
      await pool.query(
        `INSERT INTO auth_reset_tokens (token_hash, user_id, email, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (token_hash) DO UPDATE SET
           user_id    = EXCLUDED.user_id,
           email      = EXCLUDED.email,
           expires_at = EXCLUDED.expires_at`,
        [hash, userId, email, expiresAt],
      );
    },
    async consume(hash) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ user_id: string; email: string }>(
        `DELETE FROM auth_reset_tokens
         WHERE token_hash = $1 AND expires_at > $2
         RETURNING user_id, email`,
        [hash, now],
      );
      if (!rows[0]) return null;
      return { userId: rows[0].user_id, email: rows[0].email };
    },
  };
}

export const resetTokenFactories: RepoFactories<ResetTokenRepository> = {
  memory: () => createMemoryResetTokenRepository(),
  sqlite: infra => createSqliteResetTokenRepository(infra.getSqliteDb()),
  redis: infra => createRedisResetTokenRepository(infra.getRedis, infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoResetTokenRepository(conn, mg);
  },
  postgres: infra => createPostgresResetTokenRepository(infra.getPostgres().pool),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const createResetToken = async (
  repo: ResetTokenRepository,
  userId: string,
  email: string,
  config: AuthResolvedConfig,
): Promise<string> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Buffer.from(bytes).toString('base64url');
  const hash = hashToken(token);
  const ttl = config.passwordReset?.tokenExpiry ?? 3600;
  await repo.create(hash, userId, email, ttl);
  return token;
};

export const consumeResetToken = async (
  repo: ResetTokenRepository,
  token: string,
): Promise<{ userId: string; email: string } | null> => {
  const hash = hashToken(token);
  return repo.consume(hash);
};
