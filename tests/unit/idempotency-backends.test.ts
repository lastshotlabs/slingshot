import { describe, expect, test } from 'bun:test';
import {
  createMemoryIdempotencyAdapter,
  createMongoIdempotencyAdapter,
  createPostgresIdempotencyAdapter,
  createRedisIdempotencyAdapter,
  createSqliteIdempotencyAdapter,
  idempotencyFactories,
} from '../../src/framework/persistence/idempotency';

// ---------------------------------------------------------------------------
// Memory adapter — TTL expiry and NX semantics
// ---------------------------------------------------------------------------

describe('createMemoryIdempotencyAdapter', () => {
  test('returns null for expired entries (TTL branch)', async () => {
    const adapter = createMemoryIdempotencyAdapter();

    // Set with 0 TTL so it expires immediately
    await adapter.set('expired-key', '{"ok":true}', 200, 0);

    // Wait a tick so Date.now() moves past the expiresAt
    await new Promise(r => setTimeout(r, 5));

    const result = await adapter.get('expired-key');
    expect(result).toBeNull();
  });

  test('does not overwrite existing keys (NX semantics)', async () => {
    const adapter = createMemoryIdempotencyAdapter();

    await adapter.set('nx-key', '{"first":true}', 200, 60);
    await adapter.set('nx-key', '{"second":true}', 201, 60);

    const result = await adapter.get('nx-key');
    expect(result).not.toBeNull();
    expect(result!.response).toBe('{"first":true}');
    expect(result!.status).toBe(200);
  });

  test('stores and retrieves requestFingerprint', async () => {
    const adapter = createMemoryIdempotencyAdapter();
    await adapter.set('fp-key', '{}', 200, 60, { requestFingerprint: 'abc123' });

    const result = await adapter.get('fp-key');
    expect(result).not.toBeNull();
    expect(result!.requestFingerprint).toBe('abc123');
  });

  test('returns null requestFingerprint when meta is not provided', async () => {
    const adapter = createMemoryIdempotencyAdapter();
    await adapter.set('no-fp-key', '{}', 200, 60);

    const result = await adapter.get('no-fp-key');
    expect(result).not.toBeNull();
    expect(result!.requestFingerprint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Redis adapter
// ---------------------------------------------------------------------------

describe('createRedisIdempotencyAdapter', () => {
  function createMockRedis() {
    const store = new Map<string, { value: string; expiresAt: number }>();
    return {
      store,
      async get(key: string) {
        const entry = store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
          store.delete(key);
          return null;
        }
        return entry.value;
      },
      async set(key: string, value: string, exFlag: 'EX', ttl: number) {
        if (store.has(key)) return null; // NX semantics
        store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
        return 'OK';
      },
    };
  }

  test('set and get a record', async () => {
    const redis = createMockRedis();
    const adapter = createRedisIdempotencyAdapter(redis, 'testapp');

    await adapter.set('key-1', '{"ok":true}', 201, 60);

    const result = await adapter.get('key-1');
    expect(result).not.toBeNull();
    expect(result!.response).toBe('{"ok":true}');
    expect(result!.status).toBe(201);
    expect(result!.requestFingerprint).toBeNull();
  });

  test('get returns null for missing key', async () => {
    const redis = createMockRedis();
    const adapter = createRedisIdempotencyAdapter(redis, 'testapp');

    const result = await adapter.get('nonexistent');
    expect(result).toBeNull();
  });

  test('stores requestFingerprint in JSON payload', async () => {
    const redis = createMockRedis();
    const adapter = createRedisIdempotencyAdapter(redis, 'testapp');

    await adapter.set('fp-key', '{}', 200, 60, { requestFingerprint: 'fp-123' });

    const result = await adapter.get('fp-key');
    expect(result).not.toBeNull();
    expect(result!.requestFingerprint).toBe('fp-123');
  });

  test('uses namespaced redis keys', async () => {
    const redis = createMockRedis();
    const adapter = createRedisIdempotencyAdapter(redis, 'myapp');

    await adapter.set('k1', '{}', 200, 60);

    expect(redis.store.has('idempotency:myapp:k1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQLite adapter
// ---------------------------------------------------------------------------

describe('createSqliteIdempotencyAdapter', () => {
  function createMockSqliteDb() {
    // Use Bun's built-in SQLite for an in-memory database
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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
          run(...args: unknown[]): void {
            stmt.run(...args);
          },
        };
      },
      close() {
        db.close();
      },
    };
  }

  test('set and get a record', async () => {
    const db = createMockSqliteDb();
    const adapter = createSqliteIdempotencyAdapter(db);

    await adapter.set('sqlite-key', '{"ok":true}', 201, 60);
    const result = await adapter.get('sqlite-key');
    expect(result).not.toBeNull();
    expect(result!.response).toBe('{"ok":true}');
    expect(result!.status).toBe(201);

    db.close();
  });

  test('get returns null for expired records', async () => {
    const db = createMockSqliteDb();
    const adapter = createSqliteIdempotencyAdapter(db);

    await adapter.set('expired-key', '{}', 200, 0);
    await new Promise(r => setTimeout(r, 5));

    const result = await adapter.get('expired-key');
    expect(result).toBeNull();

    db.close();
  });

  test('get returns null for missing key', async () => {
    const db = createMockSqliteDb();
    const adapter = createSqliteIdempotencyAdapter(db);

    const result = await adapter.get('nonexistent');
    expect(result).toBeNull();

    db.close();
  });

  test('does not overwrite existing keys (INSERT OR IGNORE)', async () => {
    const db = createMockSqliteDb();
    const adapter = createSqliteIdempotencyAdapter(db);

    await adapter.set('nx-key', '{"first":true}', 200, 60);
    await adapter.set('nx-key', '{"second":true}', 201, 60);

    const result = await adapter.get('nx-key');
    expect(result).not.toBeNull();
    expect(result!.response).toBe('{"first":true}');

    db.close();
  });

  test('stores and retrieves requestFingerprint', async () => {
    const db = createMockSqliteDb();
    const adapter = createSqliteIdempotencyAdapter(db);

    await adapter.set('fp-key', '{}', 200, 60, { requestFingerprint: 'fp-sqlite' });
    const result = await adapter.get('fp-key');
    expect(result).not.toBeNull();
    expect(result!.requestFingerprint).toBe('fp-sqlite');

    db.close();
  });

  test('handles table with missing requestFingerprint column (migration)', async () => {
    const db = createMockSqliteDb();
    // Create the table without requestFingerprint column first
    db.run(`CREATE TABLE IF NOT EXISTS idempotency (
      key       TEXT PRIMARY KEY,
      status    INTEGER NOT NULL,
      body      TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);

    // The adapter should detect and add the missing column
    const adapter = createSqliteIdempotencyAdapter(db);
    await adapter.set('migrate-key', '{}', 200, 60);
    const result = await adapter.get('migrate-key');
    expect(result).not.toBeNull();
    expect(result!.requestFingerprint).toBeNull();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Postgres adapter
// ---------------------------------------------------------------------------

describe('createPostgresIdempotencyAdapter', () => {
  function createMockPgPool() {
    const rows: Record<string, Record<string, unknown>> = {};

    const runQuery = async (sql: string, params?: unknown[]) => {
      const trimmed = sql.trim();
      if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('CREATE TABLE')) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('ALTER TABLE')) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith('SELECT')) {
        const key = params?.[0] as string;
        const now = params?.[1] as number;
        const row = rows[key];
        if (!row) return { rows: [], rowCount: 0 };
        if ((row['expires_at'] as number) <= now) return { rows: [], rowCount: 0 };
        return { rows: [row], rowCount: 1 };
      }
      if (trimmed.startsWith('INSERT')) {
        const key = params?.[0] as string;
        // ON CONFLICT DO NOTHING — only insert if key doesn't exist
        if (!rows[key]) {
          rows[key] = {
            key,
            status: params?.[1] as number,
            body: params?.[2] as string,
            created_at: params?.[3] as number,
            expires_at: params?.[4] as number,
            request_fingerprint: params?.[5] as string | null,
          };
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    return {
      query: runQuery,
      connect: async () => ({
        query: runQuery,
        release: () => {},
      }),
    };
  }

  test('set and get a record', async () => {
    const pool = createMockPgPool();
    const adapter = createPostgresIdempotencyAdapter(pool);

    await adapter.set('pg-key', '{"ok":true}', 201, 60);
    const result = await adapter.get('pg-key');
    expect(result).not.toBeNull();
    expect(result!.response).toBe('{"ok":true}');
    expect(result!.status).toBe(201);
    expect(result!.requestFingerprint).toBeNull();
  });

  test('get returns null for missing key', async () => {
    const pool = createMockPgPool();
    const adapter = createPostgresIdempotencyAdapter(pool);

    const result = await adapter.get('nonexistent');
    expect(result).toBeNull();
  });

  test('stores requestFingerprint', async () => {
    const pool = createMockPgPool();
    const adapter = createPostgresIdempotencyAdapter(pool);

    await adapter.set('fp-key', '{}', 200, 60, { requestFingerprint: 'pg-fp' });
    const result = await adapter.get('fp-key');
    expect(result).not.toBeNull();
    expect(result!.requestFingerprint).toBe('pg-fp');
  });
});

// ---------------------------------------------------------------------------
// MongoDB adapter
// ---------------------------------------------------------------------------

describe('createMongoIdempotencyAdapter', () => {
  function createMockMongoEnv() {
    const docs: Record<string, Record<string, unknown>> = {};
    const mockModel = {
      findOne(filter: Record<string, unknown>) {
        return {
          lean() {
            const key = filter['key'] as string;
            const doc = docs[key];
            if (!doc) return Promise.resolve(null);
            const expiresGt = (filter['expiresAt'] as { $gt: Date }).$gt;
            if (doc['expiresAt'] && (doc['expiresAt'] as Date) <= expiresGt) {
              return Promise.resolve(null);
            }
            return Promise.resolve({
              ...doc,
              createdAt: { getTime: () => doc['createdAt'] as number },
            });
          },
        };
      },
      async create(docData: Record<string, unknown>) {
        const key = docData['key'] as string;
        if (docs[key]) {
          const err = new Error('Duplicate key');
          (err as any).code = 11000;
          throw err;
        }
        docs[key] = docData;
      },
    };

    const models: Record<string, unknown> = { Idempotency: mockModel };
    const appConn = {
      models,
      model() {
        return mockModel;
      },
    };

    // Minimal mock of mongoose Schema
    const mongoosePkg = {
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      Schema: class MockSchema {},
    };

    return { appConn, mongoosePkg, docs };
  }

  test('set and get a record', async () => {
    const { appConn, mongoosePkg } = createMockMongoEnv();
    const adapter = createMongoIdempotencyAdapter(appConn, mongoosePkg);

    await adapter.set('mongo-key', '{"ok":true}', 201, 60);
    const result = await adapter.get('mongo-key');
    expect(result).not.toBeNull();
    expect(result!.response).toBe('{"ok":true}');
    expect(result!.status).toBe(201);
  });

  test('get returns null for missing key', async () => {
    const { appConn, mongoosePkg } = createMockMongoEnv();
    const adapter = createMongoIdempotencyAdapter(appConn, mongoosePkg);

    const result = await adapter.get('nonexistent');
    expect(result).toBeNull();
  });

  test('NX semantics: does not overwrite on duplicate key (code 11000)', async () => {
    const { appConn, mongoosePkg } = createMockMongoEnv();
    const adapter = createMongoIdempotencyAdapter(appConn, mongoosePkg);

    await adapter.set('dup-key', '{"first":true}', 200, 60);
    // Should not throw — duplicate key error is swallowed
    await adapter.set('dup-key', '{"second":true}', 201, 60);

    const result = await adapter.get('dup-key');
    expect(result).not.toBeNull();
    expect(result!.response).toBe('{"first":true}');
  });

  test('NX semantics: swallows string code "11000"', async () => {
    const docs: Record<string, unknown> = {};
    const mockModel = {
      findOne() {
        return { lean: () => Promise.resolve(null) };
      },
      async create(docData: Record<string, unknown>) {
        const key = docData['key'] as string;
        if (docs[key]) {
          const err = new Error('Duplicate key');
          (err as any).code = '11000'; // string variant
          throw err;
        }
        docs[key] = docData;
      },
    };

    const swallowModels: Record<string, unknown> = { Idempotency: mockModel };
    const appConn = {
      models: swallowModels,
      model: () => mockModel,
    };
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    const adapter = createMongoIdempotencyAdapter(appConn, { Schema: class {} });

    await adapter.set('k', '{}', 200, 60);
    // Should not throw
    await adapter.set('k', '{}', 200, 60);
  });

  test('rethrows non-duplicate-key errors', async () => {
    const mockModel = {
      findOne() {
        return { lean: () => Promise.resolve(null) };
      },
      async create() {
        throw new Error('Connection lost');
      },
    };

    const rethrowModels: Record<string, unknown> = { Idempotency: mockModel };
    const appConn = {
      models: rethrowModels,
      model: () => mockModel,
    };
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    const adapter = createMongoIdempotencyAdapter(appConn, { Schema: class {} });

    await expect(adapter.set('k', '{}', 200, 60)).rejects.toThrow('Connection lost');
  });

  test('stores and retrieves requestFingerprint', async () => {
    const { appConn, mongoosePkg } = createMockMongoEnv();
    const adapter = createMongoIdempotencyAdapter(appConn, mongoosePkg);

    await adapter.set('fp-key', '{}', 200, 60, { requestFingerprint: 'mongo-fp' });
    const result = await adapter.get('fp-key');
    expect(result).not.toBeNull();
    expect(result!.requestFingerprint).toBe('mongo-fp');
  });

  test('creates model lazily when not in appConn.models', async () => {
    const docs: Record<string, Record<string, unknown>> = {};
    const mockModel = {
      findOne(filter: Record<string, unknown>) {
        return {
          lean() {
            const key = filter['key'] as string;
            const doc = docs[key];
            if (!doc) return Promise.resolve(null);
            return Promise.resolve({
              ...doc,
              createdAt: { getTime: () => doc['createdAt'] as number },
            });
          },
        };
      },
      async create(docData: Record<string, unknown>) {
        docs[docData['key'] as string] = docData;
      },
    };

    const lazyModels: Record<string, unknown> = {}; // empty — no pre-registered model
    const appConn = {
      models: lazyModels,
      model() {
        return mockModel;
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    class MockSchema {}

    const adapter = createMongoIdempotencyAdapter(appConn, { Schema: MockSchema });
    await adapter.set('lazy-key', '{"ok":true}', 200, 60);
    const result = await adapter.get('lazy-key');
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// idempotencyFactories
// ---------------------------------------------------------------------------

describe('idempotencyFactories', () => {
  test('has all expected backends', () => {
    expect(typeof idempotencyFactories.memory).toBe('function');
    expect(typeof idempotencyFactories.sqlite).toBe('function');
    expect(typeof idempotencyFactories.redis).toBe('function');
    expect(typeof idempotencyFactories.mongo).toBe('function');
    expect(typeof idempotencyFactories.postgres).toBe('function');
  });

  test('memory factory creates a working adapter', async () => {
    const adapter = idempotencyFactories.memory!({} as any);
    await adapter.set('test', '{}', 200, 60);
    const result = await adapter.get('test');
    expect(result).not.toBeNull();
  });

  test('mongo factory calls infra.getMongo and returns an adapter', async () => {
    const docs: Record<string, Record<string, unknown>> = {};
    const mockModel = {
      findOne(filter: Record<string, unknown>) {
        return {
          lean() {
            const key = filter['key'] as string;
            return Promise.resolve(
              docs[key] ? { ...docs[key], createdAt: { getTime: () => Date.now() } } : null,
            );
          },
        };
      },
      async create(docData: Record<string, unknown>) {
        docs[docData['key'] as string] = docData;
      },
    };

    const factoryModels: Record<string, unknown> = {};
    const mockConn = {
      models: factoryModels,
      model: () => mockModel,
    };

    const mockInfra = {
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      getMongo: () => ({ conn: mockConn, mg: { Schema: class {} } }),
      appName: 'test',
    };

    const adapter = idempotencyFactories.mongo!(mockInfra as any);
    await adapter.set('factory-key', '{}', 200, 60);
    const result = await adapter.get('factory-key');
    expect(result).not.toBeNull();
  });
});
