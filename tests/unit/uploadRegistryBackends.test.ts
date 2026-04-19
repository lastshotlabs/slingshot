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
      async set(key: string, value: string, _ex?: 'EX', _ttl?: number) {
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

    return {
      ranSql: [] as string[],
      run(sql: string, params?: unknown[]) {
        this.ranSql.push(sql);
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
            if (sql.includes('changes()')) return { changes: 1 } as T;
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
    expect(db.ranSql.some(s => s.includes('CREATE TABLE IF NOT EXISTS'))).toBe(true);
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
});

// ---------------------------------------------------------------------------
// Postgres adapter
// ---------------------------------------------------------------------------

describe('createPostgresUploadRegistry', () => {
  function makePgPool() {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const store = new Map<string, Record<string, unknown>>();

    return {
      queries,
      store,
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
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
      },
    };
  }

  test('creates table on first access', async () => {
    const pool = makePgPool();
    const repo = createPostgresUploadRegistry(pool);

    await repo.register(makeRecord());
    expect(pool.queries.some(q => q.sql.includes('CREATE TABLE IF NOT EXISTS'))).toBe(true);
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

    const conn = {
      models: {} as Record<string, unknown>,
      model(_name: string, _schema: unknown) {
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
    const adapter = factories.memory!({} as never);
    expect(typeof adapter.register).toBe('function');
    expect(typeof adapter.get).toBe('function');
  });
});
