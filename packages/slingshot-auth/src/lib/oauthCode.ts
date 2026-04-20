import {
  DEFAULT_MAX_ENTRIES,
  createEvictExpired,
  decryptField,
  encryptField,
  evictOldest,
  isEncryptedField,
  sha256,
} from '@lastshotlabs/slingshot-core';
// ---------------------------------------------------------------------------
// Factory map — add new store types here
// ---------------------------------------------------------------------------

import type { RepoFactories, RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import type { OAuthCodePayload } from '../types/oauthCode';
import type { RedisLike } from '../types/redis';
import { createPostgresInitializer } from './postgresInit';
import { createSqliteInitializer } from './sqliteInit';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { OAuthCodePayload } from '../types/oauthCode';

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for OAuth authorization codes.
 *
 * Authorization codes are short-lived (60 seconds), single-use tokens that bridge the
 * OAuth redirect and the token exchange step. Only the SHA-256 hash is stored;
 * sensitive payload fields may be encrypted at rest via `storeOAuthCode`.
 */
export interface OAuthCodeRepository {
  store(hash: string, payload: OAuthCodePayload, ttl: number): Promise<void>;
  consume(hash: string): Promise<OAuthCodePayload | null>;
}

// ---------------------------------------------------------------------------
// Memory repository factory
// ---------------------------------------------------------------------------

interface MemoryOAuthCodeEntry {
  payload: OAuthCodePayload;
  expiresAt: number;
}

/**
 * Creates an in-memory OAuth code repository.
 *
 * Entries expire after `ttl` seconds. Expired entries are swept opportunistically on
 * `store`. Each call returns an independent instance. Suitable for testing.
 *
 * @returns An `OAuthCodeRepository` backed by an in-memory `Map`.
 *
 * @example
 * import { createMemoryOAuthCodeRepository } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const codeRepo = createMemoryOAuthCodeRepository();
 */
export function createMemoryOAuthCodeRepository(): OAuthCodeRepository {
  const codes = new Map<string, MemoryOAuthCodeEntry>();
  const evictExpired = createEvictExpired();

  return {
    async store(hash, payload, ttl) {
      evictExpired(codes);
      evictOldest(codes, DEFAULT_MAX_ENTRIES);
      codes.set(hash, { payload, expiresAt: Date.now() + ttl * 1000 });
    },
    async consume(hash) {
      const entry = codes.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        codes.delete(hash);
        return null;
      }
      codes.delete(hash);
      return entry.payload;
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite-backed OAuth authorization code repository.
 *
 * The `auth_oauth_codes` table is created on first use (lazy init, idempotent).
 * Payloads are stored as JSON. `consume` uses `DELETE ... RETURNING` for atomic
 * read-and-delete.
 *
 * @param db - The Bun SQLite database handle (`RuntimeSqliteDatabase`).
 * @returns An `OAuthCodeRepository` backed by SQLite.
 *
 * @remarks
 * The table is auto-created on the first call to any method.
 *
 * @example
 * import { createSqliteOAuthCodeRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const codeRepo = createSqliteOAuthCodeRepository(db);
 */
export function createSqliteOAuthCodeRepository(db: RuntimeSqliteDatabase): OAuthCodeRepository {
  const init = createSqliteInitializer(db, () => {
    db.run(`CREATE TABLE IF NOT EXISTS auth_oauth_codes (
      codeHash     TEXT PRIMARY KEY,
      payload      TEXT NOT NULL,
      expiresAt    INTEGER NOT NULL
    )`);
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_auth_oauth_codes_expiresAt ON auth_oauth_codes(expiresAt)',
    );
  });

  return {
    async store(hash, payload, ttl) {
      init();
      const expiresAt = Date.now() + ttl * 1000;
      db.run(
        `INSERT INTO auth_oauth_codes (codeHash, payload, expiresAt)
         VALUES (?, ?, ?)
         ON CONFLICT(codeHash) DO UPDATE SET payload = excluded.payload, expiresAt = excluded.expiresAt`,
        hash,
        JSON.stringify(payload),
        expiresAt,
      );
    },
    async consume(hash) {
      init();
      const now = Date.now();
      const row = db
        .query(
          'DELETE FROM auth_oauth_codes WHERE codeHash = ? AND expiresAt > ? RETURNING payload',
        )
        .get(hash, now) as { payload: string } | null;
      if (!row) return null;
      return JSON.parse(row.payload) as OAuthCodePayload;
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
 * Creates a Redis-backed OAuth authorization code repository.
 *
 * Keys are namespaced as `oauthcode:<appName>:<hash>` with a Redis `EX` TTL (60 seconds).
 * `consume` uses an atomic `GETDEL` (Redis >= 6.2) with a Lua fallback.
 *
 * @param getRedis - Factory function that returns the `RedisLike` client.
 * @param appName - Application name used as a Redis key namespace prefix.
 * @returns An `OAuthCodeRepository` backed by Redis.
 *
 * @example
 * import { createRedisOAuthCodeRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const codeRepo = createRedisOAuthCodeRepository(() => redisClient, 'my-app');
 */
export function createRedisOAuthCodeRepository(
  getRedis: () => RedisLike,
  appName: string,
): OAuthCodeRepository {
  return {
    async store(hash, payload, ttl) {
      await getRedis().set(`oauthcode:${appName}:${hash}`, JSON.stringify(payload), 'EX', ttl);
    },
    async consume(hash) {
      const key = `oauthcode:${appName}:${hash}`;
      const raw = await redisGetDel(getRedis(), key);
      if (!raw) return null;
      return JSON.parse(raw) as OAuthCodePayload;
    },
  };
}

// ---------------------------------------------------------------------------
// Mongo repository factory
// ---------------------------------------------------------------------------

interface OAuthCodeDoc {
  codeHash: string;
  token: string;
  userId: string;
  email?: string;
  refreshToken?: string;
  expiresAt: Date;
}

/**
 * Creates a MongoDB-backed OAuth authorization code repository.
 *
 * Registers (or retrieves a cached) `OAuthCode` Mongoose model. Documents expire via a
 * MongoDB TTL index on `expiresAt`. `consume` uses `findOneAndDelete` for atomic
 * read-and-delete.
 *
 * @param conn - The Mongoose `Connection` to register the model on.
 * @param mg - The `mongoose` module instance used for `Schema` construction.
 * @returns An `OAuthCodeRepository` backed by MongoDB.
 *
 * @remarks
 * The collection `oauth_codes` is auto-created on the first write.
 *
 * @example
 * import { createMongoOAuthCodeRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const codeRepo = createMongoOAuthCodeRepository(conn, mongoose);
 */
export function createMongoOAuthCodeRepository(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
): OAuthCodeRepository {
  function getModel(): import('mongoose').Model<OAuthCodeDoc> {
    if ('OAuthCode' in conn.models)
      return conn.models['OAuthCode'] as unknown as import('mongoose').Model<OAuthCodeDoc>;
    const { Schema } = mg;
    const schema = new Schema<OAuthCodeDoc>(
      {
        codeHash: { type: String, required: true, unique: true },
        token: { type: String, required: true },
        userId: { type: String, required: true },
        email: { type: String },
        refreshToken: { type: String },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'oauth_codes' },
    );
    return conn.model('OAuthCode', schema);
  }

  return {
    async store(hash, payload, ttl) {
      await getModel().create({
        codeHash: hash,
        ...payload,
        expiresAt: new Date(Date.now() + ttl * 1000),
      });
    },
    async consume(hash) {
      const doc = await getModel()
        .findOneAndDelete({ codeHash: hash, expiresAt: { $gt: new Date() } })
        .lean();
      if (!doc) return null;
      return {
        token: doc.token,
        userId: doc.userId,
        email: doc.email,
        refreshToken: doc.refreshToken,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Postgres-backed OAuth authorization code repository.
 *
 * The `auth_oauth_codes` table is created on first use (lazy `ensureTable`, idempotent).
 * `consume` uses `DELETE ... RETURNING` for atomic read-and-delete.
 *
 * @param pool - The `pg.Pool` instance to use for queries.
 * @returns An `OAuthCodeRepository` backed by Postgres.
 *
 * @remarks
 * The table is auto-created on the first method call.
 *
 * @example
 * import { createPostgresOAuthCodeRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import { Pool } from 'pg';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const codeRepo = createPostgresOAuthCodeRepository(pool);
 */
export function createPostgresOAuthCodeRepository(pool: import('pg').Pool): OAuthCodeRepository {
  const ensureTable = createPostgresInitializer(pool, async client => {
    await client.query(`CREATE TABLE IF NOT EXISTS auth_oauth_codes (
      code_hash  TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    )`);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_oauth_codes_expires_at ON auth_oauth_codes(expires_at)',
    );
  });

  return {
    async store(hash, payload, ttl) {
      await ensureTable();
      const expiresAt = Date.now() + ttl * 1000;
      await pool.query(
        `INSERT INTO auth_oauth_codes (code_hash, payload, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (code_hash) DO UPDATE SET
           payload    = EXCLUDED.payload,
           expires_at = EXCLUDED.expires_at`,
        [hash, JSON.stringify(payload), expiresAt],
      );
    },
    async consume(hash) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ payload: string }>(
        `DELETE FROM auth_oauth_codes
         WHERE code_hash = $1 AND expires_at > $2
         RETURNING payload`,
        [hash, now],
      );
      if (!rows[0]) return null;
      return JSON.parse(rows[0].payload) as OAuthCodePayload;
    },
  };
}

export const oauthCodeFactories: RepoFactories<OAuthCodeRepository> = {
  memory: () => createMemoryOAuthCodeRepository(),
  sqlite: infra => createSqliteOAuthCodeRepository(infra.getSqliteDb()),
  redis: infra => createRedisOAuthCodeRepository(infra.getRedis, infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoOAuthCodeRepository(conn, mg);
  },
  postgres: infra => createPostgresOAuthCodeRepository(infra.getPostgres().pool),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const CODE_TTL = 60; // 60 seconds

/**
 * Generates and stores a one-time OAuth authorization code.
 *
 * Generates 32 cryptographically random bytes, encodes them as base64url, hashes the
 * result (SHA-256), and stores the hash with the given payload. Sensitive fields (`token`
 * and `refreshToken`) are encrypted with the provided data encryption keys when present.
 *
 * The raw (unhashed) code is returned for inclusion in the redirect URL — only the hash
 * is ever persisted.
 *
 * @param repo - The active `OAuthCodeRepository`.
 * @param payload - The payload to associate with the code (JWT token, user ID, etc.).
 * @param deks - Data encryption keys for encrypting sensitive payload fields at rest.
 * @returns The raw authorization code string (60-second TTL).
 *
 * @example
 * import { storeOAuthCode } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const code = await storeOAuthCode(runtime.repos.oauthCode, { token, userId }, runtime.dataEncryptionKeys);
 * return c.redirect(`${redirectUri}?code=${code}`);
 */
export const storeOAuthCode = async (
  repo: OAuthCodeRepository,
  payload: OAuthCodePayload,
  deks: readonly import('@lastshotlabs/slingshot-core').DataEncryptionKey[],
): Promise<string> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const code = Buffer.from(bytes).toString('base64url');
  const hash = sha256(code);

  let storedPayload = payload;
  if (deks.length > 0) {
    storedPayload = { ...storedPayload, token: encryptField(storedPayload.token, [...deks]) };
    if (storedPayload.refreshToken) {
      storedPayload = {
        ...storedPayload,
        refreshToken: encryptField(storedPayload.refreshToken, [...deks]),
      };
    }
  }

  await repo.store(hash, storedPayload, CODE_TTL);
  return code;
};

/**
 * Atomically consumes an OAuth authorization code and returns its payload.
 *
 * Hashes the code (SHA-256), looks it up in the repository, deletes it (one-time use),
 * and decrypts sensitive fields with the provided data encryption keys if they were
 * encrypted at storage time.
 *
 * Returns `null` when the code is invalid (not found), expired, or already consumed.
 * Returns `null` and logs an error when decryption fails (e.g., key rotation during
 * the code's 60-second TTL).
 *
 * @param repo - The active `OAuthCodeRepository`.
 * @param code - The raw authorization code received from the redirect URL.
 * @param deks - Data encryption keys for decrypting sensitive payload fields.
 * @returns The stored `OAuthCodePayload`, or `null`.
 *
 * @example
 * import { consumeOAuthCode } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const payload = await consumeOAuthCode(runtime.repos.oauthCode, code, runtime.dataEncryptionKeys);
 * if (!payload) return c.json({ error: 'Invalid or expired authorization code' }, 400);
 */
export const consumeOAuthCode = async (
  repo: OAuthCodeRepository,
  code: string,
  deks: readonly import('@lastshotlabs/slingshot-core').DataEncryptionKey[],
): Promise<OAuthCodePayload | null> => {
  const hash = sha256(code);

  const result = await repo.consume(hash);

  if (result && isEncryptedField(result.token)) {
    try {
      result.token = decryptField(result.token, [...deks]);
      if (result.refreshToken && isEncryptedField(result.refreshToken)) {
        result.refreshToken = decryptField(result.refreshToken, [...deks]);
      }
    } catch (err) {
      console.error('[oauthCode] decryptField failed — key rotation during active code TTL?', err);
      return null;
    }
  }

  return result;
};
