import { addUserRole, setTenantRoles } from '@auth/lib/roles';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { bustCache, bustCachePattern } from '../../src/framework/middleware/cacheResponse';
import { authHeader, createMemoryAuthAdapter, createTestApp } from '../setup';

let app: OpenAPIHono<any>;
let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;

beforeEach(async () => {
  memoryAuthAdapter = createMemoryAuthAdapter();
  app = await createTestApp({}, { auth: { adapter: memoryAuthAdapter } });
});

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function registerUser(email = 'mw@example.com', password = 'password123') {
  const res = await app.request('/auth/register', json({ email, password }));
  return res.json() as Promise<{ token: string; userId: string }>;
}

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------

describe('requireRole middleware', () => {
  test('returns 401 without auth', async () => {
    const res = await app.request('/protected/admin');
    expect(res.status).toBe(401);
  });

  test('returns 403 without admin role', async () => {
    const { token } = await registerUser();

    const res = await app.request('/protected/admin', { headers: authHeader(token) });
    expect(res.status).toBe(403);
  });

  test('returns 200 with admin role', async () => {
    const { token, userId } = await registerUser();
    await addUserRole(userId, 'admin', undefined, memoryAuthAdapter);

    const res = await app.request('/protected/admin', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('admin only');
  });
});

// ---------------------------------------------------------------------------
// requireRole — 401 without userAuth gate (hits requireRole's own 401 branch)
// ---------------------------------------------------------------------------

describe('requireRole without userAuth', () => {
  test('returns 401 when userId is null (requireRole)', async () => {
    const res = await app.request('/protected/role-no-auth');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  test('returns 401 when userId is null (requireRole.global)', async () => {
    const res = await app.request('/protected/global-role-no-auth');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });
});

// ---------------------------------------------------------------------------
// requireRole — multi-role
// ---------------------------------------------------------------------------

describe('requireRole multi-role', () => {
  test('allows access with any matching role', async () => {
    const { token, userId } = await registerUser('multi1@example.com');
    await addUserRole(userId, 'moderator', undefined, memoryAuthAdapter);
    const res = await app.request('/protected/multi-role', { headers: authHeader(token) });
    expect(res.status).toBe(200);
  });

  test('denies access when user has none of the listed roles', async () => {
    const { token } = await registerUser('multi2@example.com');
    const res = await app.request('/protected/multi-role', { headers: authHeader(token) });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// requireRole.global
// ---------------------------------------------------------------------------

describe('requireRole.global', () => {
  test('returns 401 without auth', async () => {
    const res = await app.request('/protected/global-role');
    expect(res.status).toBe(401);
  });

  test('returns 403 without required role', async () => {
    const { token } = await registerUser('global1@example.com');
    const res = await app.request('/protected/global-role', { headers: authHeader(token) });
    expect(res.status).toBe(403);
  });

  test('returns 200 with required app-wide role', async () => {
    const { token, userId } = await registerUser('global2@example.com');
    await addUserRole(userId, 'admin', undefined, memoryAuthAdapter);
    const res = await app.request('/protected/global-role', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('global admin');
  });
});

// ---------------------------------------------------------------------------
// requireRole — tenant-scoped
// ---------------------------------------------------------------------------

describe('requireRole tenant-scoped', () => {
  test('uses tenant roles when tenantId is set', async () => {
    const { token, userId } = await registerUser('tenant1@example.com');
    await setTenantRoles(userId, 'tenant-abc', ['admin'], undefined, memoryAuthAdapter);
    const res = await app.request('/protected/tenant-admin', {
      headers: { ...authHeader(token), 'x-tenant-id': 'tenant-abc' },
    });
    expect(res.status).toBe(200);
  });

  test('denies access when user lacks tenant role', async () => {
    const { token } = await registerUser('tenant2@example.com');
    const res = await app.request('/protected/tenant-admin', {
      headers: { ...authHeader(token), 'x-tenant-id': 'tenant-abc' },
    });
    expect(res.status).toBe(403);
  });

  test('falls back to app-wide roles when no tenant header', async () => {
    const { token, userId } = await registerUser('tenant3@example.com');
    await addUserRole(userId, 'admin', undefined, memoryAuthAdapter);
    const res = await app.request('/protected/tenant-admin', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
  });

  test('tenant role does not grant access in different tenant', async () => {
    const { token, userId } = await registerUser('tenant4@example.com');
    await setTenantRoles(userId, 'tenant-abc', ['admin'], undefined, memoryAuthAdapter);
    const res = await app.request('/protected/tenant-admin', {
      headers: { ...authHeader(token), 'x-tenant-id': 'tenant-xyz' },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// cacheResponse
// ---------------------------------------------------------------------------

describe('cacheResponse middleware', () => {
  test('first request returns x-cache MISS', async () => {
    const res = await app.request('/cached');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('MISS');
  });

  test('second request returns x-cache HIT with same body', async () => {
    const res1 = await app.request('/cached');
    const body1 = await res1.json();

    const res2 = await app.request('/cached');
    expect(res2.headers.get('x-cache')).toBe('HIT');
    const body2 = await res2.json();
    expect(body2.time).toBe(body1.time);
  });

  test('bustCache clears the cache', async () => {
    // Prime the cache
    await app.request('/cached');
    const res1 = await app.request('/cached');
    expect(res1.headers.get('x-cache')).toBe('HIT');

    // Bust it
    await bustCache('test-cached', app);

    // Should be a MISS now
    const res2 = await app.request('/cached');
    expect(res2.headers.get('x-cache')).toBe('MISS');
  });
});

// ---------------------------------------------------------------------------
// cacheResponse — dynamic key + bustCachePattern
// ---------------------------------------------------------------------------

describe('cacheResponse dynamic key', () => {
  test('dynamic key function produces separate cache entries', async () => {
    const res1 = await app.request('/cached-dynamic?k=alpha');
    const body1 = await res1.json();
    expect(res1.headers.get('x-cache')).toBe('MISS');

    const res2 = await app.request('/cached-dynamic?k=beta');
    expect(res2.headers.get('x-cache')).toBe('MISS');

    // Same key returns HIT
    const res3 = await app.request('/cached-dynamic?k=alpha');
    const body3 = await res3.json();
    expect(res3.headers.get('x-cache')).toBe('HIT');
    expect(body3.time).toBe(body1.time);
  });

  test('bustCachePattern clears matching entries', async () => {
    // Prime two dynamic cache entries
    await app.request('/cached-dynamic?k=alpha');
    await app.request('/cached-dynamic?k=beta');

    // Verify cached
    const hit = await app.request('/cached-dynamic?k=alpha');
    expect(hit.headers.get('x-cache')).toBe('HIT');

    // Bust all dynamic cache entries
    await bustCachePattern('dyn:*', app);

    // Both should be MISS now
    const miss1 = await app.request('/cached-dynamic?k=alpha');
    expect(miss1.headers.get('x-cache')).toBe('MISS');
    const miss2 = await app.request('/cached-dynamic?k=beta');
    expect(miss2.headers.get('x-cache')).toBe('MISS');
  });
});
