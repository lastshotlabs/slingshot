/**
 * Tests for boundary cache adapter factories.
 * Covers the Redis adapter methods, the boundaryCacheFactories dispatch map,
 * and the Mongo cache adapter.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as realAuth from '../../packages/slingshot-auth/src/index';
import {
  boundaryCacheFactories,
  createRedisBoundaryCacheAdapter,
} from '../../src/framework/boundaryAdapters/cacheFactories';

afterEach(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Redis boundary cache adapter
// ---------------------------------------------------------------------------

function createMockRedisClient() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    get: mock(async (key: string) => store.get(key) ?? null),
    set: mock(async (key: string, value: string) => {
      store.set(key, value);
    }),
    setex: mock(async (key: string, ttl: number, value: string) => {
      store.set(key, value);
      ttls.set(key, ttl);
    }),
    del: mock(async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    }),
    scan: mock(async (): Promise<[string, string[]]> => {
      // Simple mock: return all matching keys on first call, '0' cursor to end loop
      return ['0', [...store.keys()]];
    }),
    store,
    ttls,
  };
}

describe('createRedisBoundaryCacheAdapter', () => {
  test('name is redis', () => {
    const redis = createMockRedisClient();
    const adapter = createRedisBoundaryCacheAdapter(redis as any);
    expect(adapter.name).toBe('redis');
  });

  test('isReady always returns true', () => {
    const redis = createMockRedisClient();
    const adapter = createRedisBoundaryCacheAdapter(redis as any);
    expect(adapter.isReady()).toBe(true);
  });

  test('get delegates to redisClient.get', async () => {
    const redis = createMockRedisClient();
    redis.store.set('mykey', 'myvalue');
    const adapter = createRedisBoundaryCacheAdapter(redis as any);
    const result = await adapter.get('mykey');
    expect(result).toBe('myvalue');
    expect(redis.get).toHaveBeenCalledWith('mykey');
  });

  test('get returns null for missing key', async () => {
    const redis = createMockRedisClient();
    const adapter = createRedisBoundaryCacheAdapter(redis as any);
    const result = await adapter.get('nonexistent');
    expect(result).toBeNull();
  });

  test('set without TTL calls redisClient.set', async () => {
    const redis = createMockRedisClient();
    const adapter = createRedisBoundaryCacheAdapter(redis as any);
    await adapter.set('k1', 'v1');
    expect(redis.set).toHaveBeenCalledWith('k1', 'v1');
    expect(redis.setex).not.toHaveBeenCalled();
    expect(redis.store.get('k1')).toBe('v1');
  });

  test('set with TTL calls redisClient.setex', async () => {
    const redis = createMockRedisClient();
    const adapter = createRedisBoundaryCacheAdapter(redis as any);
    await adapter.set('k2', 'v2', 300);
    expect(redis.setex).toHaveBeenCalledWith('k2', 300, 'v2');
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.ttls.get('k2')).toBe(300);
  });

  test('del calls redisClient.del', async () => {
    const redis = createMockRedisClient();
    redis.store.set('k3', 'v3');
    const adapter = createRedisBoundaryCacheAdapter(redis as any);
    await adapter.del('k3');
    expect(redis.del).toHaveBeenCalledWith('k3');
    expect(redis.store.has('k3')).toBe(false);
  });

  test('delPattern calls scan and del in a loop', async () => {
    const redis = createMockRedisClient();
    redis.store.set('session:a', 'v1');
    redis.store.set('session:b', 'v2');
    redis.store.set('other', 'v3');
    const adapter = createRedisBoundaryCacheAdapter(redis as any);

    await adapter.delPattern('session:*');

    expect(redis.scan).toHaveBeenCalled();
    // del should have been called (with whatever keys scan returned)
    expect(redis.del).toHaveBeenCalled();
  });

  test('delPattern skips del call when scan returns empty keys', async () => {
    const redis = createMockRedisClient();
    // Override scan to return empty keys
    redis.scan = mock(async (): Promise<[string, string[]]> => ['0', []]);
    const adapter = createRedisBoundaryCacheAdapter(redis as any);
    await adapter.delPattern('no-match:*');
    expect(redis.del).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// boundaryCacheFactories dispatch map
// ---------------------------------------------------------------------------

describe('boundaryCacheFactories — dispatch map', () => {
  test('memory factory creates a ready cache adapter', async () => {
    const adapter = await boundaryCacheFactories.memory({
      redis: null,
      mongo: null,
      sqliteDb: null,
      postgresPool: null,
    });
    expect(adapter).toBeDefined();
    expect(adapter.isReady()).toBe(true);
  });

  test('redis factory throws when redis is null', () => {
    expect(() =>
      boundaryCacheFactories.redis({
        redis: null,
        mongo: null,
        sqliteDb: null,
        postgresPool: null,
      }),
    ).toThrow('[framework/boundaryAdapters] Redis cache adapter requested without a Redis client');
  });

  test('redis factory returns adapter when redis is provided', () => {
    const redisClient = createMockRedisClient();
    const adapter = boundaryCacheFactories.redis({
      redis: redisClient as any,
      mongo: null,
      sqliteDb: null,
      postgresPool: null,
    });
    expect(adapter.name).toBe('redis');
    expect(adapter.isReady()).toBe(true);
  });

  test('sqlite factory throws when sqliteDb is null', () => {
    expect(() =>
      boundaryCacheFactories.sqlite({
        redis: null,
        mongo: null,
        sqliteDb: null,
        postgresPool: null,
      }),
    ).toThrow(
      '[framework/boundaryAdapters] SQLite cache adapter requested without a SQLite database',
    );
  });

  test('mongo factory throws when mongo is null', () => {
    expect(() =>
      boundaryCacheFactories.mongo({
        redis: null,
        mongo: null,
        sqliteDb: null,
        postgresPool: null,
      }),
    ).toThrow(
      '[framework/boundaryAdapters] Mongo cache adapter requested without a Mongo connection',
    );
  });

  test('postgres factory throws when postgresPool is null', async () => {
    await expect(
      boundaryCacheFactories.postgres({
        redis: null,
        mongo: null,
        sqliteDb: null,
        postgresPool: null,
      }),
    ).rejects.toThrow(
      '[framework/boundaryAdapters] Postgres cache adapter requested without a Postgres pool',
    );
  });

  test('postgres factory creates adapter when pool is provided', async () => {
    // Mock a minimal pg.Pool
    const runQuery = mock(async () => ({ rows: [], rowCount: 0 }));
    const pool = {
      query: runQuery,
      connect: mock(async () => ({
        query: runQuery,
        release: () => {},
      })),
    };
    const adapter = await boundaryCacheFactories.postgres({
      redis: null,
      mongo: null,
      sqliteDb: null,
      postgresPool: pool as any,
    });
    expect(adapter.name).toBe('postgres');
    expect(adapter.isReady()).toBe(true);
    expect(pool.connect).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mongo boundary cache adapter
// ---------------------------------------------------------------------------

describe('boundaryCacheFactories — sqlite happy path', () => {
  test('sqlite factory creates adapter when sqliteDb is provided', async () => {
    const mockSqliteDb = {};
    const mockAdapter = {
      name: 'sqlite',
      get: async () => null,
      set: async () => {},
      del: async () => {},
      delPattern: async () => {},
      isReady: () => true,
    };
    // Mock the slingshot-auth import used by createSqliteBoundaryCacheAdapter
    mock.module('@lastshotlabs/slingshot-auth', () => ({
      ...realAuth,
      createSqliteCacheAdapter: () => mockAdapter,
    }));

    const result = await boundaryCacheFactories.sqlite({
      redis: null,
      mongo: null,
      sqliteDb: mockSqliteDb as any,
      postgresPool: null,
    });
    expect(result).toBe(mockAdapter);
  });
});

describe('boundaryCacheFactories — mongo happy path', () => {
  test('mongo factory creates adapter when mongo connection is provided', async () => {
    const mockCacheModel = {
      findOne: mock(() => ({ lean: async () => null })),
      updateOne: mock(async () => {}),
      deleteOne: mock(async () => {}),
      deleteMany: mock(async () => {}),
    };
    mock.module('@framework/middleware/cacheResponse', () => ({
      getCacheModel: () => mockCacheModel,
    }));

    const mockMongoConn = { readyState: 1 };
    const result = await boundaryCacheFactories.mongo({
      redis: null,
      mongo: mockMongoConn as any,
      sqliteDb: null,
      postgresPool: null,
    });
    expect(result.name).toBe('mongo');
  });
});

describe('createMongoBoundaryCacheAdapter', () => {
  function makeMockCacheModel() {
    const store = new Map<string, { value: string; expiresAt?: Date }>();

    return {
      findOne: mock((filter: { key: string }) => {
        const doc = store.get(filter.key);
        return {
          lean: () => Promise.resolve(doc ? { value: doc.value } : null),
        };
      }),
      updateOne: mock(
        async (filter: { key: string }, update: { $set: { value: string; expiresAt?: Date } }) => {
          store.set(filter.key, { value: update.$set.value, expiresAt: update.$set.expiresAt });
        },
      ),
      deleteOne: mock(async (filter: { key: string }) => {
        store.delete(filter.key);
      }),
      deleteMany: mock(async () => {}),
      store,
    };
  }

  async function createTestMongoAdapter() {
    const cacheModel = makeMockCacheModel();
    const appConnection = {
      readyState: 1,
    };

    // Mock the cacheResponse module import
    mock.module('@framework/middleware/cacheResponse', () => ({
      getCacheModel: () => cacheModel,
    }));

    const { createMongoBoundaryCacheAdapter } =
      await import('../../src/framework/boundaryAdapters/cacheFactories');
    const adapter = await createMongoBoundaryCacheAdapter(appConnection as any);
    return { adapter, cacheModel, appConnection };
  }

  test('name is mongo', async () => {
    const { adapter } = await createTestMongoAdapter();
    expect(adapter.name).toBe('mongo');
  });

  test('isReady returns true when readyState is 1', async () => {
    const { adapter } = await createTestMongoAdapter();
    expect(adapter.isReady()).toBe(true);
  });

  test('isReady returns false when readyState is not 1', async () => {
    const cacheModel = makeMockCacheModel();
    const appConnection = { readyState: 0 };
    mock.module('@framework/middleware/cacheResponse', () => ({
      getCacheModel: () => cacheModel,
    }));
    const { createMongoBoundaryCacheAdapter } =
      await import('../../src/framework/boundaryAdapters/cacheFactories');
    const adapter = await createMongoBoundaryCacheAdapter(appConnection as any);
    expect(adapter.isReady()).toBe(false);
  });

  test('get returns cached value', async () => {
    const { adapter, cacheModel } = await createTestMongoAdapter();
    cacheModel.store.set('sess-1', { value: 'session-data' });
    const result = await adapter.get('sess-1');
    expect(result).toBe('session-data');
    expect(cacheModel.findOne).toHaveBeenCalled();
  });

  test('get returns null for cache miss', async () => {
    const { adapter } = await createTestMongoAdapter();
    const result = await adapter.get('nonexistent');
    expect(result).toBeNull();
  });

  test('set without TTL stores value without expiresAt', async () => {
    const { adapter, cacheModel } = await createTestMongoAdapter();
    await adapter.set('k1', 'v1');
    expect(cacheModel.updateOne).toHaveBeenCalled();
    const call = cacheModel.updateOne.mock.calls[0];
    expect(call[1].$set.value).toBe('v1');
    expect(call[1].$set.expiresAt).toBeUndefined();
  });

  test('set with TTL stores value with expiresAt', async () => {
    const { adapter, cacheModel } = await createTestMongoAdapter();
    const before = Date.now();
    await adapter.set('k2', 'v2', 600);
    const call = cacheModel.updateOne.mock.calls[0];
    expect(call[1].$set.expiresAt).toBeInstanceOf(Date);
    expect((call[1].$set.expiresAt as Date).getTime()).toBeGreaterThanOrEqual(before + 600_000);
  });

  test('del removes the key', async () => {
    const { adapter, cacheModel } = await createTestMongoAdapter();
    await adapter.del('k3');
    expect(cacheModel.deleteOne).toHaveBeenCalledWith({ key: 'k3' });
  });

  test('delPattern converts glob to regex and calls deleteMany', async () => {
    const { adapter, cacheModel } = await createTestMongoAdapter();
    await adapter.delPattern('session:*');
    expect(cacheModel.deleteMany).toHaveBeenCalled();
    const call = cacheModel.deleteMany.mock.calls[0];
    // The filter should have a key field that is a regex
    expect(call[0].key).toBeInstanceOf(RegExp);
  });
});
