/**
 * Tests for idempotency backend adapters:
 *   - Redis (createRedisIdempotencyAdapter)
 *   - SQLite (createSqliteIdempotencyAdapter)
 *   - Postgres (createPostgresIdempotencyAdapter)
 *   - Mongo (createMongoIdempotencyAdapter)
 */
import { describe, expect, test } from 'bun:test';
import {
  createRedisIdempotencyAdapter,
  createSqliteIdempotencyAdapter,
  createPostgresIdempotencyAdapter,
  createMongoIdempotencyAdapter,
} from '../../src/framework/persistence/idempotency';

// ---------------------------------------------------------------------------
// Redis adapter
// ---------------------------------------------------------------------------

describe('createRedisIdempotencyAdapter', () => {
  function makeRedis() {
    const store = new Map<string, { value: string; ttl: number }>();
    return {
      store,
      async get(key: string) {
        const entry = store.get(key);
        return entry?.value ?? null;
      },
      async set(key: string, value: string, _exFlag: 'EX', ttl: number) {
        if (store.has(key)) return null; // NX semantics
        store.set(key, { value, ttl });
        return 'OK';
      },
    };
  }

  test('set then get round-trip', async () => {
    const redis = makeRedis();
    const adapter = createRedisIdempotencyAdapter(redis, 'myapp');

    await adapter.set('key1', '{"ok":true}', 200, 60);
    const result = await adapter.get('key1');

    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(result!.response).toBe('{"ok":true}');
    expect(result!.requestFingerprint).toBeNull();
  });

  test('get returns null for missing key', async () => {
    const redis = makeRedis();
    const adapter = createRedisIdempotencyAdapter(redis, 'myapp');

    const result = await adapter.get('missing');
    expect(result).toBeNull();
  });

  test('set with requestFingerprint', async () => {
    const redis = makeRedis();
    const adapter = createRedisIdempotencyAdapter(redis, 'myapp');

    await adapter.set('key2', 'body', 201, 30, { requestFingerprint: 'fp-abc' });
    const result = await adapter.get('key2');
    expect(result!.requestFingerprint).toBe('fp-abc');
  });

  test('NX semantics — does not overwrite existing key', async () => {
    const redis = makeRedis();
    const adapter = createRedisIdempotencyAdapter(redis, 'myapp');

    await adapter.set('nx-key', 'first', 200, 60);
    await adapter.set('nx-key', 'second', 201, 60); // should be ignored

    const result = await adapter.get('nx-key');
    expect(result!.response).toBe('first');
    expect(result!.status).toBe(200);
  });

  test('keys are namespaced with prefix', async () => {
    const redis = makeRedis();
    const adapter = createRedisIdempotencyAdapter(redis, 'myapp');

    await adapter.set('k', 'v', 200, 60);
    expect(redis.store.has('idempotency:myapp:k')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQLite adapter
// ---------------------------------------------------------------------------

describe('createSqliteIdempotencyAdapter', () => {
  function makeSqliteDb() {
    const rows = new Map<string, Record<string, unknown>>();
    let failSql: string | null = null;
    let failTimes = 0;

    return {
      ranSql: [] as string[],
      failOn(sql: string, times = 1) {
        failSql = sql;
        failTimes = times;
      },
      run(sql: string, params?: unknown[]) {
        this.ranSql.push(sql);
        const normalized = sql.trim();
        if (failSql === normalized && failTimes > 0) {
          failTimes--;
          throw new Error(`forced failure: ${normalized}`);
        }
        if (sql.includes('INSERT OR IGNORE') && params) {
          const key = params[0] as string;
          if (rows.has(key)) return; // IGNORE
          rows.set(key, {
            key,
            status: params[1] as number,
            body: params[2] as string,
            createdAt: params[3] as number,
            expiresAt: params[4] as number,
            requestFingerprint: params[5] as string | null,
          });
        }
      },
      query<T>(sql: string) {
        this.ranSql.push(sql);
        if (sql.includes('PRAGMA table_info')) {
          return {
            all() {
              return [
                { name: 'key' },
                { name: 'status' },
                { name: 'body' },
                { name: 'createdAt' },
                { name: 'expiresAt' },
                { name: 'requestFingerprint' },
              ] as T[];
            },
          };
        }
        return {
          all() {
            return [] as T[];
          },
          get(...params: unknown[]) {
            if (!params.length) return null;
            const key = params[0] as string;
            const now = params[1] as number;
            const row = rows.get(key);
            if (!row) return null;
            if ((row.expiresAt as number) <= now) return null;
            return row as T;
          },
        };
      },
    };
  }

  test('creates table on first access', async () => {
    const db = makeSqliteDb();
    const adapter = createSqliteIdempotencyAdapter(db as never);

    await adapter.set('k', 'v', 200, 60);
    expect(db.ranSql.slice(0, 2)).toEqual(['PRAGMA busy_timeout = 5000', 'BEGIN IMMEDIATE']);
    expect(db.ranSql.some(s => s.includes('CREATE TABLE IF NOT EXISTS'))).toBe(true);
    expect(db.ranSql).toContain('COMMIT');
  });

  test('set and get round-trip', async () => {
    const db = makeSqliteDb();
    const adapter = createSqliteIdempotencyAdapter(db as never);

    await adapter.set('key1', '{"ok":true}', 200, 60);
    const result = await adapter.get('key1');

    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(result!.response).toBe('{"ok":true}');
  });

  test('get returns null for missing key', async () => {
    const db = makeSqliteDb();
    const adapter = createSqliteIdempotencyAdapter(db as never);

    const result = await adapter.get('missing');
    expect(result).toBeNull();
  });

  test('set with requestFingerprint', async () => {
    const db = makeSqliteDb();
    const adapter = createSqliteIdempotencyAdapter(db as never);

    await adapter.set('k', 'v', 200, 60, { requestFingerprint: 'fp-123' });
    const result = await adapter.get('k');
    expect(result!.requestFingerprint).toBe('fp-123');
  });

  test('only initializes table once', async () => {
    const db = makeSqliteDb();
    const adapter = createSqliteIdempotencyAdapter(db as never);

    await adapter.set('k1', 'v', 200, 60);
    const countBefore = db.ranSql.filter(s => s.includes('CREATE TABLE')).length;

    await adapter.set('k2', 'v', 200, 60);
    const countAfter = db.ranSql.filter(s => s.includes('CREATE TABLE')).length;

    expect(countAfter).toBe(countBefore);
  });

  test('rolls back failed bootstrap work and retries', async () => {
    const db = makeSqliteDb();
    db.failOn(
      `CREATE TABLE IF NOT EXISTS idempotency (
      key       TEXT PRIMARY KEY,
      status    INTEGER NOT NULL,
      body      TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      requestFingerprint TEXT
    )`,
    );
    const adapter = createSqliteIdempotencyAdapter(db as never);

    expect(() => adapter.set('k', 'v', 200, 60)).toThrow('forced failure');
    expect(db.ranSql).toContain('ROLLBACK');

    db.ranSql.length = 0;
    await adapter.set('k', 'v', 200, 60);
    expect(db.ranSql).toContain('COMMIT');
  });
});

// ---------------------------------------------------------------------------
// Postgres adapter
// ---------------------------------------------------------------------------

describe('createPostgresIdempotencyAdapter', () => {
  function makePgPool() {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const store = new Map<string, Record<string, unknown>>();
    let failSql: string | null = null;
    let failTimes = 0;

    const runQuery = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (failSql === normalized && failTimes > 0) {
        failTimes--;
        throw new Error(`forced failure: ${normalized}`);
      }
      if (sql.includes('CREATE TABLE') || sql.includes('ALTER TABLE') || sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO')) {
        if (params) {
          const key = params[0] as string;
          if (!store.has(key)) {
            store.set(key, {
              key,
              status: params[1] as number,
              body: params[2] as string,
              created_at: params[3] as number,
              expires_at: params[4] as number,
              request_fingerprint: params[5] as string | null,
            });
          }
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT')) {
        if (params) {
          const key = params[0] as string;
          const now = params[1] as number;
          const row = store.get(key);
          if (row && (row.expires_at as number) > now) {
            return { rows: [row], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    };

    return {
      queries,
      store,
      failOn(sql: string, times = 1) {
        failSql = sql;
        failTimes = times;
      },
      query: runQuery,
      connect: async () => ({
        query: runQuery,
        release: () => {},
      }),
    };
  }

  test('creates table on first access', async () => {
    const pool = makePgPool();
    const adapter = createPostgresIdempotencyAdapter(pool);

    await adapter.set('k', 'v', 200, 60);
    expect(pool.queries[0].sql).toBe('BEGIN');
    expect(pool.queries.some(q => q.sql.includes('CREATE TABLE IF NOT EXISTS'))).toBe(true);
    expect(pool.queries.some(q => q.sql === 'COMMIT')).toBe(true);
  });

  test('set and get round-trip', async () => {
    const pool = makePgPool();
    const adapter = createPostgresIdempotencyAdapter(pool);

    await adapter.set('key1', '{"ok":true}', 200, 60);
    const result = await adapter.get('key1');

    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(result!.response).toBe('{"ok":true}');
  });

  test('get returns null for missing key', async () => {
    const pool = makePgPool();
    const adapter = createPostgresIdempotencyAdapter(pool);

    const result = await adapter.get('missing');
    expect(result).toBeNull();
  });

  test('set with requestFingerprint', async () => {
    const pool = makePgPool();
    const adapter = createPostgresIdempotencyAdapter(pool);

    await adapter.set('k', 'v', 200, 60, { requestFingerprint: 'fp-xyz' });
    const result = await adapter.get('k');
    expect(result!.requestFingerprint).toBe('fp-xyz');
  });

  test('only initializes table once', async () => {
    const pool = makePgPool();
    const adapter = createPostgresIdempotencyAdapter(pool);

    await adapter.set('k1', 'v', 200, 60);
    const countBefore = pool.queries.filter(q => q.sql.includes('CREATE TABLE')).length;

    await adapter.set('k2', 'v', 200, 60);
    const countAfter = pool.queries.filter(q => q.sql.includes('CREATE TABLE')).length;

    expect(countAfter).toBe(countBefore);
  });

  test('rolls back failed bootstrap work and retries', async () => {
    const pool = makePgPool();
    pool.failOn(
      'CREATE TABLE IF NOT EXISTS slingshot_idempotency ( key TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, request_fingerprint TEXT )',
    );
    const adapter = createPostgresIdempotencyAdapter(pool);

    await expect(adapter.set('k', 'v', 200, 60)).rejects.toThrow('forced failure');
    expect(pool.queries.some(q => q.sql === 'ROLLBACK')).toBe(true);

    pool.queries.length = 0;
    await adapter.set('k', 'v', 200, 60);
    expect(pool.queries[0].sql).toBe('BEGIN');
    expect(pool.queries.some(q => q.sql === 'COMMIT')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mongo adapter
// ---------------------------------------------------------------------------

describe('createMongoIdempotencyAdapter', () => {
  function makeMongoSetup() {
    const store = new Map<string, Record<string, unknown>>();

    const model = {
      findOne(filter: Record<string, unknown>) {
        return {
          lean: async () => {
            const key = filter.key as string;
            const entry = store.get(key);
            if (!entry) return null;
            return {
              status: entry.status,
              body: entry.body,
              createdAt: { getTime: () => entry.createdAt },
              requestFingerprint: entry.requestFingerprint,
            };
          },
        };
      },
      async create(doc: Record<string, unknown>) {
        const key = doc.key as string;
        if (store.has(key)) {
          const err = new Error('Duplicate key') as Error & { code: number };
          err.code = 11000;
          throw err;
        }
        store.set(key, {
          status: doc.status,
          body: doc.body,
          createdAt: Date.now(),
          requestFingerprint: doc.requestFingerprint ?? null,
        });
      },
    };

    const mockSchema = function () {};
    mockSchema.prototype.index = function () { return this; };

    const mongoosePkg = {
      Schema: function () {
        return { index: () => ({}) };
      },
    };

    const connModels: Record<string, unknown> = {};
    const conn = {
      models: connModels,
      model() {
        conn.models['Idempotency'] = model;
        return model;
      },
    };

    return { conn, mongoosePkg, model, store };
  }

  test('set and get round-trip', async () => {
    const { conn, mongoosePkg } = makeMongoSetup();
    const adapter = createMongoIdempotencyAdapter(conn, mongoosePkg);

    await adapter.set('key1', '{"ok":true}', 200, 60);
    const result = await adapter.get('key1');

    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(result!.response).toBe('{"ok":true}');
  });

  test('get returns null for missing key', async () => {
    const { conn, mongoosePkg } = makeMongoSetup();
    const adapter = createMongoIdempotencyAdapter(conn, mongoosePkg);

    const result = await adapter.get('missing');
    expect(result).toBeNull();
  });

  test('set with requestFingerprint', async () => {
    const { conn, mongoosePkg } = makeMongoSetup();
    const adapter = createMongoIdempotencyAdapter(conn, mongoosePkg);

    await adapter.set('k', 'v', 200, 60, { requestFingerprint: 'fp-mongo' });
    const result = await adapter.get('k');
    expect(result!.requestFingerprint).toBe('fp-mongo');
  });

  test('NX semantics — duplicate key is silently ignored', async () => {
    const { conn, mongoosePkg } = makeMongoSetup();
    const adapter = createMongoIdempotencyAdapter(conn, mongoosePkg);

    await adapter.set('dup', 'first', 200, 60);
    // Should not throw — duplicate key (11000) is swallowed
    await adapter.set('dup', 'second', 201, 60);

    const result = await adapter.get('dup');
    expect(result!.response).toBe('first');
  });

  test('non-duplicate errors are re-thrown', async () => {
    const { conn, mongoosePkg } = makeMongoSetup();
    createMongoIdempotencyAdapter(conn, mongoosePkg);

    // Override the model to throw a non-duplicate error
    (conn.models['Idempotency'] as any) = undefined; // reset
    conn.model = function () {
      const m = {
        findOne: () => ({ lean: async () => null }),
        create: async () => {
          const err = new Error('Some DB error') as Error & { code: number };
          err.code = 12345;
          throw err;
        },
      };
      conn.models['Idempotency'] = m;
      return m;
    } as typeof conn.model;

    // Create a fresh adapter with the error-throwing model
    const errorAdapter = createMongoIdempotencyAdapter(conn, mongoosePkg);
    await expect(errorAdapter.set('k', 'v', 200, 60)).rejects.toThrow('Some DB error');
  });

  test('reuses existing model on subsequent calls', async () => {
    const { conn, mongoosePkg } = makeMongoSetup();
    const adapter = createMongoIdempotencyAdapter(conn, mongoosePkg);

    await adapter.set('k1', 'v', 200, 60);
    await adapter.get('k1');
    // If model reuse works, no error from double-registration
  });
});
