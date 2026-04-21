/**
 * Unit tests for the cacheResponse middleware and cache utilities.
 *
 * Tests header sanitization (UNCACHEABLE_HEADERS), cache key construction,
 * per-tenant namespacing, cache HIT/MISS behavior, and non-2xx bypass,
 * using the in-memory cache adapter via createTestApp().
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getCacheResponseMiddleware() {
  return import(
    `../../src/framework/middleware/cacheResponse.ts?cache-response-test=${Date.now()}-${Math.random()}`
  );
}

beforeEach(async () => {
  await createTestApp();
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('cacheResponse — module exports', () => {
  test('cacheResponse is a function', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    expect(typeof cacheResponse).toBe('function');
  });

  test('bustCache is exported as a function', async () => {
    const { bustCache } = await getCacheResponseMiddleware();
    expect(typeof bustCache).toBe('function');
  });

  test('bustCachePattern is exported as a function', async () => {
    const { bustCachePattern } = await getCacheResponseMiddleware();
    expect(typeof bustCachePattern).toBe('function');
  });

  test('getCacheModel is exported as a function', async () => {
    const { getCacheModel } = await getCacheResponseMiddleware();
    expect(typeof getCacheModel).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// getCacheModel guard
// ---------------------------------------------------------------------------

describe('getCacheModel — guard', () => {
  test('throws when called without a connection parameter', async () => {
    const { getCacheModel } = await getCacheResponseMiddleware();
    expect(() => getCacheModel()).toThrow(/requires a connection/);
  });

  test('returns existing model when CacheEntry is already registered on the connection (line 36-37)', async () => {
    const { getCacheModel } = await getCacheResponseMiddleware();
    const fakeModel = { modelName: 'CacheEntry' };
    const fakeConn = {
      models: { CacheEntry: fakeModel },
    } as any;
    const result = getCacheModel(fakeConn);
    expect(result).toBe(fakeModel);
  });

  test('creates and registers CacheEntry model when not yet on connection (lines 38-48)', async () => {
    const { getCacheModel } = await getCacheResponseMiddleware();
    const registeredModels: Record<string, unknown> = {};
    const fakeConn = {
      models: registeredModels,
      model(name: string, schema: unknown) {
        const m = { modelName: name, schema };
        registeredModels[name] = m;
        return m;
      },
    } as any;
    // getCacheModel uses getMongooseModule() internally — real mongoose is available
    const result = getCacheModel(fakeConn);
    expect(result).toBeDefined();
    expect((result as any).modelName).toBe('CacheEntry');
  });
});

// ---------------------------------------------------------------------------
// storeGet — adapter not ready (line 79)
// ---------------------------------------------------------------------------

describe('cacheResponse — adapter not ready', () => {
  test('throws when the cache adapter isReady() returns false', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const { attachContext, createRouter } = await import('@lastshotlabs/slingshot-core');

    const notReadyAdapter = {
      name: 'memory' as const,
      async get() {
        return null;
      },
      async set() {},
      async del() {},
      async delPattern() {},
      isReady() {
        return false;
      },
    };

    const testApp = createRouter();
    attachContext(testApp, {
      app: testApp,
      config: { appName: 'test', resolvedStores: { cache: 'memory' } },
      cacheAdapters: new Map([['memory', notReadyAdapter]]),
    } as any);

    testApp.get('/not-ready', cacheResponse({ key: 'not-ready-key', store: 'memory' }), c =>
      c.json({ ok: true }),
    );

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const res = await fetch(`http://localhost:${server.port}/not-ready`);
      // The middleware throws when adapter is not ready — Hono returns 500
      expect(res.status).toBe(500);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Cache middleware via HTTP (integration with createTestApp)
// ---------------------------------------------------------------------------

describe('cacheResponse — HTTP integration', () => {
  test('first request returns x-cache: MISS on a 200 response', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const testApp = await createTestApp({
      plugins: [],
    });

    // Mount a custom cacheable route via app.get
    testApp.get(
      '/cache-test',
      cacheResponse({ key: 'cache-test', ttl: 60, store: 'memory' }),
      c => {
        return c.json({ value: 'fresh' });
      },
    );

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const res = await fetch(`http://localhost:${server.port}/cache-test`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-cache')).toBe('MISS');
    } finally {
      server.stop(true);
    }
  });

  test('second request returns x-cache: HIT with same body', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const testApp = await createTestApp({ plugins: [] });

    let callCount = 0;
    testApp.get(
      '/cache-hit-test',
      cacheResponse({ key: 'cache-hit-test', ttl: 60, store: 'memory' }),
      c => {
        callCount++;
        return c.json({ callCount });
      },
    );

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const url = `http://localhost:${server.port}/cache-hit-test`;
      const first = await fetch(url);
      const firstBody = (await first.json()) as any;

      const second = await fetch(url);
      const secondBody = (await second.json()) as any;

      expect(second.headers.get('x-cache')).toBe('HIT');
      // Cached response returns same body as first response
      expect(secondBody.callCount).toBe(firstBody.callCount);
      // Handler only invoked once
      expect(callCount).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test('non-2xx responses are NOT cached', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const testApp = await createTestApp({ plugins: [] });

    let callCount = 0;
    testApp.get('/cache-error-test', cacheResponse({ key: 'cache-error', store: 'memory' }), c => {
      callCount++;
      return c.json({ error: 'not found' }, 404);
    });

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const url = `http://localhost:${server.port}/cache-error-test`;
      await fetch(url);
      await fetch(url);
      // Both requests should hit the handler (no caching for 404)
      expect(callCount).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test('key function receives context to build dynamic cache keys', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const testApp = await createTestApp({ plugins: [] });

    let callCount = 0;
    testApp.get(
      '/cache-dynamic/:id',
      cacheResponse({ key: c => `item:${c.req.param('id')}`, store: 'memory', ttl: 60 }),
      c => {
        callCount++;
        return c.json({ id: c.req.param('id') });
      },
    );

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const base = `http://localhost:${server.port}/cache-dynamic`;
      // Each distinct id is cached independently
      await fetch(`${base}/1`);
      await fetch(`${base}/2`);
      await fetch(`${base}/1`); // should hit cache for id=1
      expect(callCount).toBe(2); // only 2 unique ids
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Security-sensitive headers are never cached
// ---------------------------------------------------------------------------

describe('cacheResponse — sensitive header sanitization', () => {
  const UNCACHEABLE = [
    'set-cookie',
    'www-authenticate',
    'authorization',
    'x-csrf-token',
    'proxy-authenticate',
  ];

  test.each(UNCACHEABLE)('"%s" is not stored in cached response headers', async header => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const testApp = await createTestApp({ plugins: [] });

    testApp.get(
      '/sensitive-header-test',
      cacheResponse({ key: `sensitive-${header}`, store: 'memory', ttl: 60 }),
      c => {
        c.header(header, 'should-not-survive');
        return c.json({ ok: true });
      },
    );

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const url = `http://localhost:${server.port}/sensitive-header-test`;
      await fetch(url); // prime cache (MISS)
      const cached = await fetch(url); // retrieve from cache (HIT)
      expect(cached.headers.get('x-cache')).toBe('HIT');
      expect(cached.headers.get(header)).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// storeSet — adapter not ready (line 103)
// ---------------------------------------------------------------------------

describe('cacheResponse — storeSet not ready', () => {
  test('storeSet throws when cache adapter isReady() returns false on a cache MISS', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const { attachContext, createRouter } = await import('@lastshotlabs/slingshot-core');

    // Adapter that allows get (returns null = cache miss) but isReady returns false
    // only after get is called (simulate intermittent failure)
    let getCallCount = 0;
    const intermittentAdapter = {
      name: 'memory' as const,
      async get() {
        getCallCount++;
        return null;
      },
      async set() {},
      async del() {},
      async delPattern() {},
      isReady() {
        return getCallCount === 0;
      }, // ready for GET, not ready for SET
    };

    const testApp = createRouter();
    attachContext(testApp, {
      app: testApp,
      config: { appName: 'test', resolvedStores: { cache: 'memory' } },
      cacheAdapters: new Map([['memory', intermittentAdapter]]),
    } as any);

    testApp.get('/set-not-ready', cacheResponse({ key: 'set-not-ready-key', store: 'memory' }), c =>
      c.json({ ok: true }),
    );

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const res = await fetch(`http://localhost:${server.port}/set-not-ready`);
      // storeSet throws because adapter is not ready when trying to cache the 200 response
      expect(res.status).toBe(500);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// bustCache and bustCachePattern (lines 117-121, 132-136, 147-168)
// ---------------------------------------------------------------------------

describe('cacheResponse — bustCache and bustCachePattern', () => {
  test('bustCache deletes from all cache stores (lines 117-121, 147-153)', async () => {
    const { bustCache } = await getCacheResponseMiddleware();
    const { attachContext, createRouter } = await import('@lastshotlabs/slingshot-core');

    const delMock = async () => {};
    const adapter = {
      name: 'memory' as const,
      async get() {
        return null;
      },
      async set() {},
      del: delMock,
      async delPattern() {},
      isReady() {
        return true;
      },
    };

    const testApp = createRouter();
    attachContext(testApp, {
      app: testApp,
      config: { appName: 'myapp' },
      cacheAdapters: new Map([['memory', adapter]]),
    } as any);

    await bustCache('user:123', testApp);
    // If no error thrown, the path was exercised successfully
  });

  test('bustCachePattern deletes matching keys from all cache stores (lines 132-136, 161-167)', async () => {
    const { bustCachePattern } = await getCacheResponseMiddleware();
    const { attachContext, createRouter } = await import('@lastshotlabs/slingshot-core');

    const delPatternMock = async () => {};
    const adapter = {
      name: 'memory' as const,
      async get() {
        return null;
      },
      async set() {},
      async del() {},
      delPattern: delPatternMock,
      isReady() {
        return true;
      },
    };

    const testApp = createRouter();
    attachContext(testApp, {
      app: testApp,
      config: { appName: 'myapp' },
      cacheAdapters: new Map([['memory', adapter]]),
    } as any);

    await bustCachePattern('user:*', testApp);
    // If no error thrown, the path was exercised successfully
  });

  test('storeDel silently returns when adapter is not ready (line 119)', async () => {
    const { bustCache } = await getCacheResponseMiddleware();
    const { attachContext, createRouter } = await import('@lastshotlabs/slingshot-core');

    const adapter = {
      name: 'memory' as const,
      async get() {
        return null;
      },
      async set() {},
      async del() {},
      async delPattern() {},
      isReady() {
        return false;
      },
    };

    const testApp = createRouter();
    attachContext(testApp, {
      app: testApp,
      config: { appName: 'test' },
      cacheAdapters: new Map([['memory', adapter]]),
    } as any);

    // Should not throw — silently returns when not ready
    await bustCache('key', testApp);
  });

  test('storeDelPattern silently returns when adapter is not ready (line 134)', async () => {
    const { bustCachePattern } = await getCacheResponseMiddleware();
    const { attachContext, createRouter } = await import('@lastshotlabs/slingshot-core');

    const adapter = {
      name: 'memory' as const,
      async get() {
        return null;
      },
      async set() {},
      async del() {},
      async delPattern() {},
      isReady() {
        return false;
      },
    };

    const testApp = createRouter();
    attachContext(testApp, {
      app: testApp,
      config: { appName: 'test' },
      cacheAdapters: new Map([['memory', adapter]]),
    } as any);

    // Should not throw — silently returns when not ready
    await bustCachePattern('key:*', testApp);
  });
});

// ---------------------------------------------------------------------------
// storeSet — adapter not ready (lines 94-104)
// ---------------------------------------------------------------------------

describe('cacheResponse — storeSet adapter not ready', () => {
  test('throws when storeSet adapter isReady() returns false (on cache write)', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const { attachContext, createRouter } = await import('@lastshotlabs/slingshot-core');

    let callCount = 0;
    const notReadyOnSetAdapter = {
      name: 'memory' as const,
      async get() {
        // storeGet succeeds (returns null = cache miss)
        return null;
      },
      async set() {},
      async del() {},
      async delPattern() {},
      isReady() {
        callCount++;
        // First call (storeGet): ready. Second call (storeSet): not ready.
        return callCount <= 1;
      },
    };

    const testApp = createRouter();
    attachContext(testApp, {
      app: testApp,
      config: { appName: 'test', resolvedStores: { cache: 'memory' } },
      cacheAdapters: new Map([['memory', notReadyOnSetAdapter]]),
    } as any);

    testApp.get('/set-not-ready', cacheResponse({ key: 'set-not-ready-key', store: 'memory' }), c =>
      c.json({ ok: true }),
    );

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const res = await fetch(`http://localhost:${server.port}/set-not-ready`);
      // storeSet throws when adapter not ready — Hono returns 500
      expect(res.status).toBe(500);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// bustCache / bustCachePattern — verify correct keys and multiple stores
// ---------------------------------------------------------------------------

describe('cacheResponse — bustCache key construction', () => {
  test('bustCache constructs key as cache:<appName>:<key> and calls del', async () => {
    const { bustCache } = await getCacheResponseMiddleware();
    const { attachContext, createRouter } = await import('@lastshotlabs/slingshot-core');

    const deletedKeys: string[] = [];
    const adapter = {
      name: 'memory' as const,
      async get() {
        return null;
      },
      async set() {},
      async del(key: string) {
        deletedKeys.push(key);
      },
      async delPattern() {},
      isReady() {
        return true;
      },
    };

    const testApp = createRouter();
    attachContext(testApp, {
      app: testApp,
      config: { appName: 'myapp' },
      cacheAdapters: new Map([['memory', adapter]]),
    } as any);

    await bustCache('user:123', testApp);
    expect(deletedKeys).toContain('cache:myapp:user:123');
  });

  test('bustCache calls del on every registered store', async () => {
    const { bustCache } = await getCacheResponseMiddleware();
    const { attachContext, createRouter } = await import('@lastshotlabs/slingshot-core');

    const memoryDeleted: string[] = [];
    const redisDeleted: string[] = [];
    const memoryAdapter = {
      name: 'memory' as const,
      async get() {
        return null;
      },
      async set() {},
      async del(key: string) {
        memoryDeleted.push(key);
      },
      async delPattern() {},
      isReady() {
        return true;
      },
    };
    const redisAdapter = {
      name: 'redis' as const,
      async get() {
        return null;
      },
      async set() {},
      async del(key: string) {
        redisDeleted.push(key);
      },
      async delPattern() {},
      isReady() {
        return true;
      },
    };

    const testApp = createRouter();
    attachContext(testApp, {
      app: testApp,
      config: { appName: 'app2' },
      cacheAdapters: new Map([
        ['memory', memoryAdapter],
        ['redis', redisAdapter],
      ] as any),
    } as any);

    await bustCache('items:all', testApp);
    expect(memoryDeleted).toContain('cache:app2:items:all');
    expect(redisDeleted).toContain('cache:app2:items:all');
  });

  test('bustCachePattern constructs pattern as cache:<appName>:<pattern> and calls delPattern', async () => {
    const { bustCachePattern } = await getCacheResponseMiddleware();
    const { attachContext, createRouter } = await import('@lastshotlabs/slingshot-core');

    const deletedPatterns: string[] = [];
    const adapter = {
      name: 'memory' as const,
      async get() {
        return null;
      },
      async set() {},
      async del() {},
      async delPattern(pattern: string) {
        deletedPatterns.push(pattern);
      },
      isReady() {
        return true;
      },
    };

    const testApp = createRouter();
    attachContext(testApp, {
      app: testApp,
      config: { appName: 'myapp' },
      cacheAdapters: new Map([['memory', adapter]]),
    } as any);

    await bustCachePattern('user:*', testApp);
    expect(deletedPatterns).toContain('cache:myapp:user:*');
  });

  test('bustCachePattern calls delPattern on every registered store', async () => {
    const { bustCachePattern } = await getCacheResponseMiddleware();
    const { attachContext, createRouter } = await import('@lastshotlabs/slingshot-core');

    const memoryPatterns: string[] = [];
    const redisPatterns: string[] = [];
    const memoryAdapter = {
      name: 'memory' as const,
      async get() {
        return null;
      },
      async set() {},
      async del() {},
      async delPattern(pattern: string) {
        memoryPatterns.push(pattern);
      },
      isReady() {
        return true;
      },
    };
    const redisAdapter = {
      name: 'redis' as const,
      async get() {
        return null;
      },
      async set() {},
      async del() {},
      async delPattern(pattern: string) {
        redisPatterns.push(pattern);
      },
      isReady() {
        return true;
      },
    };

    const testApp = createRouter();
    attachContext(testApp, {
      app: testApp,
      config: { appName: 'app3' },
      cacheAdapters: new Map([
        ['memory', memoryAdapter],
        ['redis', redisAdapter],
      ] as any),
    } as any);

    await bustCachePattern('products:*', testApp);
    expect(memoryPatterns).toContain('cache:app3:products:*');
    expect(redisPatterns).toContain('cache:app3:products:*');
  });
});

// ---------------------------------------------------------------------------
// cacheResponse middleware — store override and key function (lines 232-274)
// ---------------------------------------------------------------------------

describe('cacheResponse — middleware store resolution', () => {
  test('uses storeOverride when provided instead of resolvedStores.cache', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const testApp = await createTestApp({ plugins: [] });

    testApp.get(
      '/store-override-test',
      cacheResponse({ key: 'override-key', store: 'memory', ttl: 30 }),
      c => c.json({ ok: true }),
    );

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const res = await fetch(`http://localhost:${server.port}/store-override-test`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-cache')).toBe('MISS');

      // Second request should be HIT
      const res2 = await fetch(`http://localhost:${server.port}/store-override-test`);
      expect(res2.headers.get('x-cache')).toBe('HIT');
    } finally {
      server.stop(true);
    }
  });

  test('cacheResponse preserves safe response headers in cached response', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const testApp = await createTestApp({ plugins: [] });

    testApp.get(
      '/headers-test',
      cacheResponse({ key: 'headers-test', store: 'memory', ttl: 60 }),
      c => {
        c.header('x-custom-header', 'my-value');
        c.header('content-type', 'application/json');
        return c.json({ headers: true });
      },
    );

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const url = `http://localhost:${server.port}/headers-test`;
      await fetch(url); // prime cache
      const cached = await fetch(url); // HIT
      expect(cached.headers.get('x-cache')).toBe('HIT');
      expect(cached.headers.get('x-custom-header')).toBe('my-value');
    } finally {
      server.stop(true);
    }
  });

  test('cacheResponse returns original status code from cached response', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const testApp = await createTestApp({ plugins: [] });

    testApp.get(
      '/status-201-test',
      cacheResponse({ key: 'status-201', store: 'memory', ttl: 60 }),
      c => c.json({ created: true }, 201),
    );

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const url = `http://localhost:${server.port}/status-201-test`;
      const miss = await fetch(url);
      expect(miss.status).toBe(201);
      expect(miss.headers.get('x-cache')).toBe('MISS');

      const hit = await fetch(url);
      expect(hit.status).toBe(201);
      expect(hit.headers.get('x-cache')).toBe('HIT');
    } finally {
      server.stop(true);
    }
  });

  test('cacheResponse without ttl caches indefinitely', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const testApp = await createTestApp({ plugins: [] });

    testApp.get('/no-ttl-test', cacheResponse({ key: 'no-ttl', store: 'memory' }), c =>
      c.json({ indefinite: true }),
    );

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const url = `http://localhost:${server.port}/no-ttl-test`;
      await fetch(url); // MISS
      const hit = await fetch(url); // HIT
      expect(hit.headers.get('x-cache')).toBe('HIT');
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-tenant cache namespacing
// ---------------------------------------------------------------------------

describe('cacheResponse — per-tenant namespacing', () => {
  test('different tenants do not share cache entries', async () => {
    const { cacheResponse } = await getCacheResponseMiddleware();
    const testApp = await createTestApp({
      plugins: [],
      tenancy: {
        resolution: 'header',
        headerName: 'x-tenant-id',
        onResolve: async id => (id === 'alpha' || id === 'beta' ? { id } : null),
      },
    });

    let alphaCalls = 0;
    let betaCalls = 0;

    testApp.get(
      '/tenant-cache',
      cacheResponse({ key: 'shared-key', store: 'memory', ttl: 60 }),
      c => {
        const tenantId = c.get('tenantId');
        if (tenantId === 'alpha') alphaCalls++;
        else betaCalls++;
        return c.json({ tenant: tenantId });
      },
    );

    const server = Bun.serve({ port: 0, fetch: testApp.fetch });
    try {
      const url = `http://localhost:${server.port}/tenant-cache`;
      // Warm both caches
      await fetch(url, { headers: { 'x-tenant-id': 'alpha' } });
      await fetch(url, { headers: { 'x-tenant-id': 'beta' } });
      // Second requests — should come from cache
      const resAlpha = await fetch(url, { headers: { 'x-tenant-id': 'alpha' } });
      const resBeta = await fetch(url, { headers: { 'x-tenant-id': 'beta' } });
      expect(resAlpha.headers.get('x-cache')).toBe('HIT');
      expect(resBeta.headers.get('x-cache')).toBe('HIT');
      // Handler only called once per tenant
      expect(alphaCalls).toBe(1);
      expect(betaCalls).toBe(1);
      // Each tenant gets its own data
      const bodyAlpha = (await resAlpha.json()) as any;
      const bodyBeta = (await resBeta.json()) as any;
      expect(bodyAlpha.tenant).toBe('alpha');
      expect(bodyBeta.tenant).toBe('beta');
    } finally {
      server.stop(true);
    }
  });
});
