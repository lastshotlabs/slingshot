// ---------------------------------------------------------------------------
// Idempotency — backend factory functions
// ---------------------------------------------------------------------------
import type { IdempotencyAdapter, RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import { DEFAULT_MAX_ENTRIES, evictOldest } from '@lastshotlabs/slingshot-core';
import type { RepoFactories } from '@lastshotlabs/slingshot-core';
import { createPostgresInitializer } from './postgresInit';
import { createSqliteInitializer } from './sqliteInit';

interface IdempotencyRecord {
  status: number;
  body: string;
  createdAt: number;
  requestFingerprint?: string | null;
}

type SqliteIdempotencyDatabase = Pick<RuntimeSqliteDatabase, 'query'> & {
  run(sql: string, params?: unknown[]): void;
};

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Create an in-memory `IdempotencyAdapter`.
 *
 * Records are stored in a closure-owned `Map` keyed by idempotency key. TTL is
 * enforced on `get()` by comparing `Date.now()` against a per-entry
 * `expiresAt` timestamp. LRU eviction via `evictOldest` caps memory usage at
 * `DEFAULT_MAX_ENTRIES` before each `set()`. `set()` implements NX semantics —
 * an existing unexpired key is never overwritten.
 *
 * @returns An in-memory `IdempotencyAdapter` with a `clear()` method for test
 *   isolation.
 */
export function createMemoryIdempotencyAdapter(): IdempotencyAdapter {
  const store = new Map<string, IdempotencyRecord & { expiresAt: number }>();

  return {
    get(key) {
      const record = store.get(key);
      if (!record) return Promise.resolve(null);
      if (Date.now() > record.expiresAt) {
        store.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve({
        response: record.body,
        status: record.status,
        createdAt: record.createdAt,
        requestFingerprint: record.requestFingerprint ?? null,
      });
    },
    set(key, response, status, ttlSeconds, meta) {
      if (store.has(key)) return Promise.resolve(); // NX semantics — don't overwrite
      evictOldest(store, DEFAULT_MAX_ENTRIES);
      store.set(key, {
        status,
        body: response,
        createdAt: Date.now(),
        requestFingerprint: meta?.requestFingerprint ?? null,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      return Promise.resolve();
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
 * Create a Redis-backed `IdempotencyAdapter`.
 *
 * Each record is stored as a JSON blob under the key
 * `idempotency:<prefix>:<key>`. TTL is delegated to Redis via the `EX` option
 * on `SET`, and NX semantics are enforced with the `NX` flag — Redis
 * atomically rejects the write if the key already exists, preventing replay.
 *
 * @param redis - Redis client with `get` / `set` methods. The `set` signature
 *   must accept `(key, value, 'EX', ttl, 'NX')` for atomic NX+EX writes.
 * @param prefix - App-name prefix used to namespace Redis keys, preventing
 *   collisions between multiple apps on the same Redis instance.
 * @returns A Redis-backed `IdempotencyAdapter`.
 */
export function createRedisIdempotencyAdapter(
  redis: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, exFlag: 'EX', ttl: number, nx: 'NX'): Promise<unknown>;
  },
  prefix: string,
): IdempotencyAdapter {
  function rkey(key: string) {
    return `idempotency:${prefix}:${key}`;
  }

  return {
    async get(key) {
      const raw = await redis.get(rkey(key));
      if (!raw) return null;
      const record = JSON.parse(raw) as IdempotencyRecord;
      return {
        response: record.body,
        status: record.status,
        createdAt: record.createdAt,
        requestFingerprint: record.requestFingerprint ?? null,
      };
    },
    async set(key, response, status, ttlSeconds, meta) {
      const value = JSON.stringify({
        status,
        body: response,
        createdAt: Date.now(),
        requestFingerprint: meta?.requestFingerprint ?? null,
      });
      await redis.set(rkey(key), value, 'EX', ttlSeconds, 'NX');
    },
  };
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

/** Minimal interface for the Mongoose model operations used by the idempotency adapter. */
interface IdempotencyModel {
  findOne(
    filter: object,
    projection: string,
  ): {
    lean(): Promise<{
      status: number;
      body: string;
      createdAt: { getTime(): number };
      requestFingerprint?: string | null;
    } | null>;
  };
  create(doc: object): Promise<unknown>;
}

/**
 * Create a MongoDB-backed `IdempotencyAdapter`.
 *
 * Records are stored in the `idempotency` collection with a TTL index
 * (`expireAfterSeconds: 0` on the `expiresAt` field), so MongoDB handles
 * expiry automatically. NX semantics are implemented by catching duplicate-key
 * errors (code `11000`) on `create()` — MongoDB's unique index on `key`
 * ensures atomicity.
 *
 * The Mongoose model is created lazily on first access and re-used for the
 * lifetime of the adapter instance.
 *
 * @param appConn - The Mongoose `Connection` for the app database.
 * @param mongoosePkg - The `mongoose` module, passed as `unknown` to keep
 *   mongoose out of the static import graph (optional-dependency boundary).
 * @returns A MongoDB-backed `IdempotencyAdapter`.
 * @throws Re-throws any MongoDB error whose code is not `11000` (duplicate key).
 */
export function createMongoIdempotencyAdapter(
  appConn: { models: Record<string, unknown>; model(name: string, schema: unknown): unknown },
  mongoosePkg: unknown,
): IdempotencyAdapter {
  function getModel(): IdempotencyModel {
    if (appConn.models['Idempotency']) return appConn.models['Idempotency'] as IdempotencyModel;
    const { Schema } = mongoosePkg as typeof import('mongoose');
    const schema = new Schema(
      {
        key: { type: String, required: true, unique: true },
        status: { type: Number, required: true },
        body: { type: String, required: true },
        createdAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
        requestFingerprint: { type: String, required: false, default: null },
      },
      { collection: 'idempotency' },
    );
    return appConn.model('Idempotency', schema) as IdempotencyModel;
  }

  return {
    async get(key) {
      const doc = await getModel()
        .findOne(
          { key, expiresAt: { $gt: new Date() } },
          'status body createdAt requestFingerprint',
        )
        .lean();
      if (!doc) return null;
      return {
        status: doc.status,
        response: doc.body,
        createdAt: doc.createdAt.getTime(),
        requestFingerprint:
          (doc as { requestFingerprint?: string | null }).requestFingerprint ?? null,
      };
    },
    async set(key, response, status, ttlSeconds, meta) {
      const now = new Date();
      try {
        await getModel().create({
          key,
          status,
          body: response,
          createdAt: now,
          expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
          requestFingerprint: meta?.requestFingerprint ?? null,
        });
      } catch (err: unknown) {
        // Duplicate key — NX semantics: ignore
        const code = (err as { code?: number | string }).code;
        if (code === 11000 || code === '11000') return;
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed `IdempotencyAdapter`.
 *
 * The `idempotency` table is created lazily on first access using
 * `CREATE TABLE IF NOT EXISTS`. TTL is enforced by filtering on `expiresAt`
 * (stored as epoch milliseconds) in `get()`. NX semantics are implemented via
 * `INSERT OR IGNORE`, which silently discards the write when the key already
 * exists.
 *
 * @param db - SQLite database handle with `run()` / `query()` methods.
 * @returns A SQLite-backed `IdempotencyAdapter`.
 */
export function createSqliteIdempotencyAdapter(db: SqliteIdempotencyDatabase): IdempotencyAdapter {
  const ensureTable = createSqliteInitializer(db, () => {
    db.run(`CREATE TABLE IF NOT EXISTS idempotency (
      key       TEXT PRIMARY KEY,
      status    INTEGER NOT NULL,
      body      TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      requestFingerprint TEXT
    )`);
    const columns = db
      .query<{ name: string }>('PRAGMA table_info(idempotency)')
      .all()
      .map(row => row.name);
    if (!columns.includes('requestFingerprint')) {
      db.run('ALTER TABLE idempotency ADD COLUMN requestFingerprint TEXT');
    }
  });

  return {
    get(key) {
      ensureTable();
      const row = db
        .query<{
          status: number;
          body: string;
          createdAt: number;
          requestFingerprint: string | null;
        }>(
          'SELECT status, body, createdAt, requestFingerprint FROM idempotency WHERE key = ? AND expiresAt > ?',
        )
        .get(key, Date.now());
      if (!row) return Promise.resolve(null);
      return Promise.resolve({
        status: row.status,
        response: row.body,
        createdAt: row.createdAt,
        requestFingerprint: row.requestFingerprint ?? null,
      });
    },
    set(key, response, status, ttlSeconds, meta) {
      ensureTable();
      const now = Date.now();
      db.run(
        'INSERT OR IGNORE INTO idempotency (key, status, body, createdAt, expiresAt, requestFingerprint) VALUES (?, ?, ?, ?, ?, ?)',
        [key, status, response, now, now + ttlSeconds * 1000, meta?.requestFingerprint ?? null],
      );
      return Promise.resolve();
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
 * Create a Postgres-backed `IdempotencyAdapter`.
 *
 * The `slingshot_idempotency` table is created lazily on first access. TTL is
 * enforced by filtering on `expires_at` (stored as `BIGINT` epoch ms) in
 * `get()`. NX semantics are implemented via `INSERT … ON CONFLICT (key) DO
 * NOTHING`, which Postgres executes atomically.
 *
 * @param pool - The Postgres connection pool.
 * @returns A Postgres-backed `IdempotencyAdapter`.
 * @throws If the lazy `CREATE TABLE IF NOT EXISTS` statement fails on first
 *   access.
 */
export function createPostgresIdempotencyAdapter(pool: PgPool): IdempotencyAdapter {
  const ensureTable = createPostgresInitializer(pool, async client => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS slingshot_idempotency (
        key        TEXT PRIMARY KEY,
        status     INTEGER NOT NULL,
        body       TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        request_fingerprint TEXT
      )
    `);
    await client.query(
      'ALTER TABLE slingshot_idempotency ADD COLUMN IF NOT EXISTS request_fingerprint TEXT',
    );
  });

  return {
    async get(key) {
      await ensureTable();
      const result = await pool.query(
        'SELECT status, body, created_at, request_fingerprint FROM slingshot_idempotency WHERE key = $1 AND expires_at > $2',
        [key, Date.now()],
      );
      const row = result.rows.at(0);
      if (!row) return null;
      return {
        status: row['status'] as number,
        response: row['body'] as string,
        createdAt: row['created_at'] as number,
        requestFingerprint: (row['request_fingerprint'] as string | null | undefined) ?? null,
      };
    },
    async set(key, response, status, ttlSeconds, meta) {
      await ensureTable();
      const now = Date.now();
      await pool.query(
        `INSERT INTO slingshot_idempotency (key, status, body, created_at, expires_at, request_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (key) DO NOTHING`,
        [key, status, response, now, now + ttlSeconds * 1000, meta?.requestFingerprint ?? null],
      );
    },
  };
}

export const idempotencyFactories: RepoFactories<IdempotencyAdapter> = {
  memory: () => createMemoryIdempotencyAdapter(),
  sqlite: infra => createSqliteIdempotencyAdapter(infra.getSqliteDb()),
  redis: infra => createRedisIdempotencyAdapter(infra.getRedis(), infra.appName),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoIdempotencyAdapter(conn, mg);
  },
  postgres: infra => createPostgresIdempotencyAdapter(infra.getPostgres().pool),
};
