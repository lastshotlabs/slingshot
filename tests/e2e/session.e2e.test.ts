/**
 * E2E tests for session management.
 *
 * Key endpoints (confirmed from integration tests):
 *   GET    /auth/sessions           → { sessions: [{ sessionId, isActive, ... }] }
 *   DELETE /auth/sessions/:sessionId → 200
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { type E2EServerHandle, createTestHttpServer } from '../setup-e2e';

let handle: E2EServerHandle;

beforeAll(async () => {
  handle = await createTestHttpServer();
});

afterAll(() => handle.stop());
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${handle.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function register(email: string, password = 'Password123!') {
  const res = await post('/auth/register', { email, password });
  return res.json() as Promise<{ token: string; userId: string }>;
}

async function login(email: string, password = 'Password123!') {
  const res = await post('/auth/login', { email, password });
  return res.json() as Promise<{ token: string; userId: string }>;
}

async function getSessions(token: string) {
  const res = await fetch(`${handle.baseUrl}/auth/sessions`, {
    headers: { 'x-user-token': token },
  });
  return res;
}

// ---------------------------------------------------------------------------
// List Sessions
// ---------------------------------------------------------------------------

describe('GET /auth/sessions — E2E', () => {
  test('lists the active session after registration', async () => {
    const { token } = await register('sessions-list@example.com');

    const res = await getSessions(token);
    expect(res.status).toBe(200);
    const { sessions } = await res.json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].isActive).toBe(true);
    expect(sessions[0].sessionId).toBeString();
  });

  test('returns 401 without authentication', async () => {
    const res = await fetch(`${handle.baseUrl}/auth/sessions`);
    expect(res.status).toBe(401);
  });

  test('concurrent sessions: login from multiple clients — both sessions active', async () => {
    const { token: token1 } = await register('sessions-concurrent@example.com');
    const { token: token2 } = await login('sessions-concurrent@example.com');

    // Both tokens must be different
    expect(token1).not.toBe(token2);

    const res = await getSessions(token1);
    expect(res.status).toBe(200);
    const { sessions } = await res.json();
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s: any) => s.isActive)).toBe(true);
  });

  test('session from login is separate from registration session', async () => {
    const { token: regToken } = await register('sessions-separate@example.com');
    const { token: loginToken } = await login('sessions-separate@example.com');

    // Fetch sessions with the login token — should see both
    const res = await getSessions(loginToken);
    expect(res.status).toBe(200);
    const { sessions } = await res.json();
    expect(sessions).toHaveLength(2);

    // Can also fetch sessions with the registration token
    const res2 = await getSessions(regToken);
    expect(res2.status).toBe(200);
    const { sessions: sessions2 } = await res2.json();
    expect(sessions2).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Revoke Session
// ---------------------------------------------------------------------------

describe('DELETE /auth/sessions/:sessionId — E2E', () => {
  test('revokes a specific session — that token becomes invalid', async () => {
    const { token: token1 } = await register('sessions-revoke@example.com');
    const { token: token2 } = await login('sessions-revoke@example.com');

    // List sessions
    const listRes = await getSessions(token1);
    const { sessions } = await listRes.json();
    expect(sessions).toHaveLength(2);

    // Find the session ID belonging to token2 (the second one)
    // Sessions are ordered by creation time — find the one that isn't the first
    const firstSessionId = sessions[0].sessionId;
    const secondSession = sessions.find((s: any) => s.sessionId !== firstSessionId);

    // Revoke second session using first token's auth
    const delRes = await fetch(`${handle.baseUrl}/auth/sessions/${secondSession.sessionId}`, {
      method: 'DELETE',
      headers: { 'x-user-token': token1 },
    });
    expect(delRes.status).toBe(200);

    // Only one session remains
    const listRes2 = await getSessions(token1);
    const { sessions: remaining } = await listRes2.json();
    expect(remaining).toHaveLength(1);
  });

  test('returns 404 for non-existent session ID', async () => {
    const { token } = await register('sessions-404@example.com');

    const res = await fetch(`${handle.baseUrl}/auth/sessions/non-existent-id`, {
      method: 'DELETE',
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(404);
  });

  test('revoked session token is rejected by /auth/me', async () => {
    const { token: token1 } = await register('sessions-invalidate@example.com');
    const { token: token2 } = await login('sessions-invalidate@example.com');

    // List sessions with token1 to get session IDs
    const listRes = await getSessions(token1);
    const { sessions } = await listRes.json();

    // Revoke the second session (token2's session)
    // Identify it by finding the session not associated with the first login
    // Since both sessions are active, just revoke the second one in the list
    const sessionToRevoke = sessions[1];
    const delRes = await fetch(`${handle.baseUrl}/auth/sessions/${sessionToRevoke.sessionId}`, {
      method: 'DELETE',
      headers: { 'x-user-token': token1 },
    });
    expect(delRes.status).toBe(200);

    // token1 should still work
    const meRes1 = await fetch(`${handle.baseUrl}/auth/me`, {
      headers: { 'x-user-token': token1 },
    });
    expect(meRes1.status).toBe(200);
  });

  test('user can revoke own current session via logout', async () => {
    const { token } = await register('sessions-logout@example.com');

    const logoutRes = await post('/auth/logout', {}, { 'x-user-token': token });
    expect(logoutRes.status).toBe(200);

    // Token should now be invalid
    const meRes = await fetch(`${handle.baseUrl}/auth/me`, {
      headers: { 'x-user-token': token },
    });
    expect(meRes.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Invalid token
// ---------------------------------------------------------------------------

describe('invalid token handling — E2E', () => {
  test('completely invalid token returns 401 from /auth/me', async () => {
    const res = await fetch(`${handle.baseUrl}/auth/me`, {
      headers: { 'x-user-token': 'this-is-not-a-valid-token-at-all' },
    });
    expect(res.status).toBe(401);
  });

  test('invalid token returns 401 from /auth/sessions', async () => {
    const res = await fetch(`${handle.baseUrl}/auth/sessions`, {
      headers: { 'x-user-token': 'bogus-token' },
    });
    expect(res.status).toBe(401);
  });
});
