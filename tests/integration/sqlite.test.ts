import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { authHeader, createTestApp } from '../setup';

let app: OpenAPIHono<any>;

beforeEach(async () => {
  app = await createTestApp({
    db: {
      mongo: false,
      redis: false,
      sessions: 'sqlite',
      cache: 'sqlite',
      auth: 'sqlite',
      sqlite: ':memory:',
    },
  });
});

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// SQLite Adapter Parity Tests
// ---------------------------------------------------------------------------

describe('SQLite adapter', () => {
  test('register creates user and returns token', async () => {
    const res = await app.request(
      '/auth/register',
      json({ email: 'sq@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.userId).toBeString();
  });

  test('login with valid credentials', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'sqlogin@example.com', password: 'password123' }),
    );

    const res = await app.request(
      '/auth/login',
      json({ email: 'sqlogin@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
  });

  test('login rejects invalid password', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'sqbad@example.com', password: 'password123' }),
    );

    const res = await app.request(
      '/auth/login',
      json({ email: 'sqbad@example.com', password: 'wrongpassword' }),
    );
    expect(res.status).toBe(401);
  });

  test('session listing works', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'sqsess@example.com', password: 'password123' }),
    );
    const { token } = await regRes.json();

    const res = await app.request('/auth/sessions', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const { sessions } = await res.json();
    expect(sessions).toHaveLength(1);
  });

  test('logout invalidates session', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'sqout@example.com', password: 'password123' }),
    );
    const { token } = await regRes.json();

    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(logoutRes.status).toBe(200);

    const meRes = await app.request('/auth/me', { headers: authHeader(token) });
    expect(meRes.status).toBe(401);
  });

  test('multiple logins create separate sessions', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'sqmulti@example.com', password: 'password123' }),
    );
    const login1 = await app.request(
      '/auth/login',
      json({ email: 'sqmulti@example.com', password: 'password123' }),
    );
    const { token: t1 } = await login1.json();
    const login2 = await app.request(
      '/auth/login',
      json({ email: 'sqmulti@example.com', password: 'password123' }),
    );
    const { token: t2 } = await login2.json();

    const sessRes = await app.request('/auth/sessions', { headers: authHeader(t1) });
    const { sessions } = await sessRes.json();
    // register creates 1 session + 2 logins = 3
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    expect(t1).not.toBe(t2);
  });

  test('delete session by sessionId', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'sqdel@example.com', password: 'password123' }),
    );
    const { token } = await regRes.json();

    // Create a second session
    const login2 = await app.request(
      '/auth/login',
      json({ email: 'sqdel@example.com', password: 'password123' }),
    );
    await login2.json();

    // List sessions and delete the second one
    const sessRes = await app.request('/auth/sessions', { headers: authHeader(token) });
    const { sessions } = await sessRes.json();
    const otherSession = sessions.find((s: any) => s.sessionId !== sessions[0].sessionId);

    const delRes = await app.request(`/auth/sessions/${otherSession.sessionId}`, {
      method: 'DELETE',
      headers: authHeader(token),
    });
    expect(delRes.status).toBe(200);

    // Verify sessions reduced
    const sessRes2 = await app.request('/auth/sessions', { headers: authHeader(token) });
    const { sessions: remaining } = await sessRes2.json();
    expect(remaining.length).toBe(sessions.length - 1);
  });

  test('GET /auth/me returns user info', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'sqme@example.com', password: 'password123' }),
    );
    const { token } = await regRes.json();

    const meRes = await app.request('/auth/me', { headers: authHeader(token) });
    expect(meRes.status).toBe(200);
    const body = await meRes.json();
    expect(body.userId).toBeString();
    expect(body.email).toBe('sqme@example.com');
  });

  test('duplicate email registration returns 409', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'sqdup@example.com', password: 'password123' }),
    );
    const res = await app.request(
      '/auth/register',
      json({ email: 'sqdup@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(409);
  });

  test('set-password changes password', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'sqpw@example.com', password: 'password123' }),
    );
    const { token } = await regRes.json();

    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'newpassword456', currentPassword: 'password123' }),
    });
    expect(res.status).toBe(200);

    // Login with new password
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'sqpw@example.com', password: 'newpassword456' }),
    );
    expect(loginRes.status).toBe(200);
  });

  test('DELETE /auth/me with password deletes account', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'sqdel2@example.com', password: 'password123' }),
    );
    const { token } = await regRes.json();

    const delRes = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'password123' }),
    });
    expect(delRes.status).toBe(200);

    // Login should fail — user deleted
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'sqdel2@example.com', password: 'password123' }),
    );
    expect(loginRes.status).toBe(401);
  });

  test('DELETE /auth/me without password returns 400', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'sqdel3@example.com', password: 'password123' }),
    );
    const { token } = await regRes.json();

    const delRes = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(delRes.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// SQLite Cache (default store)
// ---------------------------------------------------------------------------

describe('SQLite cache (default store)', () => {
  test('first request returns cache MISS', async () => {
    const res = await app.request('/cached-default');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('MISS');
  });

  test('second request returns cache HIT', async () => {
    await app.request('/cached-default');
    const res = await app.request('/cached-default');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('HIT');
  });
});
