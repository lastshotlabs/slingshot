/**
 * Unit tests for resolveBoundaryAdapters / applyBoundaryAdapters / registerBoundaryAdapters.
 *
 * Uses the memory-only path so no real infrastructure (Redis/Mongo/SQLite) is needed.
 * A mock CoreRegistrar verifies the correct adapters are registered.
 */
import { describe, expect, mock, test } from 'bun:test';
import type {
  CacheAdapter,
  CoreRegistrar,
  FingerprintBuilder,
  RateLimitAdapter,
} from '@lastshotlabs/slingshot-core';
import type { StoreType } from '@lastshotlabs/slingshot-core';
import {
  applyBoundaryAdapters,
  registerBoundaryAdapters,
  resolveBoundaryAdapters,
} from '../../src/framework/registerBoundaryAdapters';

// ---------------------------------------------------------------------------
// Mock CoreRegistrar
// ---------------------------------------------------------------------------

function makeMockRegistrar() {
  const registeredRateLimitAdapter: { value: RateLimitAdapter | null } = { value: null };
  const registeredFingerprintBuilder: { value: FingerprintBuilder | null } = { value: null };
  const registeredCacheAdapters = new Map<StoreType, CacheAdapter>();

  const registrar: CoreRegistrar = {
    setIdentityResolver: mock(() => {}),
    setRouteAuth: mock(() => {}),
    setUserResolver: mock(() => {}),
    addEmailTemplates: mock(() => {}),
    setRateLimitAdapter: mock((adapter: RateLimitAdapter) => {
      registeredRateLimitAdapter.value = adapter;
    }),
    setFingerprintBuilder: mock((builder: FingerprintBuilder) => {
      registeredFingerprintBuilder.value = builder;
    }),
    addCacheAdapter: mock((store: StoreType, adapter: CacheAdapter) => {
      registeredCacheAdapters.set(store, adapter);
    }),
  } as unknown as CoreRegistrar;

  return {
    registrar,
    registeredRateLimitAdapter,
    registeredFingerprintBuilder,
    registeredCacheAdapters,
  };
}

// Minimal options with all infrastructure disabled (memory-only)
const memoryOnlyOptions = {
  redisEnabled: false,
  mongoMode: false as const,
  redis: null,
  appConnection: null,
  sqliteDb: null,
  postgresPool: null,
};

// ---------------------------------------------------------------------------
// resolveBoundaryAdapters
// ---------------------------------------------------------------------------

describe('resolveBoundaryAdapters — memory-only', () => {
  test('returns a rateLimitAdapter', async () => {
    const snapshot = await resolveBoundaryAdapters(memoryOnlyOptions);
    expect(snapshot.rateLimitAdapter).toBeDefined();
    expect(typeof snapshot.rateLimitAdapter.trackAttempt).toBe('function');
  });

  test('returns a fingerprintBuilder', async () => {
    const snapshot = await resolveBoundaryAdapters(memoryOnlyOptions);
    expect(snapshot.fingerprintBuilder).toBeDefined();
    expect(typeof snapshot.fingerprintBuilder.buildFingerprint).toBe('function');
  });

  test('cacheAdapters map includes memory store', async () => {
    const snapshot = await resolveBoundaryAdapters(memoryOnlyOptions);
    expect(snapshot.cacheAdapters.has('memory')).toBe(true);
  });

  test('cacheAdapters map does NOT include redis when redis is disabled', async () => {
    const snapshot = await resolveBoundaryAdapters(memoryOnlyOptions);
    expect(snapshot.cacheAdapters.has('redis')).toBe(false);
  });

  test('cacheAdapters map does NOT include sqlite when sqliteDb is null', async () => {
    const snapshot = await resolveBoundaryAdapters(memoryOnlyOptions);
    expect(snapshot.cacheAdapters.has('sqlite')).toBe(false);
  });

  test('cacheAdapters map does NOT include mongo when mongoMode is false', async () => {
    const snapshot = await resolveBoundaryAdapters(memoryOnlyOptions);
    expect(snapshot.cacheAdapters.has('mongo')).toBe(false);
  });

  test('memory cache adapter is ready', async () => {
    const snapshot = await resolveBoundaryAdapters(memoryOnlyOptions);
    const memAdapter = snapshot.cacheAdapters.get('memory')!;
    expect(memAdapter.isReady()).toBe(true);
  });
});

