/**
 * Tests for upload registry backend adapters:
 *   - Redis (createRedisUploadRegistry)
 *   - SQLite (createSqliteUploadRegistry)
 *   - Postgres (createPostgresUploadRegistry)
 *   - Mongo (createMongoUploadRegistry)
 */
import { describe, expect, test } from 'bun:test';
import {
  createRedisUploadRegistry,
  createSqliteUploadRegistry,
  createPostgresUploadRegistry,
  createMongoUploadRegistry,
  createUploadRegistryFactories,
} from '../../src/framework/persistence/uploadRegistry';

function makeRecord(key = 'upload-1') {
  return {
    key,
    ownerUserId: 'user-1',
    tenantId: 'tenant-1',
    mimeType: 'image/png',
    bucket: 'uploads',
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Redis adapter
// ---------------------------------------------------------------------------

describe('createRedisUploadRegistry', () => {
  function makeRedis() {
    const store = new Map<string, string>();
    return {
      store,
      async get(key: string) { return store.get(key) ?? null; },
      async set(key: string, value: string) {
        store.set(key, value);
        return 'OK';
      },
      async del(key: string) {
        const existed = store.has(key);
        store.delete(key);
        return existed ? 1 : 0;
      },
    };
  }

  test('register and get round-trip', async () => {
    const redis = makeRedis();
    const repo = createRedisUploadRegistry(redis, 'app');

    const rec = makeRecord();
    await repo.register(rec);
    const result = await repo.get('upload-1');

    expect(result).not.toBeNull();
    expect(result!.key).toBe('upload-1');
    expect(result!.ownerUserId).toBe('user-1');
    expect(result!.mimeType).toBe('image/png');
  });

  test('get returns null for missing key', async () => {
    const redis = makeRedis();
    const repo = createRedisUploadRegistry(redis, 'app');

    expect(await repo.get('missing')).toBeNull();
  });

  test('delete returns true for existing key', async () => {
    const redis = makeRedis();
    const repo = createRedisUploadRegistry(redis, 'app');

    await repo.register(makeRecord());
    const deleted = await repo.delete('upload-1');
    expect(deleted).toBe(true);
  });

  test('delete returns false for non-existent key', async () => {
    const redis = makeRedis();
    const repo = createRedisUploadRegistry(redis, 'app');

    const deleted = await repo.delete('missing');
    expect(deleted).toBe(false);
  });

  test('keys are namespaced', async () => {
    const redis = makeRedis();
    const repo = createRedisUploadRegistry(redis, 'myapp');

    await repo.register(makeRecord());
    expect(redis.store.has('ur:myapp:upload-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQLite adapter
// ---------------------------------------------------------------------------

describe('createSqliteUploadRegistry', () => {
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
        if (sql.includes('INSERT OR REPLACE') && params) {
          rows.set(params[0] as string, {
            key: params[0],
            owner_user_id: params[1],
            tenant_id: params[2],
            mime_type: params[3],
            bucket: params[4],
            created_at: params[5],
            expires_at: params[6],
          });
        }
        if (sql.includes('DELETE FROM upload_registry WHERE key') && params) {
          rows.delete(params[0] as string);
        }
        if (sql.includes('DELETE FROM upload_registry WHERE expires_at')) {
          // Cleanup expired - no-op in test
        }
      },
      query<T>(sql: string) {
        return {
          get(...params: unknown[]) {
            if (sql.includes('changes()')) {
              const changes = { changes: 1 };
              return changes as T;
            }
            if (!params.length) return null;
            const key = params[0] as string;
            const row = rows.get(key);
            if (!row) return null;
            return row as T;
          },
          all() { return [] as T[]; },
        };
      },
    };
  }

  test('creates table on first access', async () => {
    const db = makeSqliteDb();
    const repo = createSqliteUploadRegistry(db as never);

    await repo.register(makeRecord());
    expect(db.ranSql.slice(0, 2)).toEqual(['PRAGMA busy_timeout = 5000', 'BEGIN IMMEDIATE']);
    expect(db.ranSql.some(s => s.includes('CREATE TABLE IF NOT EXISTS'))).toBe(true);
    expect(db.ranSql).toContain('COMMIT');
  });

  test('register and get round-trip', async () => {
    const db = makeSqliteDb();
    const repo = createSqliteUploadRegistry(db as never);

    await repo.register(makeRecord());
    const result = await repo.get('upload-1');

    expect(result).not.toBeNull();
    expect(result!.key).toBe('upload-1');
  });

  test('get returns null for missing key', async () => {
    const db = makeSqliteDb();
    const repo = createSqliteUploadRegistry(db as never);

    expect(await repo.get('missing')).toBeNull();
  });

  test('delete works', async () => {
    const db = makeSqliteDb();
    const repo = createSqliteUploadRegistry(db as never);

    await repo.register(makeRecord());
    const deleted = await repo.delete('upload-1');
    expect(deleted).toBe(true);
  });

  test('rolls back failed bootstrap work and retries', async () => {
    const db = makeSqliteDb();
    db.failOn(
      `CREATE TABLE IF NOT EXISTS upload_registry (
      key          TEXT PRIMARY KEY,
      owner_user_id TEXT,
      tenant_id    TEXT,
      mime_type    TEXT,
      bucket       TEXT,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    )`,
    );
    const repo = createSqliteUploadRegistry(db as never);

    expect(() => repo.register(makeRecord())).toThrow('forced failure');
    expect(db.ranSql).toContain('ROLLBACK');

    db.ranSql.length = 0;
    await repo.register(makeRecord());
    expect(db.ranSql).toContain('COMMIT');
  });
});

// ---------------------------------------------------------------------------
// Postgres adapter
// ---------------------------------------------------------------------------

describe('createPostgresUploadRegistry', () => {
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
      if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('CREATE TABLE')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO') && params) {
        store.set(params[0] as string, {
          key: params[0],
          owner_user_id: params[1],
          tenant_id: params[2],
          mime_type: params[3],
          bucket: params[4],
          created_at: params[5],
          expires_at: params[6],
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT') && params) {
        const row = store.get(params[0] as string);
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('DELETE') && params) {
        const existed = store.has(params[0] as string);
        store.delete(params[0] as string);
        return { rows: [], rowCount: existed ? 1 : 0 };
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
    const repo = createPostgresUploadRegistry(pool);

    await repo.register(makeRecord());
    expect(pool.queries[0].sql).toBe('BEGIN');
    expect(pool.queries.some(q => q.sql.includes('CREATE TABLE IF NOT EXISTS'))).toBe(true);
    expect(pool.queries.some(q => q.sql === 'COMMIT')).toBe(true);
  });

  test('register and get round-trip', async () => {
    const pool = makePgPool();
    const repo = createPostgresUploadRegistry(pool);

    await repo.register(makeRecord());
    const result = await repo.get('upload-1');

    expect(result).not.toBeNull();
    expect(result!.key).toBe('upload-1');
  });

  test('get returns null for missing key', async () => {
    const pool = makePgPool();
    const repo = createPostgresUploadRegistry(pool);

    expect(await repo.get('missing')).toBeNull();
  });

  test('delete returns true for existing key', async () => {
    const pool = makePgPool();
    const repo = createPostgresUploadRegistry(pool);

    await repo.register(makeRecord());
    const deleted = await repo.delete('upload-1');
    expect(deleted).toBe(true);
  });

  test('delete returns false for non-existent key', async () => {
    const pool = makePgPool();
    const repo = createPostgresUploadRegistry(pool);

    const deleted = await repo.delete('missing');
    expect(deleted).toBe(false);
  });

  test('rolls back failed bootstrap work and retries', async () => {
    const pool = makePgPool();
    pool.failOn(
      'CREATE TABLE IF NOT EXISTS slingshot_upload_registry ( key TEXT PRIMARY KEY, owner_user_id TEXT, tenant_id TEXT, mime_type TEXT, bucket TEXT, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL )',
    );
    const repo = createPostgresUploadRegistry(pool);

    await expect(repo.register(makeRecord())).rejects.toThrow('forced failure');
    expect(pool.queries.some(q => q.sql === 'ROLLBACK')).toBe(true);

    pool.queries.length = 0;
    await repo.register(makeRecord());
    expect(pool.queries[0].sql).toBe('BEGIN');
    expect(pool.queries.some(q => q.sql === 'COMMIT')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mongo adapter
// ---------------------------------------------------------------------------

describe('createMongoUploadRegistry', () => {
  function makeMongoSetup() {
    const store = new Map<string, Record<string, unknown>>();

    const model = {
      updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const key = filter.key as string;
        const data = (update as any).$set;
        store.set(key, data);
      },
      findOne(filter: Record<string, unknown>) {
        return {
          lean: async () => {
            const doc = store.get(filter.key as string);
            return doc ?? null;
          },
        };
      },
      deleteOne: async (filter: Record<string, unknown>) => {
        const existed = store.has(filter.key as string);
        store.delete(filter.key as string);
        return { deletedCount: existed ? 1 : 0 };
      },
    };

    const mongoosePkg = {
      Schema: function () {
        return { index: () => ({}) };
      },
    };

    const connModels = {};
    const conn = {
      models: connModels as Record<string, unknown>,
      model() {
        conn.models['UploadRegistry'] = model;
        return model;
      },
    };

    return { conn, mongoosePkg, store };
  }

  test('register and get round-trip', async () => {
    const { conn, mongoosePkg } = makeMongoSetup();
    const repo = createMongoUploadRegistry(conn, mongoosePkg);

    await repo.register(makeRecord());
    const result = await repo.get('upload-1');

    expect(result).not.toBeNull();
    expect(result!.key).toBe('upload-1');
  });

  test('get returns null for missing key', async () => {
    const { conn, mongoosePkg } = makeMongoSetup();
    const repo = createMongoUploadRegistry(conn, mongoosePkg);

    expect(await repo.get('missing')).toBeNull();
  });

  test('delete returns true for existing key', async () => {
    const { conn, mongoosePkg } = makeMongoSetup();
    const repo = createMongoUploadRegistry(conn, mongoosePkg);

    await repo.register(makeRecord());
    const deleted = await repo.delete('upload-1');
    expect(deleted).toBe(true);
  });

  test('delete returns false for non-existent key', async () => {
    const { conn, mongoosePkg } = makeMongoSetup();
    const repo = createMongoUploadRegistry(conn, mongoosePkg);

    const deleted = await repo.delete('missing');
    expect(deleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

describe('createUploadRegistryFactories', () => {
  test('returns a factory map with all backends', () => {
    const factories = createUploadRegistryFactories();
    expect(typeof factories.memory).toBe('function');
    expect(typeof factories.sqlite).toBe('function');
    expect(typeof factories.redis).toBe('function');
    expect(typeof factories.mongo).toBe('function');
    expect(typeof factories.postgres).toBe('function');
  });

  test('memory factory creates a working adapter', () => {
    const factories = createUploadRegistryFactories();
    const stub = {};
    const adapter = factories.memory!(stub as never);
    expect(typeof adapter.register).toBe('function');
    expect(typeof adapter.get).toBe('function');
  });
});
