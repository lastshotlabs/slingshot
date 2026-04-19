import { describe, expect, it } from 'bun:test';
import {
  createTenantMiddleware,
  getTenantCacheFromApp,
  invalidateTenantCache,
} from '../../src/framework/middleware/tenant';
import type { TenantCacheCarrier, TenantResolutionCache } from '../../src/framework/middleware/tenant';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Minimal Hono context helper
// ---------------------------------------------------------------------------

function buildApp(config: Parameters<typeof createTenantMiddleware>[0]) {
  const carrier: TenantCacheCarrier = { cache: null };
  const app = new Hono();
  app.use('/*', createTenantMiddleware(config, carrier));
  app.get('/*', c => c.json({ tenantId: c.get('tenantId') }));
  return { app, carrier };
}

// ---------------------------------------------------------------------------
// LruCache.delete (line 85) — via invalidateTenantCache
// ---------------------------------------------------------------------------

describe('tenant middleware — LruCache.delete via invalidateTenantCache', () => {
  it('removes a cached tenant entry so the next request re-resolves', async () => {
    let callCount = 0;
    const { app, carrier } = buildApp({
      resolution: 'header',
      cacheTtlMs: 60_000,
      onResolve: async (id: string) => {
        callCount++;
        return { id };
      },
    });

    // First request — populates cache
    await app.request('/api', {
      method: 'GET',
      headers: { 'x-tenant-id': 'acme' },
    });
    expect(callCount).toBe(1);

    // Second request — served from cache
    await app.request('/api', {
      method: 'GET',
      headers: { 'x-tenant-id': 'acme' },
    });
    expect(callCount).toBe(1); // still 1

    // Invalidate the cache entry (exercises LruCache.delete on line 85)
    invalidateTenantCache(carrier.cache, 'acme');

    // Third request — cache miss, onResolve called again
    await app.request('/api', {
      method: 'GET',
      headers: { 'x-tenant-id': 'acme' },
    });
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// invalidateTenantCache (lines 141-144) — null/undefined safe
// ---------------------------------------------------------------------------

describe('invalidateTenantCache', () => {
  it('does nothing when cache is null (no-op guard)', () => {
    // Should not throw
    expect(() => invalidateTenantCache(null, 'acme')).not.toThrow();
  });

  it('does nothing when cache is undefined', () => {
    expect(() => invalidateTenantCache(undefined, 'acme')).not.toThrow();
  });

  it('calls delete on a live cache object', () => {
    let deleted: string | undefined;
    const fakeCache = {
      get: () => undefined,
      set: () => {},
      delete: (key: string) => {
        deleted = key;
      },
    };
    invalidateTenantCache(fakeCache, 'tenant-123');
    expect(deleted).toBe('tenant-123');
  });
});

// ---------------------------------------------------------------------------
// getTenantCacheFromApp (lines 159-163)
// ---------------------------------------------------------------------------

describe('getTenantCacheFromApp', () => {
  it('returns the cache from pluginState when present', () => {
    const fakeCache: TenantResolutionCache = {
      get: () => undefined,
      set: () => {},
      delete: () => {},
    };

    // Build a mock app with Symbol.for('slingshot.context') containing pluginState
    const pluginState = new Map<string, unknown>();
    pluginState.set('tenantResolutionCache', fakeCache);

    const app = {
      [Symbol.for('slingshot.context')]: { pluginState },
    };

    const result = getTenantCacheFromApp(app);
    expect(result).toBe(fakeCache);
  });

  it('returns null when tenantResolutionCache is not in pluginState', () => {
    const pluginState = new Map<string, unknown>();
    const app = {
      [Symbol.for('slingshot.context')]: { pluginState },
    };

    const result = getTenantCacheFromApp(app);
    expect(result).toBeNull();
  });

  it('returns null when tenantResolutionCache is explicitly null', () => {
    const pluginState = new Map<string, unknown>();
    pluginState.set('tenantResolutionCache', null);
    const app = {
      [Symbol.for('slingshot.context')]: { pluginState },
    };

    const result = getTenantCacheFromApp(app);
    expect(result).toBeNull();
  });
});
