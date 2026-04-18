import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  getTenantCacheFromApp,
  invalidateTenantCache,
} from '../../src/framework/middleware/tenant';
import { createTestApp } from '../setup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Routes used in tests:
//   GET /health — exempt path (always skips tenant resolution)
//   GET /cached  — non-exempt path that doesn't require auth

// ---------------------------------------------------------------------------
// Header-based tenant resolution
// ---------------------------------------------------------------------------

describe('tenancy middleware — header resolution', () => {
  let app: OpenAPIHono<any>;
  let resolveCallCount = 0;

  beforeEach(async () => {
    resolveCallCount = 0;
    app = await createTestApp({
      tenancy: {
        resolution: 'header',
        headerName: 'x-tenant-id',
        onResolve: async tenantId => {
          resolveCallCount++;
          if (tenantId === 'acme') return { name: 'Acme Corp' };
          return null;
        },
      },
    });
  });

  it('resolves tenant from x-tenant-id header', async () => {
    const res = await app.request('/cached', {
      headers: { 'x-tenant-id': 'acme' },
    });
    expect(res.status).toBe(200);
  });

  it('returns 400 when no tenant header is present', async () => {
    const res = await app.request('/cached');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/tenant/i);
  });

  it('rejects unknown tenant (onResolve returns null) with 403', async () => {
    const res = await app.request('/cached', {
      headers: { 'x-tenant-id': 'unknown-tenant' },
    });
    expect(res.status).toBe(403);
  });

  it('skips resolution for /health (exempt path)', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(resolveCallCount).toBe(0);
  });

  it('skips resolution for /auth/* paths', async () => {
    await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(resolveCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Subdomain resolution
// ---------------------------------------------------------------------------

describe('tenancy middleware — subdomain resolution', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp({
      tenancy: {
        resolution: 'subdomain',
        onResolve: async tenantId => {
          if (tenantId === 'tenant1') return { id: 'tenant1' };
          return null;
        },
      },
    });
  });

  it('resolves tenant from subdomain', async () => {
    const res = await app.request('/cached', {
      headers: { Host: 'tenant1.myapp.com' },
    });
    expect(res.status).toBe(200);
  });

  it('returns 400 when host has no subdomain (fewer than 3 parts)', async () => {
    const res = await app.request('/cached', {
      headers: { Host: 'myapp.com' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown subdomain tenant', async () => {
    const res = await app.request('/cached', {
      headers: { Host: 'ghost.myapp.com' },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Path-based resolution
// ---------------------------------------------------------------------------

describe('tenancy middleware — path resolution', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp({
      tenancy: {
        resolution: 'path',
        pathSegment: 0,
        onResolve: async tenantId => {
          if (tenantId === 'acme') return { slug: 'acme' };
          return null;
        },
      },
    });
  });

  it('resolves tenant from first path segment', async () => {
    // /acme/health would be exempt. Use /acme/cached (a non-exempt path under tenant segment)
    // Actually path resolution means the FIRST segment is the tenant, then the rest is the route.
    // /health is still exempt, but the middleware checks path BEFORE extracting tenant.
    // So /acme/cached: tenantId = "acme", but the route is still matched as /acme/cached
    // which won't exist as a route. Let's use a known exempt path test instead.
    const res = await app.request('/acme/cached');
    // The tenantId resolves to "acme" but the actual route /acme/cached doesn't exist → 404
    // What matters is it doesn't return 400 (missing tenant) or 403 (invalid tenant)
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(403);
  });

  it('rejects unknown first path segment tenant', async () => {
    const res = await app.request('/ghost/cached');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// LRU cache: onResolve called only once per unique tenantId
// ---------------------------------------------------------------------------

describe('tenancy middleware — LRU cache', () => {
  let app: OpenAPIHono<any>;
  let callCount: number;

  beforeEach(async () => {
    callCount = 0;
    app = await createTestApp({
      tenancy: {
        resolution: 'header',
        cacheTtlMs: 60_000,
        onResolve: async tenantId => {
          callCount++;
          return tenantId === 'cacheme' ? { name: 'CacheMe' } : null;
        },
      },
    });
  });

  it('calls onResolve only once for repeated requests with same tenantId', async () => {
    await app.request('/cached', { headers: { 'x-tenant-id': 'cacheme' } });
    await app.request('/cached', { headers: { 'x-tenant-id': 'cacheme' } });
    await app.request('/cached', { headers: { 'x-tenant-id': 'cacheme' } });
    expect(callCount).toBe(1);
  });

  it('calls onResolve again after cache invalidation', async () => {
    // Cold start: onResolve called, result cached
    await app.request('/cached', { headers: { 'x-tenant-id': 'cacheme' } });
    expect(callCount).toBe(1);

    invalidateTenantCache(getTenantCacheFromApp(app as object), 'cacheme');

    // After invalidation: onResolve called again
    await app.request('/cached', { headers: { 'x-tenant-id': 'cacheme' } });
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Custom rejection status
// ---------------------------------------------------------------------------

describe('tenancy middleware — custom rejectionStatus', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp({
      tenancy: {
        resolution: 'header',
        rejectionStatus: 404,
        onResolve: async () => null,
      },
    });
  });

  it('uses custom rejectionStatus when onResolve returns null', async () => {
    const res = await app.request('/cached', { headers: { 'x-tenant-id': 'any' } });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// No onResolve — dev mode trust (no validation)
// ---------------------------------------------------------------------------

describe('tenancy middleware — no onResolve (dev mode)', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp({
      tenancy: {
        resolution: 'header',
        // onResolve omitted — in development this logs a warning but still starts
      },
    });
  });

  it('trusts the tenant header without validation', async () => {
    const res = await app.request('/cached', { headers: { 'x-tenant-id': 'any-tenant' } });
    expect(res.status).toBe(200);
  });

  it('still returns 400 when no tenant header is provided', async () => {
    const res = await app.request('/cached');
    expect(res.status).toBe(400);
  });
});
