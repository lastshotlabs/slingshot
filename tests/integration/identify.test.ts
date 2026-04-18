import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, it } from 'bun:test';
import { SignJWT } from 'jose';
import { createTestApp } from '../setup';

function getSessionRepo(app: any) {
  const runtime = (app as any).ctx.pluginState.get(AUTH_RUNTIME_KEY) as AuthRuntimeContext;
  return runtime.repos.session;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function registerAndLogin(app: OpenAPIHono<any>) {
  const reg = await app.request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'identify@test.com', password: 'password123' }),
  });
  const { token, userId } = await reg.json();
  return { token, userId };
}

// ---------------------------------------------------------------------------
// Basic identify behaviour via /me-raw (no auth required)
// ---------------------------------------------------------------------------

describe('identify middleware — /me-raw (no auth gate)', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp();
  });

  it('sets authUserId=null when no token is provided', async () => {
    const res = await app.request('/me-raw');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authUserId).toBeNull();
    expect(body.sessionId).toBeNull();
  });

  it('sets authUserId when x-user-token header is valid', async () => {
    const { token, userId } = await registerAndLogin(app);
    const res = await app.request('/me-raw', {
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authUserId).toBe(userId);
    expect(body.sessionId).toBeTruthy();
  });

  it('sets authUserId=null when token has no sid claim', async () => {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const tokenNoSid = await new SignJWT({ sub: 'test-user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(secret);

    const res = await app.request('/me-raw', {
      headers: { 'x-user-token': tokenNoSid },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authUserId).toBeNull();
    expect(body.sessionId).toBeNull();
  });

  it('sets authUserId=null for an invalid/garbage token', async () => {
    const res = await app.request('/me-raw', {
      headers: { 'x-user-token': 'not.a.valid.jwt' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authUserId).toBeNull();
  });

  it('sets authUserId=null when session is revoked (after logout)', async () => {
    const { token } = await registerAndLogin(app);

    // Logout revokes the session
    await app.request('/auth/logout', {
      method: 'POST',
      headers: { 'x-user-token': token },
    });

    const res = await app.request('/me-raw', {
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authUserId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Identify blocks at userAuth-protected routes
// ---------------------------------------------------------------------------

describe('identify middleware — /auth/me (userAuth gate)', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp();
  });

  it('returns 200 with valid token', async () => {
    const { token } = await registerAndLogin(app);
    const res = await app.request('/auth/me', {
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(200);
  });

  it('returns 401 with no token', async () => {
    const res = await app.request('/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 with invalid token', async () => {
    const res = await app.request('/auth/me', {
      headers: { 'x-user-token': 'garbage' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 after session revoked', async () => {
    const { token } = await registerAndLogin(app);
    await app.request('/auth/logout', {
      method: 'POST',
      headers: { 'x-user-token': token },
    });
    const res = await app.request('/auth/me', {
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// lastActiveAt tracking
// ---------------------------------------------------------------------------

describe('identify middleware — trackLastActive', () => {
  it('updates lastActiveAt on authenticated requests when trackLastActive: true', async () => {
    // Create the app inside the test so setTrackLastActive(true) is the last call
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          sessionPolicy: { trackLastActive: true },
        },
      },
    );

    const reg = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tracked@test.com', password: 'password123' }),
    });
    const { token, userId } = await reg.json();

    const repo = getSessionRepo(app);
    const sessionsBefore = await repo.getUserSessions(userId);
    const lastActiveBefore = sessionsBefore[0]?.lastActiveAt ?? 0;

    // Wait so clock advances before the request
    await new Promise(r => setTimeout(r, 15));

    await app.request('/me-raw', { headers: { 'x-user-token': token } });

    // Give the fire-and-forget update time to complete
    await new Promise(r => setTimeout(r, 30));

    const sessionsAfter = await repo.getUserSessions(userId);
    const lastActiveAfter = sessionsAfter[0]?.lastActiveAt ?? 0;

    expect(lastActiveAfter).toBeGreaterThan(lastActiveBefore);
  });

  it('does not update lastActiveAt when trackLastActive: false', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          sessionPolicy: { trackLastActive: false },
        },
      },
    );

    const reg = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'untracked@test.com', password: 'password123' }),
    });
    const { token, userId } = await reg.json();

    const repo = getSessionRepo(app);
    const sessionsBefore = await repo.getUserSessions(userId);
    const lastActiveBefore = sessionsBefore[0]?.lastActiveAt ?? 0;

    await new Promise(r => setTimeout(r, 15));

    await app.request('/me-raw', { headers: { 'x-user-token': token } });
    await new Promise(r => setTimeout(r, 30));

    const sessionsAfter = await repo.getUserSessions(userId);
    const lastActiveAfter = sessionsAfter[0]?.lastActiveAt ?? 0;

    expect(lastActiveAfter).toBe(lastActiveBefore);
  });
});