describe('resolveBoundaryAdapters — conditional store inclusion', () => {
  test('includes redis cache adapter when redis is enabled and client is provided', async () => {
    // Mock a minimal redis client
    const fakeRedis = {
      get: mock(async () => null),
      set: mock(async () => 'OK'),
      setex: mock(async () => 'OK'),
      del: mock(async () => 1),
      scan: mock(async () => ['0', []]),
    } as any;

    const snapshot = await resolveBoundaryAdapters({
      redisEnabled: true,
      mongoMode: false,
      redis: fakeRedis,
      appConnection: null,
      sqliteDb: null,
      postgresPool: null,
    });
    expect(snapshot.cacheAdapters.has('redis')).toBe(true);
  });

  test('does NOT include redis when redisEnabled is false even if client is provided', async () => {
    const fakeRedis = {} as any;
    const snapshot = await resolveBoundaryAdapters({
      redisEnabled: false,
      mongoMode: false,
      redis: fakeRedis,
      appConnection: null,
      sqliteDb: null,
      postgresPool: null,
    });
    expect(snapshot.cacheAdapters.has('redis')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyBoundaryAdapters
// ---------------------------------------------------------------------------

describe('applyBoundaryAdapters', () => {
  test('calls setRateLimitAdapter on the registrar', async () => {
    const { registrar, registeredRateLimitAdapter } = makeMockRegistrar();
    const snapshot = await resolveBoundaryAdapters(memoryOnlyOptions);
    applyBoundaryAdapters(registrar, snapshot);
    expect(registeredRateLimitAdapter.value).not.toBeNull();
  });

  test('calls setFingerprintBuilder on the registrar', async () => {
    const { registrar, registeredFingerprintBuilder } = makeMockRegistrar();
    const snapshot = await resolveBoundaryAdapters(memoryOnlyOptions);
    applyBoundaryAdapters(registrar, snapshot);
    expect(registeredFingerprintBuilder.value).not.toBeNull();
  });

  test('calls addCacheAdapter for each resolved store', async () => {
    const { registrar, registeredCacheAdapters } = makeMockRegistrar();
    const snapshot = await resolveBoundaryAdapters(memoryOnlyOptions);
    applyBoundaryAdapters(registrar, snapshot);
    // At minimum, memory store should be registered
    expect(registeredCacheAdapters.has('memory')).toBe(true);
  });

  test('registered memory cache adapter responds to get/set/del', async () => {
    const { registrar, registeredCacheAdapters } = makeMockRegistrar();
    const snapshot = await resolveBoundaryAdapters(memoryOnlyOptions);
    applyBoundaryAdapters(registrar, snapshot);
    const adapter = registeredCacheAdapters.get('memory')!;
    await adapter.set('k', 'v');
    expect(await adapter.get('k')).toBe('v');
    await adapter.del('k');
    expect(await adapter.get('k')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registerBoundaryAdapters (integration of resolve + apply)
// ---------------------------------------------------------------------------

describe('registerBoundaryAdapters', () => {
  test('registers all adapters on the registrar in a single call', async () => {
    const {
      registrar,
      registeredRateLimitAdapter,
      registeredFingerprintBuilder,
      registeredCacheAdapters,
    } = makeMockRegistrar();
    await registerBoundaryAdapters(registrar, memoryOnlyOptions);
    expect(registeredRateLimitAdapter.value).not.toBeNull();
    expect(registeredFingerprintBuilder.value).not.toBeNull();
    expect(registeredCacheAdapters.size).toBeGreaterThan(0);
  });

  test('resolves without throwing for all-null infrastructure', async () => {
    const { registrar } = makeMockRegistrar();
    await expect(registerBoundaryAdapters(registrar, memoryOnlyOptions)).resolves.toBeUndefined();
  });
});
