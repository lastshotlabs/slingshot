/**
 * Unit tests for cronRegistry persistence adapters.
 *
 * Tests the memory, Redis-mock, SQLite-mock, and Postgres-mock adapters
 * for the CronRegistryRepository interface.
 * No real database connections required.
 */
import { describe, expect, test } from 'bun:test';
import {
  createMemoryCronRegistry,
  createPostgresCronRegistry,
  createRedisCronRegistry,
  createSqliteCronRegistry,
  cronRegistryFactories,
} from '../../src/framework/persistence/cronRegistry';

// ---------------------------------------------------------------------------
// Memory adapter
// ---------------------------------------------------------------------------

describe('createMemoryCronRegistry — memory adapter', () => {
  test('getAll returns empty set initially', async () => {
    const repo = createMemoryCronRegistry();
    const result = await repo.getAll();
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  test('save persists a set of names', async () => {
    const repo = createMemoryCronRegistry();
    await repo.save(new Set(['job-a', 'job-b']));
    const result = await repo.getAll();
    expect(result.has('job-a')).toBe(true);
    expect(result.has('job-b')).toBe(true);
  });

  test('save replaces previous set entirely', async () => {
    const repo = createMemoryCronRegistry();
    await repo.save(new Set(['job-a', 'job-b', 'job-c']));
    await repo.save(new Set(['job-x']));
    const result = await repo.getAll();
    expect(result.size).toBe(1);
    expect(result.has('job-x')).toBe(true);
    expect(result.has('job-a')).toBe(false);
  });

  test('save with empty set clears all entries', async () => {
    const repo = createMemoryCronRegistry();
    await repo.save(new Set(['job-a']));
    await repo.save(new Set());
    const result = await repo.getAll();
    expect(result.size).toBe(0);
  });

  test('getAll returns a copy — mutations do not affect stored state', async () => {
    const repo = createMemoryCronRegistry();
    await repo.save(new Set(['job-a']));
    const first = await repo.getAll();
    (first as Set<string>).add('mutated');
    const second = await repo.getAll();
    expect(second.has('mutated')).toBe(false);
  });

  test('multiple instances are independent', async () => {
    const r1 = createMemoryCronRegistry();
    const r2 = createMemoryCronRegistry();
    await r1.save(new Set(['r1-job']));
    const r2result = await r2.getAll();
    expect(r2result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Redis adapter (mock)
// ---------------------------------------------------------------------------

describe('createRedisCronRegistry — redis adapter', () => {
  function makeRedisStore() {
    const store = new Map<string, string>();
    return {
      redis: {
        get: async (key: string) => store.get(key) ?? null,
        set: async (key: string, value: string) => {
          store.set(key, value);
        },
      },
      store,
    };
  }

  test('getAll returns empty set when key does not exist', async () => {
    const { redis } = makeRedisStore();
    const repo = createRedisCronRegistry(() => redis, 'test-app');
    const result = await repo.getAll();
    expect(result.size).toBe(0);
  });

  test('save serializes names to JSON and stores under namespaced key', async () => {
    const { redis, store } = makeRedisStore();
    const repo = createRedisCronRegistry(() => redis, 'my-app');
    await repo.save(new Set(['cron-a', 'cron-b']));
    const raw = store.get('cron-registry:my-app');
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed).toContain('cron-a');
    expect(parsed).toContain('cron-b');
  });

  test('getAll deserializes previously saved names', async () => {
    const { redis } = makeRedisStore();
    const repo = createRedisCronRegistry(() => redis, 'my-app');
    await repo.save(new Set(['cron-x', 'cron-y']));
    const result = await repo.getAll();
    expect(result.has('cron-x')).toBe(true);
    expect(result.has('cron-y')).toBe(true);
  });

  test('getAll returns empty set for invalid JSON', async () => {
    const store = new Map<string, string>();
    store.set('cron-registry:test-app', 'not-json{{{');
    const redis = {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const repo = createRedisCronRegistry(() => redis, 'test-app');
    const result = await repo.getAll();
    expect(result.size).toBe(0);
  });

  test('getAll returns empty set when stored value is not an array', async () => {
    const store = new Map<string, string>();
    store.set('cron-registry:app', JSON.stringify({ not: 'an array' }));
    const redis = {
      get: async (key: string) => store.get(key) ?? null,
      set: async () => {},
    };
    const repo = createRedisCronRegistry(() => redis, 'app');
    const result = await repo.getAll();
    expect(result.size).toBe(0);
  });

  test('filters non-string entries from stored array', async () => {
    const store = new Map<string, string>();
    store.set('cron-registry:app', JSON.stringify(['valid', 42, null, 'also-valid']));
    const redis = {
      get: async (key: string) => store.get(key) ?? null,
      set: async () => {},
    };
    const repo = createRedisCronRegistry(() => redis, 'app');
    const result = await repo.getAll();
    expect(result.has('valid')).toBe(true);
    expect(result.has('also-valid')).toBe(true);
    expect(result.size).toBe(2);
  });

  test('appName is included in key namespace', async () => {
    const { redis, store } = makeRedisStore();
    const repo = createRedisCronRegistry(() => redis, 'my-unique-app');
    await repo.save(new Set(['job']));
    expect(store.has('cron-registry:my-unique-app')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQLite adapter (mock)
// ---------------------------------------------------------------------------

describe('createSqliteCronRegistry — sqlite adapter', () => {
  function makeSqliteDb() {
    const table: string[] = [];
    let tableCreated = false;

    return {
      run: (sql: string, params?: unknown[]) => {
        if (sql.includes('CREATE TABLE')) {
          tableCreated = true;
          return;
        }
        if (sql.includes('DELETE FROM')) {
          table.length = 0;
          return;
        }
        if (sql.includes('INSERT INTO') && params) {
          table.push(params[0] as string);
        }
      },
      query: <T>() => ({
        all: () => table.map(name => ({ name }) as unknown as T),
      }),
      _tableCreated: () => tableCreated,
    };
  }

  test('getAll returns empty set initially', async () => {
    const db = makeSqliteDb();
    const repo = createSqliteCronRegistry(() => db as any);
    const result = await repo.getAll();
    expect(result.size).toBe(0);
  });

  test('creates table on first access', async () => {
    const db = makeSqliteDb();
    const repo = createSqliteCronRegistry(() => db as any);
    await repo.getAll();
    expect(db._tableCreated()).toBe(true);
  });

  test('save inserts all names', async () => {
    const db = makeSqliteDb();
    const repo = createSqliteCronRegistry(() => db as any);
    await repo.save(new Set(['job-a', 'job-b']));
    const result = await repo.getAll();
    expect(result.has('job-a')).toBe(true);
    expect(result.has('job-b')).toBe(true);
  });

  test('save clears previous entries before inserting', async () => {
    const db = makeSqliteDb();
    const repo = createSqliteCronRegistry(() => db as any);
    await repo.save(new Set(['old-job']));
    await repo.save(new Set(['new-job']));
    const result = await repo.getAll();
    expect(result.has('old-job')).toBe(false);
    expect(result.has('new-job')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Postgres adapter (mock)
// ---------------------------------------------------------------------------

describe('createPostgresCronRegistry — postgres adapter', () => {
  function makePool(initialRows: { names: string[] }[] = []) {
    const rows = [...initialRows];
    return {
      query: async <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('CREATE TABLE')) {
          return { rows: [] as R[], rowCount: 0 };
        }
        if (sql.includes('SELECT names')) {
          return { rows: rows as unknown as R[], rowCount: rows.length };
        }
        if (sql.includes('INSERT INTO')) {
          const names = params?.[1] as string[];
          rows.length = 0;
          rows.push({ names });
          return { rows: [] as R[], rowCount: 1 };
        }
        return { rows: [] as R[], rowCount: 0 };
      },
    };
  }

  test('getAll returns empty set when no rows exist', async () => {
    const pool = makePool([]);
    const repo = createPostgresCronRegistry(pool, 'my-app');
    const result = await repo.getAll();
    expect(result.size).toBe(0);
  });

  test('save and getAll round-trip', async () => {
    const pool = makePool([]);
    const repo = createPostgresCronRegistry(pool, 'my-app');
    await repo.save(new Set(['pg-job-a', 'pg-job-b']));
    const result = await repo.getAll();
    expect(result.has('pg-job-a')).toBe(true);
    expect(result.has('pg-job-b')).toBe(true);
  });

  test('getAll returns set from existing row', async () => {
    const pool = makePool([{ names: ['existing-job'] }]);
    const repo = createPostgresCronRegistry(pool, 'my-app');
    const result = await repo.getAll();
    expect(result.has('existing-job')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MongoDB adapter (mock)
// ---------------------------------------------------------------------------

describe('createMongoCronRegistry — mongodb adapter', () => {
  function makeMockMongoose() {
    const store = new Map<string, { names: string[] }>();

    const model = {
      findById: (id: string) => ({
        lean: () => Promise.resolve(store.get(id) ?? null),
      }),
      findByIdAndUpdate: async (
        id: string,
        update: { $set: { names: string[] } },
      ) => {
        store.set(id, { names: update.$set.names });
        return null;
      },
    };

    const conn = {
      models: {} as Record<string, unknown>,
      model() {
        return model;
      },
    };

    const mg = {
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      Schema: class {},
    };

    return { conn, mg, model, store };
  }

  test('getAll returns empty set when no document exists', async () => {
    const { conn, mg } = makeMockMongoose();
    const { createMongoCronRegistry } = await import(
      '../../src/framework/persistence/cronRegistry'
    );
    const repo = createMongoCronRegistry(
      () => conn as any,
      () => mg as any,
      'test-app',
    );
    const result = await repo.getAll();
    expect(result.size).toBe(0);
  });

  test('save and getAll round-trip', async () => {
    const { conn, mg } = makeMockMongoose();
    const { createMongoCronRegistry } = await import(
      '../../src/framework/persistence/cronRegistry'
    );
    const repo = createMongoCronRegistry(
      () => conn as any,
      () => mg as any,
      'my-app',
    );
    await repo.save(new Set(['mongo-job-a', 'mongo-job-b']));
    const result = await repo.getAll();
    expect(result.has('mongo-job-a')).toBe(true);
    expect(result.has('mongo-job-b')).toBe(true);
  });

  test('uses cached model on second call (conn.models path)', async () => {
    const { conn, mg, model } = makeMockMongoose();
    // Pre-populate models to simulate second call
    conn.models['CronSchedulerRegistry'] = model;

    const { createMongoCronRegistry } = await import(
      '../../src/framework/persistence/cronRegistry'
    );
    const repo = createMongoCronRegistry(
      () => conn as any,
      () => mg as any,
      'cached-app',
    );
    // Should use the pre-existing model without calling conn.model()
    const result = await repo.getAll();
    expect(result.size).toBe(0);
  });

  test('getAll returns empty set when doc has no names field', async () => {
    const conn = {
      models: {} as Record<string, unknown>,
      model() {
        return {
          findById: () => ({ lean: () => Promise.resolve({}) }),
          findByIdAndUpdate: async () => null,
        };
      },
    };
    const mg = {
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      Schema: class {},
    };
    const { createMongoCronRegistry } = await import(
      '../../src/framework/persistence/cronRegistry'
    );
    const repo = createMongoCronRegistry(
      () => conn as any,
      () => mg as any,
      'no-names-app',
    );
    const result = await repo.getAll();
    expect(result.size).toBe(0);
  });

  test('appName defaults to "default" docId when empty string', async () => {
    const store = new Map<string, { names: string[] }>();
    const model = {
      findById: (id: string) => ({ lean: () => Promise.resolve(store.get(id) ?? null) }),
      findByIdAndUpdate: async (
        id: string,
        update: { $set: { names: string[] } },
      ) => {
        store.set(id, { names: update.$set.names });
        return null;
      },
    };
    const conn = {
      models: {} as Record<string, unknown>,
      model: () => model,
    };
    const mg = {
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      Schema: class {},
    };
    const { createMongoCronRegistry } = await import(
      '../../src/framework/persistence/cronRegistry'
    );
    const repo = createMongoCronRegistry(
      () => conn as any,
      () => mg as any,
      '',
    );
    await repo.save(new Set(['default-job']));
    expect(store.has('default')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cronRegistryFactories export
// ---------------------------------------------------------------------------

describe('cronRegistryFactories', () => {
  test('memory factory creates a working in-memory registry', async () => {
    const repo = cronRegistryFactories.memory({} as any);
    await repo.save(new Set(['factory-job']));
    const result = await repo.getAll();
    expect(result.has('factory-job')).toBe(true);
  });

  test('redis factory creates a redis-backed registry', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => { store.set(key, value); },
    };
    const infra = {
      getRedis: () => redis,
      appName: 'factory-app',
    };
    const repo = cronRegistryFactories.redis(infra as any);
    await repo.save(new Set(['redis-factory-job']));
    const result = await repo.getAll();
    expect(result.has('redis-factory-job')).toBe(true);
  });

  test('sqlite factory creates a sqlite-backed registry', async () => {
    const table: string[] = [];
    const db = {
      run: (sql: string, params?: unknown[]) => {
        if (sql.includes('DELETE FROM')) { table.length = 0; return; }
        if (sql.includes('INSERT INTO') && params) { table.push(params[0] as string); }
      },
      query: <T>() => ({
        all: () => table.map(name => ({ name }) as unknown as T),
      }),
    };
    const infra = { getSqliteDb: () => db };
    const repo = cronRegistryFactories.sqlite(infra as any);
    await repo.save(new Set(['sqlite-factory-job']));
    const result = await repo.getAll();
    expect(result.has('sqlite-factory-job')).toBe(true);
  });

  test('mongo factory creates a mongo-backed registry', async () => {
    const store = new Map<string, { names: string[] }>();
    const model = {
      findById: (id: string) => ({ lean: () => Promise.resolve(store.get(id) ?? null) }),
      findByIdAndUpdate: async (id: string, update: { $set: { names: string[] } }) => {
        store.set(id, { names: update.$set.names });
      },
    };
    const conn = {
      models: {} as Record<string, unknown>,
      model: () => model,
    };
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    const mg = { Schema: class {} };
    const infra = {
      getMongo: () => ({ conn, mg }),
      appName: 'mongo-factory-app',
    };
    const repo = cronRegistryFactories.mongo(infra as any);
    await repo.save(new Set(['mongo-factory-job']));
    const result = await repo.getAll();
    expect(result.has('mongo-factory-job')).toBe(true);
  });

  test('postgres factory creates a postgres-backed registry', async () => {
    const rows: { names: string[] }[] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('CREATE TABLE')) return { rows: [], rowCount: 0 };
        if (sql.includes('SELECT names')) return { rows, rowCount: rows.length };
        if (sql.includes('INSERT INTO')) {
          rows.length = 0;
          rows.push({ names: params?.[1] as string[] });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const infra = {
      getPostgres: () => ({ pool }),
      appName: 'pg-factory-app',
    };
    const repo = cronRegistryFactories.postgres(infra as any);
    await repo.save(new Set(['pg-factory-job']));
    const result = await repo.getAll();
    expect(result.has('pg-factory-job')).toBe(true);
  });
});
