/**
 * Rate-limiter middleware tests for the search and suggest routes.
 *
 * Uses an injected store + ipResolver to avoid relying on real timers or
 * header parsing. Verifies 429 trip behaviour and per-IP isolation.
 */
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { createDbNativeProvider } from '../src/providers/dbNative';
import {
  type RateLimitStore,
  createInMemoryRateLimitStore,
  createRateLimitMiddleware,
} from '../src/routes/rateLimiter';
import { createSearchRouter } from '../src/routes/search';
import { createSuggestRouter } from '../src/routes/suggest';
import { createSearchManager } from '../src/searchManager';
import { createSearchTransformRegistry } from '../src/transformRegistry';
import type { SearchPluginConfig } from '../src/types/config';

const BASE_SETTINGS = {
  searchableFields: ['title'],
  filterableFields: [],
  sortableFields: [],
  facetableFields: [],
};

const PLUGIN_CONFIG: SearchPluginConfig = {
  providers: { default: { provider: 'db-native' } },
};

async function buildApp(store: RateLimitStore, max: number) {
  const provider = createDbNativeProvider();
  await provider.connect();
  await provider.createOrUpdateIndex('articles', BASE_SETTINGS);

  const manager = createSearchManager({
    pluginConfig: PLUGIN_CONFIG,
    transformRegistry: createSearchTransformRegistry(),
  });
  await manager.initialize([
    {
      name: 'Article',
      _pkField: 'id',
      _storageName: 'articles',
      fields: {
        id: { type: 'string', optional: false, primary: true, immutable: true },
        title: { type: 'string', optional: false, primary: false, immutable: false },
      },
      search: {
        fields: { title: { searchable: true, weight: 1 } },
      },
    } as unknown as ResolvedEntityConfig,
  ]);

  // Static IP so the limiter has a single bucket; tests pass the IP via header.
  const opts = {
    store,
    max,
    windowMs: 60_000,
    ipResolver: (c: { req: { header(name: string): string | undefined } }) =>
      c.req.header('x-test-ip') ?? '_unknown',
  };

  const app = new Hono();
  app.route('/search', createSearchRouter(manager, PLUGIN_CONFIG, opts));
  app.route('/search', createSuggestRouter(manager, PLUGIN_CONFIG, opts));
  return { app, manager };
}

describe('search rate limiter', () => {
  it('returns 429 once requests exceed `max` per (tenant, ip)', async () => {
    const store = createInMemoryRateLimitStore();
    const { app, manager } = await buildApp(store, 3);

    // 3 requests succeed.
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/search/articles?q=hello', {
        headers: { 'x-test-ip': '203.0.113.7' },
      });
      expect(res.status).toBe(200);
    }

    // 4th trips the limiter.
    const blocked = await app.request('/search/articles?q=hello', {
      headers: { 'x-test-ip': '203.0.113.7' },
    });
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: string; retryAfterSec: number };
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();

    await manager.teardown();
  });

  it('per-IP buckets are independent', async () => {
    const store = createInMemoryRateLimitStore();
    const { app, manager } = await buildApp(store, 1);

    const ipA = await app.request('/search/articles?q=hello', {
      headers: { 'x-test-ip': '203.0.113.10' },
    });
    expect(ipA.status).toBe(200);

    const ipAOver = await app.request('/search/articles?q=hello', {
      headers: { 'x-test-ip': '203.0.113.10' },
    });
    expect(ipAOver.status).toBe(429);

    // Different IP — should still get one through.
    const ipB = await app.request('/search/articles?q=hello', {
      headers: { 'x-test-ip': '203.0.113.99' },
    });
    expect(ipB.status).toBe(200);

    await manager.teardown();
  });

  it('also rate-limits the /:entity/suggest route', async () => {
    const store = createInMemoryRateLimitStore();
    const { app, manager } = await buildApp(store, 1);

    const ok = await app.request('/search/articles/suggest?q=he', {
      headers: { 'x-test-ip': '203.0.113.50' },
    });
    expect(ok.status).toBe(200);

    const blocked = await app.request('/search/articles/suggest?q=he', {
      headers: { 'x-test-ip': '203.0.113.50' },
    });
    expect(blocked.status).toBe(429);

    await manager.teardown();
  });

  it('exposes RateLimit-* headers on every response', async () => {
    const store = createInMemoryRateLimitStore();
    const { app, manager } = await buildApp(store, 5);

    const res = await app.request('/search/articles?q=hello', {
      headers: { 'x-test-ip': '203.0.113.200' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('4');
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();

    // Custom middleware path also works in isolation.
    const isolated = createRateLimitMiddleware({ store, max: 1 });
    expect(typeof isolated).toBe('function');

    await manager.teardown();
  });
});
