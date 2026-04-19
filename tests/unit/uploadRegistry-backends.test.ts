import { describe, expect, test } from 'bun:test';
import {
  createMemoryUploadRegistry,
  createRedisUploadRegistry,
  createSqliteUploadRegistry,
  createPostgresUploadRegistry,
  createMongoUploadRegistry,
  createUploadRegistryFactories,
  DEFAULT_UPLOAD_REGISTRY_TTL_SECONDS,
} from '../../src/framework/persistence/uploadRegistry';

// ---------------------------------------------------------------------------
// Memory adapter — TTL expiry, delete, clear
// ---------------------------------------------------------------------------

describe('createMemoryUploadRegistry', () => {
  test('returns null for expired entries', async () => {
    const registry = createMemoryUploadRegistry(0); // 0 second TTL

    await registry.register({ key: 'expired', createdAt: Date.now() - 5000 });
    await new Promise(r => setTimeout(r, 5));

    const result = await registry.get('expired');
    expect(result).toBeNull();
  });

  test('delete returns true when key existed', async () => {
    const registry = createMemoryUploadRegistry();
    await registry.register({ key: 'del-key', createdAt: Date.now() });

    const result = await registry.delete('del-key');
    expect(result).toBe(true);
  });

  test('delete returns false when key did not exist', async () => {
    const registry = createMemoryUploadRegistry();

    const result = await registry.delete('nonexistent');
    expect(result).toBe(false);
  });

  test('stores and retrieves all optional fields', async () => {
    const registry = createMemoryUploadRegistry();
    const now = Date.now();
    await registry.register({
      key: 'full-record',
      ownerUserId: 'user-1',
      tenantId: 'tenant-1',
      mimeType: 'image/png',
      bucket: 'uploads',
      createdAt: now,
    });

    const result = await registry.get('full-record');
    expect(result).not.toBeNull();
    expect(result!.ownerUserId).toBe('user-1');
    expect(result!.tenantId).toBe('tenant-1');
    expect(result!.mimeType).toBe('image/png');
    expect(result!.bucket).toBe('uploads');
    expect(result!.createdAt).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// Redis adapter
// ---------------------------------------------------------------------------

describe('createRedisUploadRegistry', () => {
  function createMockRedis() {
    const store = new Map<string, { value: string; expiresAt: number }>();
    return {
      store,
      async get(key: string) {
        const entry = store.get(key);
        if (!entry || Date.now() > entry.expiresAt) {
          store.delete(key);
          return null;
        }
        return entry.value;
      },
      async set(key: string, value: string, exFlag?: 'EX', ttl?: number) {
        const expiresAt = ttl ? Date.now() + ttl * 1000 : Date.now() + 86400 * 1000;
        store.set(key, { value, expiresAt });
        return 'OK';
      },
      async del(key: string) {
        return store.delete(key) ? 1 : 0;
      },
    };
  }

  test('register and get a record', async () => {
    const redis = createMockRedis();
    const registry = createRedisUploadRegistry(redis, 'testapp');

    const now = Date.now();
    await registry.register({
      key: 'upload-1',
      ownerUserId: 'user-1',
      createdAt: now,
    });

    const result = await registry.get('upload-1');
    expect(result).not.toBeNull();
    expect(result!.key).toBe('upload-1');
    expect(result!.ownerUserId).toBe('user-1');
  });

  test('get returns null for missing key', async () => {
    const redis = createMockRedis();
    const registry = createRedisUploadRegistry(redis, 'testapp');

    const result = await registry.get('nonexistent');
    expect(result).toBeNull();
  });

  test('delete returns true for existing key', async () => {
    const redis = createMockRedis();
    const registry = createRedisUploadRegistry(redis, 'testapp');

    await registry.register({ key: 'del-key', createdAt: Date.now() });
    const result = await registry.delete('del-key');
    expect(result).toBe(true);
  });

  test('delete returns false for missing key', async () => {
    const redis = createMockRedis();
    const registry = createRedisUploadRegistry(redis, 'testapp');

    const result = await registry.delete('nonexistent');
    expect(result).toBe(false);
  });

  test('uses namespaced redis keys', async () => {
    const redis = createMockRedis();
    const registry = createRedisUploadRegistry(redis, 'myapp');

    await registry.register({ key: 'k1', createdAt: Date.now() });
    expect(redis.store.has('ur:myapp:k1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQLite adapter
// ---------------------------------------------------------------------------

describe('createSqliteUploadRegistry', () => {
  function createMockSqliteDb() {
    const { Database } = require('bun:sqlite');
    const db = new Database(':memory:');
    return {
      run(sql: string, params?: unknown[]) {
        if (params && params.length > 0) {
          db.prepare(sql).run(...params);
        } else {
          db.exec(sql);
        }
      },
      query<T>(sql: string) {
        const stmt = db.prepare(sql);
        return {
          get(...args: unknown[]): T | null {
            return stmt.get(...args) as T | null;
          },
          all(...args: unknown[]): T[] {
            return stmt.all(...args) as T[];
          },
        };
      },
      close() {
        db.close();
      },
    };
  }

  test('register and get a record', async () => {
    const db = createMockSqliteDb();
    const registry = createSqliteUploadRegistry(db);

    const now = Date.now();
    await registry.register({
      key: 'sqlite-upload',
      ownerUserId: 'user-1',
      tenantId: 'tenant-1',
      mimeType: 'text/plain',
      bucket: 'files',
      createdAt: now,
    });

    const result = await registry.get('sqlite-upload');
    expect(result).not.toBeNull();
    expect(result!.key).toBe('sqlite-upload');
    expect(result!.ownerUserId).toBe('user-1');
    expect(result!.tenantId).toBe('tenant-1');
    expect(result!.mimeType).toBe('text/plain');
    expect(result!.bucket).toBe('files');
    expect(result!.createdAt).toBe(now);

    db.close();
  });

  test('get returns null for missing key', async () => {
    const db = createMockSqliteDb();
    const registry = createSqliteUploadRegistry(db);

    const result = await registry.get('nonexistent');
    expect(result).toBeNull();

    db.close();
  });

  test('get returns null for expired entries', async () => {
    const db = createMockSqliteDb();
    const registry = createSqliteUploadRegistry(db, 0); // 0 TTL

    await registry.register({ key: 'expired', createdAt: Date.now() });
    await new Promise(r => setTimeout(r, 5));

    const result = await registry.get('expired');
    expect(result).toBeNull();

    db.close();
  });

  test('register overwrites existing key (INSERT OR REPLACE)', async () => {
    const db = createMockSqliteDb();
    const registry = createSqliteUploadRegistry(db);

    await registry.register({ key: 'replace-key', ownerUserId: 'user-1', createdAt: Date.now() });
    await registry.register({ key: 'replace-key', ownerUserId: 'user-2', createdAt: Date.now() });

    const result = await registry.get('replace-key');
    expect(result).not.toBeNull();
    expect(result!.ownerUserId).toBe('user-2');

    db.close();
  });

  test('delete removes existing key', async () => {
    const db = createMockSqliteDb();
    const registry = createSqliteUploadRegistry(db);

    await registry.register({ key: 'del-key', createdAt: Date.now() });
    const deleted = await registry.delete('del-key');
    // After delete, get returns null
    const result = await registry.get('del-key');
    expect(result).toBeNull();

    db.close();
  });

  test('handles null optional fields', async () => {
    const db = createMockSqliteDb();
    const registry = createSqliteUploadRegistry(db);

    await registry.register({ key: 'minimal', createdAt: Date.now() });

    const result = await registry.get('minimal');
    expect(result).not.toBeNull();
    expect(result!.ownerUserId).toBeUndefined();
    expect(result!.tenantId).toBeUndefined();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Postgres adapter
// ---------------------------------------------------------------------------

describe('createPostgresUploadRegistry', () => {
  function createMockPgPool() {
    const rows: Record<string, Record<string, unknown>> = {};

    return {
      async query(sql: string, params?: unknown[]) {
        const trimmed = sql.trim();
        if (trimmed.startsWith('CREATE TABLE')) {
          return { rows: [], rowCount: 0 };
        }
        if (trimmed.startsWith('SELECT')) {
          const key = params?.[0] as string;
          const now = params?.[1] as number;
          const row = rows[key];
          if (!row || (row['expires_at'] as number) <= now) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [row], rowCount: 1 };
        }
        if (trimmed.startsWith('INSERT')) {
          const key = params?.[0] as string;
          rows[key] = {
            key,
            owner_user_id: params?.[1] as string | null,
            tenant_id: params?.[2] as string | null,
            mime_type: params?.[3] as string | null,
            bucket: params?.[4] as string | null,
            created_at: params?.[5] as number,
            expires_at: params?.[6] as number,
          };
          return { rows: [], rowCount: 1 };
        }
        if (trimmed.startsWith('DELETE')) {
          const key = params?.[0] as string;
          if (rows[key]) {
            delete rows[key];
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
  }

  test('register and get a record', async () => {
    const pool = createMockPgPool();
    const registry = createPostgresUploadRegistry(pool);

    const now = Date.now();
    await registry.register({
      key: 'pg-upload',
      ownerUserId: 'user-1',
      createdAt: now,
    });

    const result = await registry.get('pg-upload');
    expect(result).not.toBeNull();
    expect(result!.key).toBe('pg-upload');
    expect(result!.ownerUserId).toBe('user-1');
    expect(result!.createdAt).toBe(now);
  });

  test('get returns null for missing key', async () => {
    const pool = createMockPgPool();
    const registry = createPostgresUploadRegistry(pool);

    const result = await registry.get('nonexistent');
    expect(result).toBeNull();
  });

  test('delete returns true for existing key', async () => {
    const pool = createMockPgPool();
    const registry = createPostgresUploadRegistry(pool);

    await registry.register({ key: 'del-key', createdAt: Date.now() });
    const result = await registry.delete('del-key');
    expect(result).toBe(true);
  });

  test('delete returns false for missing key', async () => {
    const pool = createMockPgPool();
    const registry = createPostgresUploadRegistry(pool);

    const result = await registry.delete('nonexistent');
    expect(result).toBe(false);
  });

  test('handles null optional fields', async () => {
    const pool = createMockPgPool();
    const registry = createPostgresUploadRegistry(pool);

    await registry.register({ key: 'minimal', createdAt: Date.now() });
    const result = await registry.get('minimal');
    expect(result).not.toBeNull();
    expect(result!.ownerUserId).toBeUndefined();
    expect(result!.tenantId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MongoDB adapter
// ---------------------------------------------------------------------------

describe('createMongoUploadRegistry', () => {
  function createMockMongoEnv() {
    const docs: Record<string, Record<string, unknown>> = {};
    const mockModel = {
      updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, _opts: Record<string, unknown>) {
        const key = filter['key'] as string;
        const setData = update['$set'] as Record<string, unknown>;
        docs[key] = { ...setData };
        return Promise.resolve();
      },
      findOne(filter: Record<string, unknown>) {
        return {
          lean() {
            const key = filter['key'] as string;
            const doc = docs[key];
            if (!doc) return Promise.resolve(null);
            return Promise.resolve(doc);
          },
        };
      },
      deleteOne(filter: Record<string, unknown>) {
        const key = filter['key'] as string;
        if (docs[key]) {
          delete docs[key];
          return Promise.resolve({ deletedCount: 1 });
        }
        return Promise.resolve({ deletedCount: 0 });
      },
    };

    const appConn = {
      models: { UploadRegistry: mockModel } as Record<string, unknown>,
      model(_name: string, _schema: unknown) {
        return mockModel;
      },
    };

    const mongoosePkg = {
      Schema: class MockSchema {
        constructor(_def: unknown, _opts?: unknown) {}
        index() {}
      },
    };

    return { appConn, mongoosePkg, docs };
  }

  test('register and get a record', async () => {
    const { appConn, mongoosePkg } = createMockMongoEnv();
    const registry = createMongoUploadRegistry(appConn, mongoosePkg);

    const now = Date.now();
    await registry.register({
      key: 'mongo-upload',
      ownerUserId: 'user-1',
      tenantId: 'tenant-1',
      createdAt: now,
    });

    const result = await registry.get('mongo-upload');
    expect(result).not.toBeNull();
    expect(result!.key).toBe('mongo-upload');
    expect(result!.ownerUserId).toBe('user-1');
  });

  test('get returns null for missing key', async () => {
    const { appConn, mongoosePkg } = createMockMongoEnv();
    const registry = createMongoUploadRegistry(appConn, mongoosePkg);

    const result = await registry.get('nonexistent');
    expect(result).toBeNull();
  });

  test('delete returns true for existing key', async () => {
    const { appConn, mongoosePkg } = createMockMongoEnv();
    const registry = createMongoUploadRegistry(appConn, mongoosePkg);

    await registry.register({ key: 'del-key', createdAt: Date.now() });
    const result = await registry.delete('del-key');
    expect(result).toBe(true);
  });

  test('delete returns false for missing key', async () => {
    const { appConn, mongoosePkg } = createMockMongoEnv();
    const registry = createMongoUploadRegistry(appConn, mongoosePkg);

    const result = await registry.delete('nonexistent');
    expect(result).toBe(false);
  });

  test('creates model lazily when not in appConn.models', async () => {
    const docs: Record<string, Record<string, unknown>> = {};
    const mockModel = {
      updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
        docs[filter['key'] as string] = (update as any)['$set'];
        return Promise.resolve();
      },
      findOne(filter: Record<string, unknown>) {
        return {
          lean() {
            return Promise.resolve(docs[filter['key'] as string] ?? null);
          },
        };
      },
      deleteOne() {
        return Promise.resolve({ deletedCount: 0 });
      },
    };

    const appConn = {
      models: {} as Record<string, unknown>,
      model(_name: string, _schema: unknown) {
        return mockModel;
      },
    };

    class MockSchema {
      constructor(_def: unknown, _opts?: unknown) {}
      index() {}
    }

    const registry = createMongoUploadRegistry(appConn, { Schema: MockSchema });
    await registry.register({ key: 'lazy-key', createdAt: Date.now() });
    const result = await registry.get('lazy-key');
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createUploadRegistryFactories
// ---------------------------------------------------------------------------

describe('createUploadRegistryFactories', () => {
  test('returns a factories object with all backends', () => {
    const factories = createUploadRegistryFactories();
    expect(typeof factories.memory).toBe('function');
    expect(typeof factories.sqlite).toBe('function');
    expect(typeof factories.redis).toBe('function');
    expect(typeof factories.mongo).toBe('function');
    expect(typeof factories.postgres).toBe('function');
  });

  test('memory factory creates a working adapter', async () => {
    const factories = createUploadRegistryFactories(3600);
    const adapter = factories.memory!({} as any);

    await adapter.register({ key: 'test', createdAt: Date.now() });
    const result = await adapter.get('test');
    expect(result).not.toBeNull();
  });

  test('mongo factory calls infra.getMongo and returns a working adapter', async () => {
    const docs: Record<string, Record<string, unknown>> = {};
    const mockModel = {
      updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, _opts: Record<string, unknown>) {
        docs[filter['key'] as string] = (update as any)['$set'];
        return Promise.resolve();
      },
      findOne(filter: Record<string, unknown>) {
        return {
          lean() {
            return Promise.resolve(docs[filter['key'] as string] ?? null);
          },
        };
      },
      deleteOne() {
        return Promise.resolve({ deletedCount: 0 });
      },
    };

    const mockInfra = {
      getMongo: () => ({
        conn: {
          models: {} as Record<string, unknown>,
          model: () => mockModel,
        },
        mg: { Schema: class { index() {} } },
      }),
      appName: 'test',
    };

    const factories = createUploadRegistryFactories();
    const adapter = factories.mongo!(mockInfra as any);
    await adapter.register({ key: 'mongo-factory', createdAt: Date.now() });
    const result = await adapter.get('mongo-factory');
    expect(result).not.toBeNull();
  });
});
