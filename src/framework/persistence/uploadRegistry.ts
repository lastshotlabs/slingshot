// ---------------------------------------------------------------------------
// Upload Registry — backend factory functions
// ---------------------------------------------------------------------------
import type { UploadRecord, UploadRegistryRepository } from '@lastshotlabs/slingshot-core';
import { DEFAULT_MAX_ENTRIES, evictOldest } from '@lastshotlabs/slingshot-core';
import type { RepoFactories } from '@lastshotlabs/slingshot-core';
import { createPostgresInitializer } from './postgresInit';
import { createSqliteInitializer } from './sqliteInit';

export const DEFAULT_UPLOAD_REGISTRY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------
export interface Clearable {
  clear(): Promise<void> | void;
}

export type ClearableRepository<T> = T & Clearable;

/**
 * Create an in-memory `UploadRegistryRepository`.
 *
 * Records are stored in a closure-owned `Map` keyed by upload key. TTL is
 * enforced on `get()` by comparing `Date.now()` against
 * `record.createdAt + ttlSeconds * 1000`. LRU eviction via `evictOldest` caps
 * memory usage at `DEFAULT_MAX_ENTRIES` before each `register()` call.
 *
 * @param ttlSeconds - Lifetime of an upload record in seconds. Defaults to
 *   30 days (`DEFAULT_UPLOAD_REGISTRY_TTL_SECONDS`).
 * @returns A `ClearableRepository<UploadRegistryRepository>` with an
 *   additional `clear()` method for test isolation.
 */
