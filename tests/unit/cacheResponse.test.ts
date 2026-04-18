/**
 * Unit tests for the cacheResponse middleware and cache utilities.
 *
 * Tests header sanitization (UNCACHEABLE_HEADERS), cache key construction,
 * per-tenant namespacing, cache HIT/MISS behavior, and non-2xx bypass,
 * using the in-memory cache adapter via createTestApp().
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getCacheResponseMiddleware() {
  return import('../../src/framework/middleware/cacheResponse');
}

let app: OpenAPIHono<any>;

beforeEach(async () => {
  app = await createTestApp();
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
