 
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
import type { OAuthReauthConfirmation, OAuthReauthState } from '../types/oauthReauth';
import { createSqliteInitializer } from './sqliteInit';
import type { RedisLike } from '../types/redis';

// ---------------------------------------------------------------------------
// Types — canonical definitions live in ../types/oauthReauth.ts
// ---------------------------------------------------------------------------

export type { OAuthReauthState, OAuthReauthConfirmation } from '../types/oauthReauth';

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for OAuth re-authentication state and confirmation codes.
 *
 * The re-auth flow has two stages:
 * 1. Before the OAuth redirect: a `state` record is stored linking the pending session
 *    to the re-auth purpose.
 * 2. After the OAuth callback: a `confirmation` code is stored so the original route
 *    can verify the re-auth completed.
 *
 * Both state and confirmation are single-use with a 5-minute TTL.
 */
export interface OAuthReauthRepository {
  storeState(hash: string, data: OAuthReauthState, ttl: number): Promise<void>;
  consumeState(hash: string): Promise<OAuthReauthState | null>;
  storeConfirmation(hash: string, data: OAuthReauthConfirmation, ttl: number): Promise<void>;
  consumeConfirmation(hash: string): Promise<OAuthReauthConfirmation | null>;
}

// ---------------------------------------------------------------------------
// Memory repository factory
// ---------------------------------------------------------------------------

interface MemoryReauthEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * Creates an in-memory OAuth re-authentication repository.
 *
 * Stores state and confirmation records in separate `Map`s with opportunistic eviction.
 * Each call returns an independent instance. Suitable for testing.
 *
 * @returns An `OAuthReauthRepository` backed by in-memory `Map`s.
 *
 * @example
 * import { createMemoryOAuthReauthRepository } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const reauthRepo = createMemoryOAuthReauthRepository();
 */
