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

async function registerUser(email = 'session@example.com', password = 'password123') {
  const res = await app.request('/auth/register', json({ email, password }));
  return res.json() as Promise<{ token: string; userId: string }>;
}

async function loginUser(email = 'session@example.com', password = 'password123') {
  const res = await app.request('/auth/login', json({ email, password }));
  return res.json() as Promise<{ token: string; userId: string }>;
}

// ---------------------------------------------------------------------------
// GET /auth/sessions
// ---------------------------------------------------------------------------

describe('GET /auth/sessions', () => {
  test('lists the active session after registration', async () => {
    const { token } = await registerUser();

    const res = await app.request('/auth/sessions', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const { sessions } = await res.json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].isActive).toBe(true);
    expect(sessions[0].sessionId).toBeString();
  });

  test('lists multiple sessions from separate logins', async () => {
    const { token: token1 } = await registerUser();
    const { token: token2 } = await loginUser();

    const res = await app.request('/auth/sessions', { headers: authHeader(token1) });
    expect(res.status).toBe(200);
    const { sessions } = await res.json();
    expect(sessions).toHaveLength(2);

    // Both should be active
    expect(sessions.every((s: any) => s.isActive)).toBe(true);
  });

  test('returns 401 without authentication', async () => {
    const res = await app.request('/auth/sessions');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DELETE /auth/sessions/:sessionId
// ---------------------------------------------------------------------------

describe('DELETE /auth/sessions/:sessionId', () => {
  test('revokes a specific session', async () => {
    const { token: token1 } = await registerUser();
    const { token: token2 } = await loginUser();

    // List sessions to get IDs
    const listRes = await app.request('/auth/sessions', { headers: authHeader(token1) });
    const { sessions } = await listRes.json();
    expect(sessions).toHaveLength(2);

    // Revoke the second session
    const secondSession = sessions.find((s: any) => s.sessionId !== sessions[0].sessionId);
    const delRes = await app.request(`/auth/sessions/${secondSession.sessionId}`, {
      method: 'DELETE',
      headers: authHeader(token1),
    });
    expect(delRes.status).toBe(200);

    // Only one session should remain
    const listRes2 = await app.request('/auth/sessions', { headers: authHeader(token1) });
    const { sessions: remaining } = await listRes2.json();
    expect(remaining).toHaveLength(1);
  });

  test('returns 404 for non-existent session', async () => {
    const { token } = await registerUser();

    const res = await app.request('/auth/sessions/non-existent-id', {
      method: 'DELETE',
      headers: authHeader(token),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Session eviction (maxSessions)
// ---------------------------------------------------------------------------

describe('maxSessions eviction', () => {
  let evictionApp: OpenAPIHono<any>;

  beforeEach(async () => {
    evictionApp = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['admin', 'user'],
          defaultRole: 'user',
          sessionPolicy: { maxSessions: 2 },
        },
      },
    );
  });

  test('evicts oldest session when exceeding maxSessions', async () => {
    // Register creates session 1
    const regRes = await evictionApp.request(
      '/auth/register',
      json({ email: 'evict@example.com', password: 'password123' }),
    );
    const { token: token1 } = await regRes.json();

    // Login creates session 2
    await evictionApp.request(
      '/auth/login',
      json({ email: 'evict@example.com', password: 'password123' }),
    );

    // Login creates session 3 — should evict session 1
    await evictionApp.request(
      '/auth/login',
      json({ email: 'evict@example.com', password: 'password123' }),
    );

    // token1 (oldest session) should be evicted
    const meRes = await evictionApp.request('/auth/me', { headers: authHeader(token1) });
    expect(meRes.status).toBe(401);
  });
});
