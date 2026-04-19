 
import { DEFAULT_MAX_ENTRIES, evictOldest, sha256 } from '@lastshotlabs/slingshot-core';
// ---------------------------------------------------------------------------
// Factory map — add new store types here
// ---------------------------------------------------------------------------

import type { RepoFactories, RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import { createPostgresInitializer } from './postgresInit';
import { createSqliteInitializer } from './sqliteInit';
import type { RedisLike } from '../types/redis';

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for SAML request ID replay prevention.
 *
 * SAML assertions include an `InResponseTo` attribute that links the assertion to a
 * specific `AuthnRequest`. This repository stores hashed request IDs to prevent replay
 * attacks — `exists` checks for and deletes the ID atomically (one-time use).
 */
export interface SamlRequestIdRepository {
  /**
   * Stores a hashed SAML request ID so it can be validated on assertion receipt.
   *
   * @param hash - SHA-256 hex digest of the raw SAML `AuthnRequest` ID. Only the hash
   *   is stored; the plain request ID is never persisted.
   * @param ttl - Lifetime in **seconds** before the entry expires. Callers use
   *   `REQUEST_ID_TTL` (300 s) unless the SAML flow has a custom timeout.
   * @returns `Promise<void>` — resolves when the entry has been stored.
   *
   * @remarks
   * The TTL should be set to the maximum time the IdP is expected to take to return
   * the assertion. Entries that expire before the assertion arrives will cause `exists`
   * to return `false`, treating the assertion as a replay. Set a generous TTL to avoid
   * spurious replay rejections on slow IdPs.
   */
  store(hash: string, ttl: number): Promise<void>;

  /**
   * Atomically checks for and consumes a stored request ID.
   *
   * @param hash - SHA-256 hex digest of the `InResponseTo` value from the SAML assertion.
   * @returns `true` when the hash was found **and** has not expired — the entry is deleted
   *   as part of this call (one-time use). `false` when the hash is not present, has
   *   expired, or was already consumed.
   *
   * @remarks
   * **Replay detection semantics**: a `true` return means this is the **first** (and only)
   * time this request ID has been presented — it is safe to accept the assertion. A `false`
   * return means either the request was never issued by this SP, the TTL elapsed (too slow),
   * or the assertion has already been processed (replay). In all `false` cases the assertion
   * must be rejected.
   *
   * The check and delete are atomic in all backends (SQLite `DELETE WHERE ... RETURNING`,
   * Redis `DEL` on the presence key, Postgres `DELETE ... RETURNING`, MongoDB
   * `findOneAndDelete`) to prevent a race where two concurrent callbacks both see the
   * entry before either has deleted it.
   */
  exists(hash: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Memory repository factory
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory SAML request ID repository.
 *
 * Stores hashed request IDs in a `Map` with epoch-ms expiry. The `exists` method
 * atomically consumes the ID (delete-on-read) to prevent replay. Suitable for testing.
 *
 * @returns A `SamlRequestIdRepository` backed by an in-memory `Map`.
 *
 * @example
 * import { createMemorySamlRequestIdRepository } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const samlRequestIdRepo = createMemorySamlRequestIdRepository();
 */
export function createMemorySamlRequestIdRepository(): SamlRequestIdRepository {
  const memoryStore = new Map<string, number>(); // hash -> expiresAt (epoch ms)

  return {
    async store(hash, ttl) {
      evictOldest(memoryStore, DEFAULT_MAX_ENTRIES);
      memoryStore.set(hash, Date.now() + ttl * 1000);
    },

    async exists(hash) {
      const expiresAt = memoryStore.get(hash);
      if (expiresAt === undefined) return false;
      memoryStore.delete(hash);
      if (Date.now() > expiresAt) return false;
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite repository factory
// ---------------------------------------------------------------------------

export function createSqliteSamlRequestIdRepository(
  db: RuntimeSqliteDatabase | null | undefined,
): SamlRequestIdRepository {
  const ensureTable =
    db === null || db === undefined
      ? () => {}
      : createSqliteInitializer(db, () => {
          db.run(`
      CREATE TABLE IF NOT EXISTS saml_request_ids (
        hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      )
    `);
        });

  return {
    async store(hash, ttl) {
      if (!db) return;
      ensureTable();
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      db.run(
        'INSERT OR REPLACE INTO saml_request_ids (hash, expires_at) VALUES (?, ?)',
        hash,
        expiresAt,
      );
    },

    async exists(hash) {
      if (!db) return false;
      ensureTable();
      const now = Math.floor(Date.now() / 1000);
      const row = db
        .query('DELETE FROM saml_request_ids WHERE hash = ? AND expires_at > ? RETURNING hash')
        .get(hash, now) as { hash: string } | null;
      return row !== null;
    },
  };
}

// ---------------------------------------------------------------------------
// Redis repository factory
// ---------------------------------------------------------------------------

export function createRedisSamlRequestIdRepository(
  getRedis: () => RedisLike,
  appName: string,
): SamlRequestIdRepository {
  return {
    async store(hash, ttl) {
      await getRedis().set(`samlreqid:${appName}:${hash}`, '1', 'EX', ttl);
    },

    async exists(hash) {
      const key = `samlreqid:${appName}:${hash}`;
      const deleted = await getRedis().del(key);
      return deleted === 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Mongo repository factory
// ---------------------------------------------------------------------------

interface SamlRequestIdDoc {
  hash: string;
  expiresAt: Date;
}

export function createMongoSamlRequestIdRepository(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
): SamlRequestIdRepository {
  function getModel(): import('mongoose').Model<SamlRequestIdDoc> {
    if ('SamlRequestId' in conn.models)
      return conn.models['SamlRequestId'] as unknown as import('mongoose').Model<SamlRequestIdDoc>;
    const { Schema } = mg;
    const schema = new Schema<SamlRequestIdDoc>(
      {
        hash: { type: String, required: true, unique: true },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      },
      { collection: 'saml_request_ids' },
    );
    return conn.model('SamlRequestId', schema);
  }

  return {
    async store(hash, ttl) {
      await getModel().create({
        hash,
        expiresAt: new Date(Date.now() + ttl * 1000),
      });
    },

    async exists(hash) {
      const doc = await getModel()
        .findOneAndDelete({ hash, expiresAt: { $gt: new Date() } })
        .lean();
      return doc !== null;
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres repository factory
// ---------------------------------------------------------------------------

export function createPostgresSamlRequestIdRepository(
  pool: import('pg').Pool,
): SamlRequestIdRepository {
  const ensureTable = createPostgresInitializer(pool, async client => {
    await client.query(`CREATE TABLE IF NOT EXISTS auth_saml_request_ids (
      hash       TEXT PRIMARY KEY,
      expires_at BIGINT NOT NULL
    )`);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_auth_saml_request_ids_expires_at ON auth_saml_request_ids(expires_at)',
    );
  });

  return {
    async store(hash, ttl) {
      await ensureTable();
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      await pool.query(
        `INSERT INTO auth_saml_request_ids (hash, expires_at)
         VALUES ($1, $2)
         ON CONFLICT (hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [hash, expiresAt],
      );
    },
    async exists(hash) {
      await ensureTable();
      const now = Math.floor(Date.now() / 1000);
      const { rows } = await pool.query<{ hash: string }>(
        `DELETE FROM auth_saml_request_ids
         WHERE hash = $1 AND expires_at > $2
         RETURNING hash`,
        [hash, now],
      );
      return rows.length > 0;
    },
  };
}

export const samlRequestIdFactories: RepoFactories<SamlRequestIdRepository> = {
  memory: () => createMemorySamlRequestIdRepository(),
  sqlite: infra => createSqliteSamlRequestIdRepository(infra.getSqliteDb()),
  redis: infra => createRedisSamlRequestIdRepository(infra.getRedis, infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoSamlRequestIdRepository(conn, mg);
  },
  postgres: infra => createPostgresSamlRequestIdRepository(infra.getPostgres().pool),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const REQUEST_ID_TTL = 300; // 5 minutes

export const storeSamlRequestId = async (
  repo: SamlRequestIdRepository,
  requestId: string,
): Promise<void> => {
  const hash = sha256(requestId);
  await repo.store(hash, REQUEST_ID_TTL);
};

export const consumeSamlRequestId = async (
  repo: SamlRequestIdRepository,
  requestId: string,
): Promise<boolean> => {
  const hash = sha256(requestId);
  return repo.exists(hash);
};
