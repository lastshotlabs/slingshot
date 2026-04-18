import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { authHeader, createTestApp } from '../setup';

let app: OpenAPIHono<any>;

beforeEach(async () => {
  app = await createTestApp();
});

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

describe('POST /auth/register', () => {
  test('creates a new user and returns token', async () => {
    const res = await app.request(
      '/auth/register',
      json({ email: 'test@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.userId).toBeString();
    expect(body.email).toBe('test@example.com');
  });

  test('rejects duplicate email', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'dupe@example.com', password: 'password123' }),
    );
    const res = await app.request(
      '/auth/register',
      json({ email: 'dupe@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(409);
  });

  test('rejects missing password', async () => {
    const res = await app.request('/auth/register', json({ email: 'no-pw@example.com' }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await app.request(
      '/auth/register',
      json({ email: 'login@example.com', password: 'password123' }),
    );
  });

  test('returns token for valid credentials', async () => {
    const res = await app.request(
      '/auth/login',
      json({ email: 'login@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.userId).toBeString();
  });

  test('rejects invalid password', async () => {
    const res = await app.request(
      '/auth/login',
      json({ email: 'login@example.com', password: 'wrongpassword' }),
    );
    expect(res.status).toBe(401);
  });

  test('rejects non-existent user', async () => {
    const res = await app.request(
      '/auth/login',
      json({ email: 'nobody@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------

describe('GET /auth/me', () => {
  test('returns user info with valid token', async () => {
    const reg = await app.request(
      '/auth/register',
      json({ email: 'me@example.com', password: 'password123' }),
    );
    const { token, userId } = await reg.json();

    const res = await app.request('/auth/me', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(userId);
    expect(body.email).toBe('me@example.com');
  });

  test('returns 401 without a token', async () => {
    const res = await app.request('/auth/me');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

describe('POST /auth/logout', () => {
  test('invalidates the session', async () => {
    const reg = await app.request(
      '/auth/register',
      json({ email: 'logout@example.com', password: 'password123' }),
    );
    const { token } = await reg.json();

    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(logoutRes.status).toBe(200);

    // Token should no longer work
    const meRes = await app.request('/auth/me', { headers: authHeader(token) });
    expect(meRes.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------

describe('DELETE /auth/me', () => {
  test('deletes the account with password confirmation', async () => {
    const reg = await app.request(
      '/auth/register',
      json({ email: 'delete@example.com', password: 'password123' }),
    );
    const { token } = await reg.json();

    const delRes = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'password123' }),
    });
    expect(delRes.status).toBe(200);
    const body = await delRes.json();
    expect(body.ok).toBe(true);

    // Token should no longer work
    const meRes = await app.request('/auth/me', { headers: authHeader(token) });
    expect(meRes.status).toBe(401);

    // Re-login should fail
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'delete@example.com', password: 'password123' }),
    );
    expect(loginRes.status).toBe(401);
  });

  test('rejects deletion without password for credential accounts', async () => {
    const reg = await app.request(
      '/auth/register',
      json({ email: 'nodelete@example.com', password: 'password123' }),
    );
    const { token } = await reg.json();

    const delRes = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(delRes.status).toBe(400);
  });

  test('rejects deletion with wrong password', async () => {
    const reg = await app.request(
      '/auth/register',
      json({ email: 'wrongpw@example.com', password: 'password123' }),
    );
    const { token } = await reg.json();

    const delRes = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'wrongpassword' }),
    });
    expect(delRes.status).toBe(401);
  });
});
