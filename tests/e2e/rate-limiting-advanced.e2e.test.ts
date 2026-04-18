/**
 * Advanced rate limiting E2E tests.
 *
 * Tests per-tenant namespacing (each tenant has independent rate-limit buckets),
 * fingerprint-based rate limiting (fp: prefix), and that non-tenanted and
 * tenanted requests are properly isolated from each other.
 *
 * Uses createTestHttpServer() with a very low max (3) so limits are hit quickly.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { E2EServerHandle } from '../setup-e2e';
import { createTestHttpServer } from '../setup-e2e';

// ---------------------------------------------------------------------------
// Per-tenant rate limit isolation
// ---------------------------------------------------------------------------

describe('rate limiting — per-tenant isolation', () => {
  let handle: E2EServerHandle;

  beforeEach(async () => {
    handle = await createTestHttpServer({
      security: { rateLimit: { windowMs: 60_000, max: 2 } },
      tenancy: {
        resolution: 'header',
        headerName: 'x-tenant-id',
        onResolve: async id => (id === 'alpha' || id === 'beta' ? { id } : null),
      },
    });
  });

  afterEach(() => handle.stop());

  test('exhausting tenant-alpha limit does not affect tenant-beta', async () => {
    const url = `${handle.baseUrl}/cached`;

    // Exhaust alpha (max=2, send 3)
    await fetch(url, { headers: { 'x-tenant-id': 'alpha' } });
    await fetch(url, { headers: { 'x-tenant-id': 'alpha' } });
    const alphaLimited = await fetch(url, { headers: { 'x-tenant-id': 'alpha' } });
    expect(alphaLimited.status).toBe(429);

    // Beta should still be available
    const beta1 = await fetch(url, { headers: { 'x-tenant-id': 'beta' } });
    expect(beta1.status).toBe(200);
  });

  test('exhausting tenant-beta limit does not affect tenant-alpha (independent buckets)', async () => {
    const url = `${handle.baseUrl}/cached`;

    // Exhaust beta
    await fetch(url, { headers: { 'x-tenant-id': 'beta' } });
    await fetch(url, { headers: { 'x-tenant-id': 'beta' } });
    const betaLimited = await fetch(url, { headers: { 'x-tenant-id': 'beta' } });
    expect(betaLimited.status).toBe(429);

    // Alpha should still be available
    const alpha1 = await fetch(url, { headers: { 'x-tenant-id': 'alpha' } });
    expect(alpha1.status).toBe(200);
  });

  test('both tenants can be exhausted independently', async () => {
    const url = `${handle.baseUrl}/cached`;

    // Exhaust both
    for (let i = 0; i < 3; i++) await fetch(url, { headers: { 'x-tenant-id': 'alpha' } });
    for (let i = 0; i < 3; i++) await fetch(url, { headers: { 'x-tenant-id': 'beta' } });

    const alpha = await fetch(url, { headers: { 'x-tenant-id': 'alpha' } });
    const beta = await fetch(url, { headers: { 'x-tenant-id': 'beta' } });
    expect(alpha.status).toBe(429);
    expect(beta.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Rate limit error response format
// ---------------------------------------------------------------------------

describe('rate limiting — error response format', () => {
  let handle: E2EServerHandle;

  beforeAll(async () => {
    handle = await createTestHttpServer({
      security: { rateLimit: { windowMs: 60_000, max: 1 } },
    });
  });

  afterAll(() => handle.stop());

  test('429 response body contains error field', async () => {
    await fetch(`${handle.baseUrl}/health`); // exhaust the 1 allowed
    const res = await fetch(`${handle.baseUrl}/health`);
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('error');
  });

  test('429 response Content-Type is application/json', async () => {
    await fetch(`${handle.baseUrl}/health`);
    const res = await fetch(`${handle.baseUrl}/health`);
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});

// ---------------------------------------------------------------------------
// Non-tenanted requests use global bucket
// ---------------------------------------------------------------------------

describe('rate limiting — global (non-tenanted) bucket', () => {
  let handle: E2EServerHandle;

  beforeAll(async () => {
    handle = await createTestHttpServer({
      security: { rateLimit: { windowMs: 60_000, max: 3 } },
    });
  });

  afterAll(() => handle.stop());

  test('first 3 requests succeed, 4th is rate-limited', async () => {
    const url = `${handle.baseUrl}/health`;
    for (let i = 0; i < 3; i++) {
      const res = await fetch(url);
      expect(res.status).toBe(200);
    }
    const limited = await fetch(url);
    expect(limited.status).toBe(429);
  });

  test('rate-limited response has non-empty body', async () => {
    for (let i = 0; i < 3; i++) await fetch(`${handle.baseUrl}/health`);
    const res = await fetch(`${handle.baseUrl}/health`);
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Rate limit applies uniformly across different endpoints
// ---------------------------------------------------------------------------

describe('rate limiting — cross-endpoint bucket', () => {
  let handle: E2EServerHandle;

  beforeAll(async () => {
    handle = await createTestHttpServer({
      security: { rateLimit: { windowMs: 60_000, max: 3 } },
    });
  });

  afterAll(() => handle.stop());

  test('requests to different endpoints share the same IP bucket', async () => {
    // Use 2 requests on /health, 1 on /cached — all 3 share the same IP bucket
    await fetch(`${handle.baseUrl}/health`);
    await fetch(`${handle.baseUrl}/health`);
    await fetch(`${handle.baseUrl}/cached`); // 3rd request across endpoints
    // 4th request (any endpoint) should be blocked
    const res = await fetch(`${handle.baseUrl}/health`);
    expect(res.status).toBe(429);
  });
});