export function createMemoryOAuthReauthRepository(): OAuthReauthRepository {
  const states = new Map<string, MemoryReauthEntry<OAuthReauthState>>();
  const confirmations = new Map<string, MemoryReauthEntry<OAuthReauthConfirmation>>();
  const evictExpired = createEvictExpired();

  return {
    async storeState(hash, data, ttl) {
      evictExpired(states);
      evictOldest(states, DEFAULT_MAX_ENTRIES);
      states.set(hash, { data, expiresAt: Date.now() + ttl * 1000 });
    },
    async consumeState(hash) {
      const entry = states.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        states.delete(hash);
        return null;
      }
      states.delete(hash);
      return entry.data;
    },
    async storeConfirmation(hash, data, ttl) {
      evictExpired(confirmations);
      evictOldest(confirmations, DEFAULT_MAX_ENTRIES);
      confirmations.set(hash, { data, expiresAt: Date.now() + ttl * 1000 });
    },
    async consumeConfirmation(hash) {
      const entry = confirmations.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        confirmations.delete(hash);
        return null;
      }
      confirmations.delete(hash);
      return entry.data;
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite-backed OAuth re-authentication repository.
 *
 * Maintains two tables — `auth_oauth_reauth_states` and `auth_oauth_reauth_confirmations` —
 * both created on first use (lazy init, idempotent). Both `consumeState` and
 * `consumeConfirmation` use `DELETE ... RETURNING` for atomic read-and-delete.
 *
 * @param db - The Bun SQLite database handle (`RuntimeSqliteDatabase`).
 * @returns An `OAuthReauthRepository` backed by SQLite.
 *
 * @remarks
 * Both tables are auto-created on the first call to any method via a shared `init()` helper.
 *
 * @example
 * import { createSqliteOAuthReauthRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const reauthRepo = createSqliteOAuthReauthRepository(db);
 */
export function createSqliteOAuthReauthRepository(
  db: RuntimeSqliteDatabase,
): OAuthReauthRepository {
  const init = createSqliteInitializer(db, () => {
    db.run(`CREATE TABLE IF NOT EXISTS auth_oauth_reauth_states (
      tokenHash TEXT PRIMARY KEY,
      data      TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_auth_oauth_reauth_states_expiresAt ON auth_oauth_reauth_states(expiresAt)',
    );
    db.run(`CREATE TABLE IF NOT EXISTS auth_oauth_reauth_confirmations (
      codeHash  TEXT PRIMARY KEY,
      data      TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_auth_oauth_reauth_confirmations_expiresAt ON auth_oauth_reauth_confirmations(expiresAt)',
    );
  });

  return {
    async storeState(hash, data, ttl) {
      init();
      const expiresAt = Date.now() + ttl * 1000;
      db.run(
        `INSERT INTO auth_oauth_reauth_states (tokenHash, data, expiresAt)
         VALUES (?, ?, ?)
         ON CONFLICT(tokenHash) DO UPDATE SET data = excluded.data, expiresAt = excluded.expiresAt`,
        hash,
        JSON.stringify(data),
        expiresAt,
      );
    },
    async consumeState(hash) {
      init();
      const now = Date.now();
      const row = db
        .query(
          'DELETE FROM auth_oauth_reauth_states WHERE tokenHash = ? AND expiresAt > ? RETURNING data',
        )
        .get(hash, now) as { data: string } | null;
      if (!row) return null;
      return JSON.parse(row.data) as OAuthReauthState;
    },
    async storeConfirmation(hash, data, ttl) {
      init();
      const expiresAt = Date.now() + ttl * 1000;
      db.run(
        `INSERT INTO auth_oauth_reauth_confirmations (codeHash, data, expiresAt)
         VALUES (?, ?, ?)
         ON CONFLICT(codeHash) DO UPDATE SET data = excluded.data, expiresAt = excluded.expiresAt`,
        hash,
        JSON.stringify(data),
        expiresAt,
      );
    },
    async consumeConfirmation(hash) {
      init();
      const now = Date.now();
      const row = db
        .query(
          'DELETE FROM auth_oauth_reauth_confirmations WHERE codeHash = ? AND expiresAt > ? RETURNING data',
        )
        .get(hash, now) as { data: string } | null;
      if (!row) return null;
      return JSON.parse(row.data) as OAuthReauthConfirmation;
    },
  };
}

// ---------------------------------------------------------------------------
// Redis helpers
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

// ---------------------------------------------------------------------------
// Redis repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Redis-backed OAuth re-authentication repository.
 *
 * State keys are namespaced as `oauthreauth:<appName>:<hash>` and confirmation keys as
 * `oauthreauthconf:<appName>:<hash>`, both with 5-minute Redis `EX` TTLs. Both `consume`
 * methods use atomic `GETDEL` (Redis >= 6.2) with a Lua fallback.
 *
 * @param getRedis - Factory function that returns the `RedisLike` client.
 * @param appName - Application name used as a Redis key namespace prefix.
 * @returns An `OAuthReauthRepository` backed by Redis.
 *
 * @example
 * import { createRedisOAuthReauthRepository } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const reauthRepo = createRedisOAuthReauthRepository(() => redisClient, 'my-app');
 */
export function createRedisOAuthReauthRepository(
  getRedis: () => RedisLike,
  appName: string,
): OAuthReauthRepository {
  return {
    async storeState(hash, data, ttl) {
      await getRedis().set(`oauthreauth:${appName}:${hash}`, JSON.stringify(data), 'EX', ttl);
    },
    async consumeState(hash) {
      const key = `oauthreauth:${appName}:${hash}`;
      const raw = await redisGetDel(getRedis(), key);
      if (!raw) return null;
      return JSON.parse(raw) as OAuthReauthState;
    },
    async storeConfirmation(hash, data, ttl) {
      await getRedis().set(`oauthreauthconf:${appName}:${hash}`, JSON.stringify(data), 'EX', ttl);
    },
    async consumeConfirmation(hash) {
      const key = `oauthreauthconf:${appName}:${hash}`;
      const raw = await redisGetDel(getRedis(), key);
      if (!raw) return null;
      return JSON.parse(raw) as OAuthReauthConfirmation;
    },
  };
}

// ---------------------------------------------------------------------------
// Mongo repository factory
// ---------------------------------------------------------------------------

interface OAuthReauthDoc {
  tokenHash: string;
  userId: string;
  sessionId: string;
  provider: string;
  purpose: string;
  expiresAt: Date;
  returnUrl?: string;
}

interface OAuthReauthConfirmationDoc {
  codeHash: string;
  userId: string;
  purpose: string;
  expiresAt: Date;
}

/**
 * Creates a MongoDB-backed OAuth re-authentication repository.
 *
 * Registers (or retrieves cached) `OAuthReauth` and `OAuthReauthConfirmation` Mongoose models.
 * Both use MongoDB TTL indexes for automatic expiry. `consumeState` and `consumeConfirmation`
 * use `findOneAndDelete` for atomic read-and-delete.
 *
 * @param conn - The Mongoose `Connection` to register the models on.
 * @param mg - The `mongoose` module instance used for `Schema` construction.
 * @returns An `OAuthReauthRepository` backed by MongoDB.
 *
 * @remarks
 * Collections `oauth_reauth_states` and `oauth_reauth_confirmations` are auto-created on
 * the first write to each model.
 *
 * @example
 * import { createMongoOAuthReauthRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const reauthRepo = createMongoOAuthReauthRepository(conn, mongoose);
 */
export function createMongoOAuthReauthRepository(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
): OAuthReauthRepository {
  function getReauthModel(): import('mongoose').Model<OAuthReauthDoc> {
    if ('OAuthReauth' in conn.models)
      return conn.models['OAuthReauth'] as unknown as import('mongoose').Model<OAuthReauthDoc>;
    const { Schema } = mg;
    const schema = new Schema<OAuthReauthDoc>(
      {
        tokenHash: { type: String, required: true, unique: true },
        userId: { type: String, required: true },
        sessionId: { type: String, required: true },
        provider: { type: String, required: true },
        purpose: { type: String, required: true },
        returnUrl: { type: String },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'oauth_reauth_states' },
    );
    return conn.model('OAuthReauth', schema);
  }

  function getConfirmationModel(): import('mongoose').Model<OAuthReauthConfirmationDoc> {
    if ('OAuthReauthConfirmation' in conn.models)
      return conn.models[
        'OAuthReauthConfirmation'
      ] as unknown as import('mongoose').Model<OAuthReauthConfirmationDoc>;
    const { Schema } = mg;
    const schema = new Schema<OAuthReauthConfirmationDoc>(
      {
        codeHash: { type: String, required: true, unique: true },
        userId: { type: String, required: true },
        purpose: { type: String, required: true },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'oauth_reauth_confirmations' },
    );
    return conn.model('OAuthReauthConfirmation', schema);
  }

  return {
    async storeState(hash, data, ttl) {
      await getReauthModel().create({
        tokenHash: hash,
        userId: data.userId,
        sessionId: data.sessionId,
        provider: data.provider,
        purpose: data.purpose,
        returnUrl: data.returnUrl,
        expiresAt: new Date(Date.now() + ttl * 1000),
      });
    },
    async consumeState(hash) {
      const doc = await getReauthModel()
        .findOneAndDelete({ tokenHash: hash, expiresAt: { $gt: new Date() } })
        .lean();
      if (!doc) return null;
      return {
        userId: doc.userId,
        sessionId: doc.sessionId,
        provider: doc.provider,
        purpose: doc.purpose,
        expiresAt: doc.expiresAt.getTime(),
        returnUrl: doc.returnUrl,
      };
    },
    async storeConfirmation(hash, data, ttl) {
      await getConfirmationModel().create({
        codeHash: hash,
        userId: data.userId,
        purpose: data.purpose,
        expiresAt: new Date(Date.now() + ttl * 1000),
      });
    },
    async consumeConfirmation(hash) {
      const doc = await getConfirmationModel()
        .findOneAndDelete({ codeHash: hash, expiresAt: { $gt: new Date() } })
        .lean();
      if (!doc) return null;
      return { userId: doc.userId, purpose: doc.purpose };
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres repository factory
// ---------------------------------------------------------------------------

/**
 * Creates a Postgres-backed OAuth re-authentication repository.
 *
 * Maintains two tables — `auth_oauth_reauth_states` and `auth_oauth_reauth_confirmations` —
 * both created on first use (lazy `ensureTable`, idempotent). Both `consume` methods use
 * `DELETE ... RETURNING` for atomic read-and-delete.
 *
 * @param pool - The `pg.Pool` instance to use for queries.
 * @returns An `OAuthReauthRepository` backed by Postgres.
 *
 * @remarks
 * Both tables are auto-created on the first method call.
 *
 * @example
 * import { createPostgresOAuthReauthRepository } from '@lastshotlabs/slingshot-auth/plugin';
 * import { Pool } from 'pg';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const reauthRepo = createPostgresOAuthReauthRepository(pool);
 */
export function createPostgresOAuthReauthRepository(
  pool: import('pg').Pool,
): OAuthReauthRepository {
  let tableReady = false;
  const ensureTable = async (): Promise<void> => {
    if (tableReady) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_oauth_reauth_states (
      token_hash TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    )`);
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_oauth_reauth_states_expires_at ON auth_oauth_reauth_states(expires_at)',
    );
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_oauth_reauth_confirmations (
      code_hash  TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    )`);
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_oauth_reauth_confirmations_expires_at ON auth_oauth_reauth_confirmations(expires_at)',
    );
    tableReady = true;
  };

  return {
    async storeState(hash, data, ttl) {
      await ensureTable();
      const expiresAt = Date.now() + ttl * 1000;
      await pool.query(
        `INSERT INTO auth_oauth_reauth_states (token_hash, data, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (token_hash) DO UPDATE SET
           data       = EXCLUDED.data,
           expires_at = EXCLUDED.expires_at`,
        [hash, JSON.stringify(data), expiresAt],
      );
    },
    async consumeState(hash) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ data: string }>(
        `DELETE FROM auth_oauth_reauth_states
         WHERE token_hash = $1 AND expires_at > $2
         RETURNING data`,
        [hash, now],
      );
      if (!rows[0]) return null;
      return JSON.parse(rows[0].data) as OAuthReauthState;
    },
    async storeConfirmation(hash, data, ttl) {
      await ensureTable();
      const expiresAt = Date.now() + ttl * 1000;
      await pool.query(
        `INSERT INTO auth_oauth_reauth_confirmations (code_hash, data, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (code_hash) DO UPDATE SET
           data       = EXCLUDED.data,
           expires_at = EXCLUDED.expires_at`,
        [hash, JSON.stringify(data), expiresAt],
      );
    },
    async consumeConfirmation(hash) {
      await ensureTable();
      const now = Date.now();
      const { rows } = await pool.query<{ data: string }>(
        `DELETE FROM auth_oauth_reauth_confirmations
         WHERE code_hash = $1 AND expires_at > $2
         RETURNING data`,
        [hash, now],
      );
      if (!rows[0]) return null;
      return JSON.parse(rows[0].data) as OAuthReauthConfirmation;
    },
  };
}

export const oauthReauthFactories: RepoFactories<OAuthReauthRepository> = {
  memory: () => createMemoryOAuthReauthRepository(),
  sqlite: infra => createSqliteOAuthReauthRepository(infra.getSqliteDb()),
  redis: infra => createRedisOAuthReauthRepository(infra.getRedis, infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoOAuthReauthRepository(conn, mg);
  },
  postgres: infra => createPostgresOAuthReauthRepository(infra.getPostgres().pool),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const REAUTH_TTL = 300; // 5 minutes — matches OAuth state TTL
const CONFIRMATION_TTL = 300; // 5 minutes

export const createReauthState = async (
  repo: OAuthReauthRepository,
  data: OAuthReauthState,
): Promise<string> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Buffer.from(bytes).toString('base64url');
  const hash = sha256(token);
  await repo.storeState(hash, data, REAUTH_TTL);
  return token;
};

export const consumeReauthState = async (
  repo: OAuthReauthRepository,
  token: string,
): Promise<OAuthReauthState | null> => {
  const hash = sha256(token);
  return repo.consumeState(hash);
};

/**
 * Generates and stores a one-time OAuth re-authentication confirmation code.
 *
 * Called by the OAuth callback handler after a successful re-auth to record the
 * confirmation so the original route (step-up, M2M token exchange, etc.) can verify it.
 * The raw code is returned for including in the redirect URL; only the SHA-256 hash
 * is persisted with a 5-minute TTL.
 *
 * @param repo - The active `OAuthReauthRepository`.
 * @param data - Confirmation data (user ID and purpose).
 * @returns The raw confirmation code string.
 *
 * @example
 * import { storeReauthConfirmation } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const code = await storeReauthConfirmation(runtime.repos.oauthReauth, { userId, purpose: 'step-up' });
 * return c.redirect(`/auth/step-up/confirm?code=${code}`);
 */
export const storeReauthConfirmation = async (
  repo: OAuthReauthRepository,
  data: OAuthReauthConfirmation,
): Promise<string> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const code = Buffer.from(bytes).toString('base64url');
  const hash = sha256(code);
  await repo.storeConfirmation(hash, data, CONFIRMATION_TTL);
  return code;
};

/**
 * Atomically consumes a re-authentication confirmation code and returns its data.
 *
 * Hashes the code (SHA-256), looks it up in the repository, and deletes it (one-time use).
 * Returns `null` when the code is not found or has expired.
 *
 * @param repo - The active `OAuthReauthRepository`.
 * @param code - The raw confirmation code from the redirect URL.
 * @returns The `OAuthReauthConfirmation` payload (user ID, purpose), or `null`.
 *
 * @example
 * import { consumeReauthConfirmation } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const confirmation = await consumeReauthConfirmation(runtime.repos.oauthReauth, code);
 * if (!confirmation) return c.json({ error: 'Invalid or expired confirmation code' }, 400);
 */
export const consumeReauthConfirmation = async (
  repo: OAuthReauthRepository,
  code: string,
): Promise<OAuthReauthConfirmation | null> => {
  const hash = sha256(code);
  return repo.consumeConfirmation(hash);
};
