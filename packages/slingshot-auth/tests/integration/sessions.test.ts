/**
 * Integration tests for session management routes.
 *
 * Covers:
 *   - GET    /auth/sessions           — list sessions for authenticated user
 *   - DELETE /auth/sessions/:sessionId — revoke a specific session
 *   - POST   /auth/reauth/challenge   — request a reauth challenge
 *
 * Each test creates a fresh runtime and app to avoid cross-test pollution.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createIdentifyMiddleware } from '../../src/middleware/identify';
import { createLoginRouter } from '../../src/routes/login';
import { createSessionsRouter } from '../../src/routes/sessions';
import { makeEventBus, makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';
import type { MutableTestRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(runtime: MutableTestRuntime) {
  const app = wrapWithRuntime(runtime);
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.use('*', createIdentifyMiddleware(runtime));
  app.route('/', createLoginRouter({ primaryField: 'email' }, runtime));
  app.route('/', createSessionsRouter({}, runtime));
  return app;
}

const jsonPost = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const EMAIL = 'user@example.com';
const PASSWORD = 'StrongPass1!';

async function registerAndLogin(
  runtime: MutableTestRuntime,
  app: ReturnType<typeof buildApp>,
  email = EMAIL,
  password = PASSWORD,
): Promise<{ token: string; userId: string }> {
  const hash = await Bun.password.hash(password);
  await runtime.adapter.create(email, hash);
  const res = await app.request('/auth/login', jsonPost({ email, password }));
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; userId: string };
}

function authedGet(path: string, token: string) {
  return { method: 'GET' as const, headers: { 'x-user-token': token } };
}

function authedDelete(path: string, token: string) {
  return { method: 'DELETE' as const, headers: { 'x-user-token': token } };
}

function authedPost(path: string, token: string, body: Record<string, unknown> = {}) {
  return {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json', 'x-user-token': token },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Tests — GET /auth/sessions
// ---------------------------------------------------------------------------

describe('GET /auth/sessions', () => {
  let runtime: MutableTestRuntime;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    runtime = makeTestRuntime();
    app = buildApp(runtime);
  });

  test('returns 401 without auth token', async () => {
    const res = await app.request('/auth/sessions');
    expect(res.status).toBe(401);
  });

  test('returns 200 with array of sessions after login', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request('/auth/sessions', authedGet('/auth/sessions', login.token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
  });

  test('session objects have expected shape', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request('/auth/sessions', authedGet('/auth/sessions', login.token));
    expect(res.status).toBe(200);
    const body = await res.json();
    const session = body.sessions[0];
    expect(session.sessionId).toBeString();
    expect(session.createdAt).toBeNumber();
    expect(session.lastActiveAt).toBeNumber();
    expect(session.expiresAt).toBeNumber();
    expect(typeof session.isActive).toBe('boolean');
  });

  test('multiple logins create multiple sessions', async () => {
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);

    // Login twice to create two sessions
    const res1 = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));
    expect(res1.status).toBe(200);
    const login1 = (await res1.json()) as { token: string; userId: string };

    const res2 = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));
    expect(res2.status).toBe(200);

    const sessionsRes = await app.request(
      '/auth/sessions',
      authedGet('/auth/sessions', login1.token),
    );
    expect(sessionsRes.status).toBe(200);
    const body = await sessionsRes.json();
    expect(body.sessions.length).toBeGreaterThanOrEqual(2);
  });

  test('sessions belong to the authenticated user only', async () => {
    // Create two users with separate sessions
    const login1 = await registerAndLogin(runtime, app, 'alice@example.com', 'AlicePass1!');

    const hash2 = await Bun.password.hash('BobPass1!');
    await runtime.adapter.create('bob@example.com', hash2);
    const res2 = await app.request(
      '/auth/login',
      jsonPost({ email: 'bob@example.com', password: 'BobPass1!' }),
    );
    expect(res2.status).toBe(200);
    const login2 = (await res2.json()) as { token: string; userId: string };

    // Alice's sessions should not include Bob's
    const aliceSessions = await app.request(
      '/auth/sessions',
      authedGet('/auth/sessions', login1.token),
    );
    const aliceBody = await aliceSessions.json();

    const bobSessions = await app.request(
      '/auth/sessions',
      authedGet('/auth/sessions', login2.token),
    );
    const bobBody = await bobSessions.json();

    // Each user sees only their own sessions
    const aliceIds = new Set(aliceBody.sessions.map((s: { sessionId: string }) => s.sessionId));
    const bobIds = new Set(bobBody.sessions.map((s: { sessionId: string }) => s.sessionId));

    // No overlap
    for (const id of aliceIds) {
      expect(bobIds.has(id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /auth/sessions/:sessionId
// ---------------------------------------------------------------------------

describe('DELETE /auth/sessions/:sessionId', () => {
  let runtime: MutableTestRuntime;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    runtime = makeTestRuntime();
    app = buildApp(runtime);
  });

  test('returns 401 without auth token', async () => {
    const res = await app.request('/auth/sessions/some-id', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  test('returns 200 when deleting own session', async () => {
    const login = await registerAndLogin(runtime, app);

    // Get session list to find a session ID
    const sessionsRes = await app.request(
      '/auth/sessions',
      authedGet('/auth/sessions', login.token),
    );
    const { sessions } = await sessionsRes.json();
    const targetId = sessions[0].sessionId;

    const res = await app.request(
      `/auth/sessions/${targetId}`,
      authedDelete(`/auth/sessions/${targetId}`, login.token),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('returns 404 for non-existent session ID', async () => {
    const login = await registerAndLogin(runtime, app);
    const fakeId = crypto.randomUUID();

    const res = await app.request(
      `/auth/sessions/${fakeId}`,
      authedDelete(`/auth/sessions/${fakeId}`, login.token),
    );
    expect(res.status).toBe(404);
  });

  test('returns 404 when trying to delete another user session (no cross-user access)', async () => {
    // Create two users
    const login1 = await registerAndLogin(runtime, app, 'alice@example.com', 'AlicePass1!');

    const hash2 = await Bun.password.hash('BobPass1!');
    await runtime.adapter.create('bob@example.com', hash2);
    const res2 = await app.request(
      '/auth/login',
      jsonPost({ email: 'bob@example.com', password: 'BobPass1!' }),
    );
    expect(res2.status).toBe(200);
    const login2 = (await res2.json()) as { token: string; userId: string };

    // Get Bob's session ID
    const bobSessions = await app.request(
      '/auth/sessions',
      authedGet('/auth/sessions', login2.token),
    );
    const bobBody = await bobSessions.json();
    const bobSessionId = bobBody.sessions[0].sessionId;

    // Alice tries to delete Bob's session — should fail with 404
    const res = await app.request(
      `/auth/sessions/${bobSessionId}`,
      authedDelete(`/auth/sessions/${bobSessionId}`, login1.token),
    );
    expect(res.status).toBe(404);
  });

  test('emits security.auth.session.revoked event on successful delete', async () => {
    const emitted: string[] = [];
    runtime.eventBus = makeEventBus(event => emitted.push(event));
    app = buildApp(runtime);

    const login = await registerAndLogin(runtime, app);
    const sessionsRes = await app.request(
      '/auth/sessions',
      authedGet('/auth/sessions', login.token),
    );
    const { sessions } = await sessionsRes.json();
    const targetId = sessions[0].sessionId;

    await app.request(
      `/auth/sessions/${targetId}`,
      authedDelete(`/auth/sessions/${targetId}`, login.token),
    );

    expect(emitted).toContain('security.auth.session.revoked');
  });

  test('deleted session no longer appears in GET /auth/sessions', async () => {
    // Create two sessions for the same user
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);

    const res1 = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));
    const login1 = (await res1.json()) as { token: string; userId: string };

    const res2 = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));
    expect(res2.status).toBe(200);

    // List sessions — should have at least 2
    const listRes1 = await app.request('/auth/sessions', authedGet('/auth/sessions', login1.token));
    const body1 = await listRes1.json();
    expect(body1.sessions.length).toBeGreaterThanOrEqual(2);

    // Delete one session
    const targetId = body1.sessions[1].sessionId;
    const delRes = await app.request(
      `/auth/sessions/${targetId}`,
      authedDelete(`/auth/sessions/${targetId}`, login1.token),
    );
    expect(delRes.status).toBe(200);

    // List again — the deleted session should be gone
    const listRes2 = await app.request('/auth/sessions', authedGet('/auth/sessions', login1.token));
    const body2 = await listRes2.json();
    const ids = body2.sessions.map((s: { sessionId: string }) => s.sessionId);
    expect(ids).not.toContain(targetId);
  });

  test('does not emit event when session is not found', async () => {
    const emitted: string[] = [];
    runtime.eventBus = makeEventBus(event => emitted.push(event));
    app = buildApp(runtime);

    const login = await registerAndLogin(runtime, app);
    const fakeId = crypto.randomUUID();

    await app.request(
      `/auth/sessions/${fakeId}`,
      authedDelete(`/auth/sessions/${fakeId}`, login.token),
    );

    expect(emitted).not.toContain('security.auth.session.revoked');
  });

  test('returns 403 for suspended accounts when route guard is responsible', async () => {
    runtime = makeTestRuntime({ checkSuspensionOnIdentify: false });
    app = buildApp(runtime);
    const login = await registerAndLogin(runtime, app);

    const sessionsRes = await app.request(
      '/auth/sessions',
      authedGet('/auth/sessions', login.token),
    );
    const { sessions } = await sessionsRes.json();
    const targetId = sessions[0].sessionId;

    await runtime.adapter.setSuspended?.(login.userId, true);

    const res = await app.request(
      `/auth/sessions/${targetId}`,
      authedDelete(`/auth/sessions/${targetId}`, login.token),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Account suspended');
  });

  test('returns 403 when email verification becomes required before session revocation', async () => {
    runtime = makeTestRuntime({
      emailVerification: { required: true, tokenExpiry: 3600 },
    });
    app = buildApp(runtime);

    const hash = await Bun.password.hash(PASSWORD);
    const user = await runtime.adapter.create(EMAIL, hash);
    await runtime.adapter.setEmailVerified?.(user.id, true);

    const loginRes = await app.request(
      '/auth/login',
      jsonPost({ email: EMAIL, password: PASSWORD }),
    );
    expect(loginRes.status).toBe(200);
    const login = (await loginRes.json()) as { token: string; userId: string };

    const sessionsRes = await app.request(
      '/auth/sessions',
      authedGet('/auth/sessions', login.token),
    );
    const { sessions } = await sessionsRes.json();
    const targetId = sessions[0].sessionId;

    await runtime.adapter.setEmailVerified?.(login.userId, false);

    const res = await app.request(
      `/auth/sessions/${targetId}`,
      authedDelete(`/auth/sessions/${targetId}`, login.token),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Email not verified');
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /auth/reauth/challenge
// ---------------------------------------------------------------------------

describe('POST /auth/reauth/challenge', () => {
  let runtime: MutableTestRuntime;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    runtime = makeTestRuntime();
    app = buildApp(runtime);
  });

  test('returns 401 without auth token', async () => {
    const res = await app.request('/auth/reauth/challenge', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  test('returns 200 with availableMethods for user without MFA', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request(
      '/auth/reauth/challenge',
      authedPost('/auth/reauth/challenge', login.token),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.availableMethods)).toBe(true);
    // User has a password, so 'password' should be available
    expect(body.availableMethods).toContain('password');
  });

  test('returns availableMethods without reauthToken when no challenge-based methods', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request(
      '/auth/reauth/challenge',
      authedPost('/auth/reauth/challenge', login.token),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // No emailOtp or webauthn configured, so no reauthToken
    expect(body.reauthToken).toBeUndefined();
  });

  test('returns 429 after exceeding rate limit', async () => {
    // Configure a very tight rate limit for testing
    runtime = makeTestRuntime();
    const tightApp = wrapWithRuntime(runtime);
    tightApp.onError((err, c) =>
      c.json(
        { error: err.message },
        (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
      ),
    );
    tightApp.use('*', createIdentifyMiddleware(runtime));
    tightApp.route('/', createLoginRouter({ primaryField: 'email' }, runtime));
    tightApp.route(
      '/',
      createSessionsRouter({ rateLimit: { mfaVerify: { max: 3, windowMs: 60_000 } } }, runtime),
    );

    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);
    const loginRes = await tightApp.request(
      '/auth/login',
      jsonPost({ email: EMAIL, password: PASSWORD }),
    );
    const { token } = (await loginRes.json()) as { token: string };

    // Exhaust the rate limit (3 attempts)
    for (let i = 0; i < 3; i++) {
      await tightApp.request('/auth/reauth/challenge', authedPost('/auth/reauth/challenge', token));
    }

    // 4th request should be rate-limited
    const res = await tightApp.request(
      '/auth/reauth/challenge',
      authedPost('/auth/reauth/challenge', token),
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/[Tt]oo many/);
  });

  test('response shape includes availableMethods array', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request(
      '/auth/reauth/challenge',
      authedPost('/auth/reauth/challenge', login.token),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('availableMethods');
    expect(Array.isArray(body.availableMethods)).toBe(true);
  });

  test('returns 403 for suspended accounts even when identify suspension checks are disabled', async () => {
    runtime = makeTestRuntime({ checkSuspensionOnIdentify: false });
    app = buildApp(runtime);
    const login = await registerAndLogin(runtime, app);

    await runtime.adapter.setSuspended?.(login.userId, true);

    const res = await app.request(
      '/auth/reauth/challenge',
      authedPost('/auth/reauth/challenge', login.token),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Account suspended');
  });

  test('returns 403 when email verification becomes required before reauth challenge issuance', async () => {
    runtime = makeTestRuntime({
      emailVerification: { required: true, tokenExpiry: 3600 },
    });
    app = buildApp(runtime);

    const hash = await Bun.password.hash(PASSWORD);
    const user = await runtime.adapter.create(EMAIL, hash);
    await runtime.adapter.setEmailVerified?.(user.id, true);

    const loginRes = await app.request(
      '/auth/login',
      jsonPost({ email: EMAIL, password: PASSWORD }),
    );
    expect(loginRes.status).toBe(200);
    const login = (await loginRes.json()) as { token: string; userId: string };

    await runtime.adapter.setEmailVerified?.(login.userId, false);

    const res = await app.request(
      '/auth/reauth/challenge',
      authedPost('/auth/reauth/challenge', login.token),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Email not verified');
  });
});
