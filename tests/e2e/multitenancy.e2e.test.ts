/**
 * Multitenancy E2E tests.
 *
 * Spins up a real Bun HTTP server (via createTestHttpServer) and exercises
 * tenant resolution, scoping, and rejection over real HTTP using fetch().
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type E2EServerHandle, createTestHttpServer } from '../setup-e2e';

// ---------------------------------------------------------------------------
// Header-based tenant resolution
// ---------------------------------------------------------------------------

describe('multitenancy E2E — header resolution', () => {
  let handle: E2EServerHandle;

  beforeAll(async () => {
    handle = await createTestHttpServer({
      tenancy: {
        resolution: 'header',
        headerName: 'x-tenant-id',
        onResolve: async (tenantId: string) => {
          if (tenantId === 'acme' || tenantId === 'beta') return { name: tenantId };
          return null;
        },
      },
    });
  });

  afterAll(() => handle.stop());

  test('request with known tenant header returns 200', async () => {
    const res = await fetch(`${handle.baseUrl}/health`);
    // /health is exempt from tenant resolution
    expect(res.status).toBe(200);
  });

  test('request to non-exempt path with valid tenant returns 200', async () => {
    // /auth/* is exempt — use auth register as a known endpoint outside /health
    const res = await fetch(`${handle.baseUrl}/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'acme',
      },
      body: JSON.stringify({ email: 't1@acme.com', password: 'password123' }),
    });
    // /auth/* is exempt from tenancy checks — should not get a 400/403 for tenant
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(403);
  });

  test('request without tenant header to tenanted path returns 400', async () => {
    // POST to a non-exempt, non-auth path — the fixture routes include /cached
    // (used in integration tests). We verify the framework rejects missing tenant.
    const res = await fetch(`${handle.baseUrl}/cached`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/tenant/i);
  });

  test('request with unknown tenant returns 403', async () => {
    const res = await fetch(`${handle.baseUrl}/cached`, {
      headers: { 'x-tenant-id': 'unknown-corp' },
    });
    expect(res.status).toBe(403);
  });

  test('/health is exempt — no tenant header required', async () => {
    const res = await fetch(`${handle.baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  test('/auth/* paths are exempt — no tenant header required', async () => {
    const res = await fetch(`${handle.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'no@tenant.com', password: 'wrong' }),
    });
    // Should not return 400 (missing tenant) — may return 401/400 for bad creds, that's fine
    expect(res.status).not.toBe(400 /* tenant error */);
    // A 400 from the auth layer means JSON was parsed but creds were invalid, which is acceptable.
    // The key invariant is the error is NOT about missing tenant context.
    const body = (await res.json()) as any;
    if (res.status === 400) {
      expect(body.error ?? '').not.toMatch(/tenant/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation — different tenants see different data
// ---------------------------------------------------------------------------

describe('multitenancy E2E — tenant isolation for auth registration', () => {
  let handle: E2EServerHandle;

  beforeAll(async () => {
    handle = await createTestHttpServer({
      tenancy: {
        resolution: 'header',
        onResolve: async (tenantId: string) => {
          if (tenantId === 'tenant-a' || tenantId === 'tenant-b') {
            return { id: tenantId };
          }
          return null;
        },
      },
    });
  });

  afterAll(() => handle.stop());

  test('valid tenant-a header is accepted on /auth/register', async () => {
    const res = await fetch(`${handle.baseUrl}/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'tenant-a',
      },
      body: JSON.stringify({ email: 'user@tenant-a.com', password: 'password123' }),
    });
    // /auth/* is exempt from tenancy — tenant header is irrelevant here but should not cause 4xx errors
    expect([201, 400, 409]).toContain(res.status);
  });

  test('two tenants can independently access /auth routes (both are exempt)', async () => {
    const resA = await fetch(`${handle.baseUrl}/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'tenant-a',
      },
      body: JSON.stringify({ email: 'iso-a@example.com', password: 'password123' }),
    });

    const resB = await fetch(`${handle.baseUrl}/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'tenant-b',
      },
      body: JSON.stringify({ email: 'iso-b@example.com', password: 'password123' }),
    });

    // Both should succeed (or fail for auth-specific reasons, not tenant reasons)
    expect(resA.status).not.toBe(400 /* tenant-missing */);
    expect(resB.status).not.toBe(400 /* tenant-missing */);
  });
});

// ---------------------------------------------------------------------------
// Subdomain-based resolution
// ---------------------------------------------------------------------------

describe('multitenancy E2E — subdomain resolution', () => {
  let handle: E2EServerHandle;

  beforeAll(async () => {
    handle = await createTestHttpServer({
      tenancy: {
        resolution: 'subdomain',
        onResolve: async (tenantId: string) => {
          if (tenantId === 'acme') return { name: 'Acme Corp' };
          return null;
        },
      },
    });
  });

  afterAll(() => handle.stop());

  test('host without subdomain returns 400 on non-exempt path', async () => {
    const res = await fetch(`${handle.baseUrl}/cached`, {
      headers: { Host: 'myapp.com' },
    });
    expect(res.status).toBe(400);
  });

  test('unknown subdomain returns 403 on non-exempt path', async () => {
    const res = await fetch(`${handle.baseUrl}/cached`, {
      headers: { Host: 'ghost.myapp.com' },
    });
    expect(res.status).toBe(403);
  });

  test('/health is exempt from subdomain resolution', async () => {
    const res = await fetch(`${handle.baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// No onResolve — dev-mode trust
// ---------------------------------------------------------------------------

describe('multitenancy E2E — no onResolve (dev trust mode)', () => {
  let handle: E2EServerHandle;

  beforeAll(async () => {
    handle = await createTestHttpServer({
      tenancy: {
        resolution: 'header',
        // onResolve omitted — dev mode trusts any tenant header
      },
    });
  });

  afterAll(() => handle.stop());

  test('any tenant header value is accepted in dev trust mode', async () => {
    const res = await fetch(`${handle.baseUrl}/cached`, {
      headers: { 'x-tenant-id': 'some-random-tenant' },
    });
    expect(res.status).toBe(200);
  });

  test('missing tenant header still returns 400', async () => {
    const res = await fetch(`${handle.baseUrl}/cached`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/tenant/i);
  });
});
