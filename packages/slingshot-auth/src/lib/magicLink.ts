 
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
import type { RedisLike } from '../types/redis';

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for magic link tokens.
 *
 * Magic link tokens are single-use — `consume` returns the associated user ID and
 * deletes the token atomically. Tokens are hashed (SHA-256) before storage so the
 * plain token only exists in the email sent to the user.
 */
export interface MagicLinkRepository {
  store(hash: string, userId: string, ttl: number): Promise<void>;
  consume(hash: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Memory repository factory
// ---------------------------------------------------------------------------

interface MemoryMagicLinkEntry {
  userId: string;
  expiresAt: number;
}

/**
 * Creates an in-memory magic link token repository.
 *
 * Tokens are stored in a `Map` with epoch-ms expiry. Expired entries are swept on
 * `store`. Each call returns an independent instance. Suitable for testing.
 *
 * @returns A `MagicLinkRepository` backed by an in-memory `Map`.
 *
 * @example
 * import { createMemoryMagicLinkRepository } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const magicLinkRepo = createMemoryMagicLinkRepository();
 */
export function createMemoryMagicLinkRepository(): MagicLinkRepository {
  const tokens = new Map<string, MemoryMagicLinkEntry>();
  const evictExpired = createEvictExpired();

  return {
    async store(hash, userId, ttl) {
      evictExpired(tokens);
      evictOldest(tokens, DEFAULT_MAX_ENTRIES);
      tokens.set(hash, { userId, expiresAt: Date.now() + ttl * 1000 });
    },
    async consume(hash) {
      const entry = tokens.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        tokens.delete(hash);
        return null;
      }
      tokens.delete(hash);
      return entry.userId;
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite-backed magic link token repository.
 *
 * The `auth_magic_links` table is created on first use (lazy init, idempotent).
 * `consume` uses `DELETE ... RETURNING` for atomic read-and-delete.
 *
 * @param db - The Bun SQLite database handle (`RuntimeSqliteDatabase`).
 * @returns A `MagicLinkRepository` backed by SQLite.
 *
 * @remarks
 * The table is auto-created on the first call to any method.
 *
 * @example
 * import { createSqliteMagicLinkRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const magicLinkRepo = createSqliteMagicLinkRepository(db);
 */
export function createSqliteMagicLinkRepository(db: RuntimeSqliteDatabase): MagicLinkRepository {
  let initialized = false;

  function init(): void {
    if (initialized) return;
    db.run(`CREATE TABLE IF NOT EXISTS auth_magic_links (
      tokenHash TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_auth_magic_links_expiresAt ON auth_magic_links(expiresAt)',
    );
    initialized = true;
  }

  return {
    async store(hash, userId, ttl) {
      init();
      const expiresAt = Date.now() + ttl * 1000;
      db.run(
        `INSERT INTO auth_magic_links (tokenHash, userId, expiresAt)
         VALUES (?, ?, ?)
         ON CONFLICT(tokenHash) DO UPDATE SET userId = excluded.userId, expiresAt = excluded.expiresAt`,
        hash,
        userId,
        expiresAt,
      );
    },
    async consume(hash) {
      init();
      const now = Date.now();
      const row = db
        .query(
          'DELETE FROM auth_magic_links WHERE tokenHash = ? AND expiresAt > ? RETURNING userId',
        )
        .get(hash, now) as { userId: string } | null;
      if (!row) return null;
      return row.userId;
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
 * Creates a Redis-backed magic link token repository.
 *
 * Keys are namespaced as `magiclink:<appName>:<hash>` with a Redis `EX` TTL. The user ID
 * is stored as a raw string value. `consume` uses an atomic `GETDEL` (Redis >= 6.2) with
 * a Lua fallback for older Redis versions.
 *
 * @param getRedis - Factory function that returns the `RedisLike` client.
 * @param appName - Application name used as a Redis key namespace prefix.
 * @returns A `MagicLinkRepository` backed by Redis.
 *
 * @example
 * import { createRedisMagicLinkRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const magicLinkRepo = createRedisMagicLinkRepository(() => redisClient, 'my-app');
 */
export function createRedisMagicLinkRepository(
  getRedis: () => RedisLike,
  appName: string,
): MagicLinkRepository {
  return {
    async store(hash, userId, ttl) {
      await getRedis().set(`magiclink:${appName}:${hash}`, userId, 'EX', ttl);
    },
    async consume(hash) {
      const userId = await redisGetDel(getRedis(), `magiclink:${appName}:${hash}`);
      return userId ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Mongo repository factory
// ---------------------------------------------------------------------------

interface MagicLinkDoc {
  token: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Creates a MongoDB-backed magic link token repository.
 *
 * Registers (or retrieves a cached) `MagicLink` Mongoose model. Documents expire via a
 * MongoDB TTL index on `expiresAt`. `consume` uses `findOneAndDelete` for atomic
 * read-and-delete.
 *
 * @param conn - The Mongoose `Connection` to register the model on.
 * @param mg - The `mongoose` module instance used for `Schema` construction.
 * @returns A `MagicLinkRepository` backed by MongoDB.
 *
 * @remarks
 * The collection `magic_links` is auto-created on the first write.
 *
 * @example
 * import { createMongoMagicLinkRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const magicLinkRepo = createMongoMagicLinkRepository(conn, mongoose);
 */
export function createMongoMagicLinkRepository(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
): MagicLinkRepository {
  function getModel(): import('mongoose').Model<MagicLinkDoc> {
    if ('MagicLink' in conn.models)
      return conn.models['MagicLink'] as unknown as import('mongoose').Model<MagicLinkDoc>;
    const { Schema } = mg;
    const magicLinkSchema = new Schema<MagicLinkDoc>(
      {
        token: { type: String, required: true, unique: true },
        userId: { type: String, required: true },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'magic_links' },
    );
    return conn.model('MagicLink', magicLinkSchema);
  }

  return {
    async store(hash, userId, ttl) {
      await getModel().create({
        token: hash,
        userId,
        expiresAt: new Date(Date.now() + ttl * 1000),
      });
    },
    async consume(hash) {
      const doc = await getModel()
        .findOneAndDelete({ token: hash, expiresAt: { $gt: new Date() } })
        .lean();
      if (!doc) return null;
      return doc.userId;
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Postgres-backed magic link token repository.
 *
 * The `auth_magic_links` table is created on first use (lazy `ensureTable`, idempotent).
 * `consume` uses `DELETE ... RETURNING` for atomic read-and-delete.
 *
 * @param pool - The `pg.Pool` instance to use for queries.
 * @returns A `MagicLinkRepository` backed by Postgres.
 *
 * @remarks
 * The table is auto-created on the first method call.
 *
 * @example
 * import { createPostgresMagicLinkRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import { Pool } from 'pg';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const magicLinkRepo = createPostgresMagicLinkRepository(pool);
 */
export function createPostgresMagicLinkRepository(pool: import('pg').Pool): MagicLinkRepository {
  let tableReady = false;
  const ensureTable = async (): Promise<void> => {
    if (tableReady) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_magic_links (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    )`);
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_magic_links_expires_at ON auth_magic_links(expires_at)',
    );
    tableReady = true;
  };

  return {
    async store(hash, userId, ttl) {
      await ensureTable();
      const expiresAt = Date.now() + ttl * 1000;
      await pool.query(
        `INSERT INTO auth_magic_links (token_hash, user_id, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (token_hash) DO UPDATE SET
           user_id    = EXCLUDED.user_id,
           expires_at = EXCLUDED.expires_at`,
        [hash, userId, expiresAt],
      );
    },
    async consume(hash) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ user_id: string }>(
        `DELETE FROM auth_magic_links
         WHERE token_hash = $1 AND expires_at > $2
         RETURNING user_id`,
        [hash, now],
      );
      if (!rows[0]) return null;
      return rows[0].user_id;
    },
  };
}

export const magicLinkFactories: RepoFactories<MagicLinkRepository> = {
  memory: () => createMemoryMagicLinkRepository(),
  sqlite: infra => createSqliteMagicLinkRepository(infra.getSqliteDb()),
  redis: infra => createRedisMagicLinkRepository(infra.getRedis, infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoMagicLinkRepository(conn, mg);
  },
  postgres: infra => createPostgresMagicLinkRepository(infra.getPostgres().pool),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_MAGIC_LINK_TTL = 60 * 15; // 15 minutes

export const createMagicLinkToken = async (
  repo: MagicLinkRepository,
  userId: string,
  ttlSeconds?: number,
): Promise<string> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Buffer.from(bytes).toString('base64url');
  const hash = sha256(token);
  const ttl = ttlSeconds ?? DEFAULT_MAGIC_LINK_TTL;
  await repo.store(hash, userId, ttl);
  return token;
};

export const consumeMagicLinkToken = async (
  repo: MagicLinkRepository,
  token: string,
): Promise<string | null> => {
  const hash = sha256(token);
  return repo.consume(hash);
};