export function createMemoryUploadRegistry(
  ttlSeconds = DEFAULT_UPLOAD_REGISTRY_TTL_SECONDS,
): ClearableRepository<UploadRegistryRepository> {
  const store = new Map<string, UploadRecord>();

  return {
    register(record) {
      evictOldest(store, DEFAULT_MAX_ENTRIES);
      store.set(record.key, record);
      return Promise.resolve();
    },
    get(key) {
      const record = store.get(key);
      if (!record) return Promise.resolve(null);
      if (Date.now() - record.createdAt > ttlSeconds * 1000) {
        store.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(record);
    },
    delete(key) {
      return Promise.resolve(store.delete(key));
    },
    clear() {
      store.clear();
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Create a Redis-backed `UploadRegistryRepository`.
 *
 * Each upload record is stored as a JSON blob under the key
 * `ur:<prefix>:<key>` with a Redis `EX` TTL so expired records are removed
 * automatically by Redis. There is no explicit expiry check on `get()` because
 * Redis handles it atomically.
 *
 * @param redis - Redis client with `get`, `set` (supporting `EX` flag), and
 *   `del` methods.
 * @param prefix - App-name prefix used to namespace Redis keys.
 * @param ttlSeconds - Key lifetime in seconds. Defaults to 30 days.
 * @returns A Redis-backed `UploadRegistryRepository`.
 */
export function createRedisUploadRegistry(
  redis: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, exFlag?: 'EX', ttl?: number): Promise<unknown>;
    del(key: string): Promise<number>;
  },
  prefix: string,
  ttlSeconds = DEFAULT_UPLOAD_REGISTRY_TTL_SECONDS,
): UploadRegistryRepository {
  /**
   * Produce the namespaced Redis key for an upload entry.
   *
   * @param key - The upload key (typically a UUID).
   * @returns Redis key in the form `ur:<prefix>:<key>`.
   */
  function rkey(key: string) {
    return `ur:${prefix}:${key}`;
  }

  return {
    async register(record) {
      await redis.set(rkey(record.key), JSON.stringify(record), 'EX', ttlSeconds);
    },
    async get(key) {
      const raw = await redis.get(rkey(key));
      if (!raw) return null;
      return JSON.parse(raw) as UploadRecord;
    },
    async delete(key) {
      const deleted = await redis.del(rkey(key));
      return deleted > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

/** Minimal interface for the Mongoose model operations used by the upload registry. */
interface UploadRegistryModel {
  updateOne(filter: object, update: object, opts: object): Promise<unknown>;
  findOne(filter: object): {
    lean(): Promise<{
      key: string;
      ownerUserId?: string;
      tenantId?: string;
      mimeType?: string;
      bucket?: string;
      createdAt: number;
    } | null>;
  };
  deleteOne(filter: object): Promise<{ deletedCount: number }>;
}

export function createMongoUploadRegistry(
  appConn: { models: Record<string, unknown>; model(name: string, schema: unknown): unknown },
  mongoosePkg: unknown,
  ttlSeconds = DEFAULT_UPLOAD_REGISTRY_TTL_SECONDS,
): UploadRegistryRepository {
  function getModel(): UploadRegistryModel {
    if (appConn.models['UploadRegistry'])
      return appConn.models['UploadRegistry'] as UploadRegistryModel;
    const { Schema } = mongoosePkg as typeof import('mongoose');
    const schema = new Schema(
      {
        key: { type: String, required: true, unique: true },
        ownerUserId: { type: String },
        tenantId: { type: String },
        mimeType: { type: String },
        bucket: { type: String },
        createdAt: { type: Number, required: true },
        expiresAt: { type: Date, required: true },
      },
      { collection: 'upload_registry' },
    );
    schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    return appConn.model('UploadRegistry', schema) as UploadRegistryModel;
  }

  /**
   * Compute the absolute expiry `Date` for a new or updated upload record.
   *
   * @returns A `Date` representing the current moment plus the configured TTL.
   */
  function expiresAt() {
    return new Date(Date.now() + ttlSeconds * 1000);
  }

  return {
    async register(record) {
      await getModel().updateOne(
        { key: record.key },
        { $set: { ...record, expiresAt: expiresAt() } },
        { upsert: true },
      );
    },
    async get(key) {
      const doc = await getModel().findOne({ key }).lean();
      if (!doc) return null;
      return {
        key: doc.key,
        ownerUserId: doc.ownerUserId,
        tenantId: doc.tenantId,
        mimeType: doc.mimeType,
        bucket: doc.bucket,
        createdAt: doc.createdAt,
      };
    },
    async delete(key) {
      const result = await getModel().deleteOne({ key });
      return result.deletedCount > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed `UploadRegistryRepository`.
 *
 * The `upload_registry` table is created lazily on first access. TTL is
 * enforced via an `expires_at` column (epoch ms); expired rows are filtered
 * out in `get()` and are lazily pruned on each `register()` call to avoid
 * unbounded growth (no background sweep is needed).
 *
 * @param db - SQLite database handle with `run()` / `query()` methods.
 * @param ttlSeconds - Row lifetime in seconds. Defaults to 30 days.
 * @returns A SQLite-backed `UploadRegistryRepository`.
 */
export function createSqliteUploadRegistry(
  db: {
    run(sql: string, params?: unknown[]): void;
    query<T>(sql: string): { get(...args: unknown[]): T | null; all(...args: unknown[]): T[] };
  },
  ttlSeconds = DEFAULT_UPLOAD_REGISTRY_TTL_SECONDS,
): UploadRegistryRepository {
  const ensureTable = createSqliteInitializer(db, () => {
    db.run(`CREATE TABLE IF NOT EXISTS upload_registry (
      key          TEXT PRIMARY KEY,
      owner_user_id TEXT,
      tenant_id    TEXT,
      mime_type    TEXT,
      bucket       TEXT,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    )`);
  });

  /**
   * Compute the absolute expiry timestamp (epoch ms) for a new upload record.
   *
   * @returns Current epoch milliseconds plus the configured TTL in ms.
   */
  function nowPlusTtl() {
    return Date.now() + ttlSeconds * 1000;
  }

  return {
    register(record) {
      ensureTable();
      // Lazy cleanup: remove expired entries on each write
      db.run('DELETE FROM upload_registry WHERE expires_at < ?', [Date.now()]);
      db.run(
        `INSERT OR REPLACE INTO upload_registry (key, owner_user_id, tenant_id, mime_type, bucket, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          record.key,
          record.ownerUserId ?? null,
          record.tenantId ?? null,
          record.mimeType ?? null,
          record.bucket ?? null,
          record.createdAt,
          nowPlusTtl(),
        ],
      );
      return Promise.resolve();
    },
    get(key) {
      ensureTable();
      const row = db
        .query<{
          key: string;
          owner_user_id: string | null;
          tenant_id: string | null;
          mime_type: string | null;
          bucket: string | null;
          created_at: number;
        }>('SELECT * FROM upload_registry WHERE key = ? AND expires_at > ?')
        .get(key, Date.now());
      if (!row) return Promise.resolve(null);
      return Promise.resolve({
        key: row.key,
        ownerUserId: row.owner_user_id ?? undefined,
        tenantId: row.tenant_id ?? undefined,
        mimeType: row.mime_type ?? undefined,
        bucket: row.bucket ?? undefined,
        createdAt: row.created_at,
      });
    },
    delete(key) {
      ensureTable();
      db.run('DELETE FROM upload_registry WHERE key = ?', [key]);
      const changes =
        db.query<{ changes: number }>('SELECT changes() as changes').get()?.changes ?? 0;
      return Promise.resolve(changes > 0);
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

type PgPool = {
  connect(): Promise<{
    query(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
    release(): void;
  }>;
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

/**
 * Create a Postgres-backed `UploadRegistryRepository`.
 *
 * The `slingshot_upload_registry` table is created lazily on first access.
 * `expires_at` is stored as a `BIGINT` epoch ms column and checked on `get()`.
 * `register()` uses `INSERT … ON CONFLICT DO UPDATE` (upsert) so resubmitting
 * an upload key replaces the record and resets the TTL.
 *
 * @param pool - The Postgres connection pool.
 * @param ttlSeconds - Row lifetime in seconds. Defaults to 30 days.
 * @returns A Postgres-backed `UploadRegistryRepository`.
 * @throws If the lazy `CREATE TABLE IF NOT EXISTS` statement fails on first
 *   access.
 */
export function createPostgresUploadRegistry(
  pool: PgPool,
  ttlSeconds = DEFAULT_UPLOAD_REGISTRY_TTL_SECONDS,
): UploadRegistryRepository {
  const ensureTable = createPostgresInitializer(pool, async client => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS slingshot_upload_registry (
        key            TEXT PRIMARY KEY,
        owner_user_id  TEXT,
        tenant_id      TEXT,
        mime_type      TEXT,
        bucket         TEXT,
        created_at     BIGINT NOT NULL,
        expires_at     BIGINT NOT NULL
      )
    `);
  });

  return {
    async register(record) {
      await ensureTable();
      const expiresAt = Date.now() + ttlSeconds * 1000;
      await pool.query(
        `INSERT INTO slingshot_upload_registry
           (key, owner_user_id, tenant_id, mime_type, bucket, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (key) DO UPDATE SET
           owner_user_id = EXCLUDED.owner_user_id,
           tenant_id     = EXCLUDED.tenant_id,
           mime_type     = EXCLUDED.mime_type,
           bucket        = EXCLUDED.bucket,
           created_at    = EXCLUDED.created_at,
           expires_at    = EXCLUDED.expires_at`,
        [
          record.key,
          record.ownerUserId ?? null,
          record.tenantId ?? null,
          record.mimeType ?? null,
          record.bucket ?? null,
          record.createdAt,
          expiresAt,
        ],
      );
    },
    async get(key) {
      await ensureTable();
      const result = await pool.query(
        'SELECT key, owner_user_id, tenant_id, mime_type, bucket, created_at FROM slingshot_upload_registry WHERE key = $1 AND expires_at > $2',
        [key, Date.now()],
      );
      const row = result.rows.at(0);
      if (!row) return null;
      return {
        key: row['key'] as string,
        ownerUserId: (row['owner_user_id'] as string | null) ?? undefined,
        tenantId: (row['tenant_id'] as string | null) ?? undefined,
        mimeType: (row['mime_type'] as string | null) ?? undefined,
        bucket: (row['bucket'] as string | null) ?? undefined,
        createdAt: Number(row['created_at']),
      };
    },
    async delete(key) {
      await ensureTable();
      const result = await pool.query('DELETE FROM slingshot_upload_registry WHERE key = $1', [
        key,
      ]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}

/**
 * Build a `RepoFactories<UploadRegistryRepository>` map with all supported
 * backends, each pre-configured with the given TTL.
 *
 * Use this factory when you need to pass a `RepoFactories` object to
 * `resolveRepo()` and want a consistent TTL across all backends without
 * constructing each factory manually.
 *
 * @param ttlSeconds - Upload record lifetime in seconds for all backends.
 *   Defaults to 30 days (`DEFAULT_UPLOAD_REGISTRY_TTL_SECONDS`).
 * @returns A `RepoFactories<UploadRegistryRepository>` covering memory, sqlite,
 *   redis, mongo, and postgres backends.
 */
export function createUploadRegistryFactories(
  ttlSeconds = DEFAULT_UPLOAD_REGISTRY_TTL_SECONDS,
): RepoFactories<UploadRegistryRepository> {
  return {
    memory: () => createMemoryUploadRegistry(ttlSeconds),
    sqlite: infra => createSqliteUploadRegistry(infra.getSqliteDb(), ttlSeconds),
    redis: infra => createRedisUploadRegistry(infra.getRedis(), infra.appName, ttlSeconds),
    mongo: infra => {
      const { conn, mg } = infra.getMongo();
      return createMongoUploadRegistry(conn, mg, ttlSeconds);
    },
    postgres: infra => createPostgresUploadRegistry(infra.getPostgres().pool, ttlSeconds),
  };
}
