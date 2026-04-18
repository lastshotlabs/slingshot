/**
 * Integration tests for the account management routes.
 *
 * Covers:
 * - GET  /auth/me          — user profile retrieval
 * - PATCH /auth/me         — profile updates (displayName, userMetadata)
 * - POST /auth/set-password — set/change password
 * - POST /auth/logout       — session invalidation + cookie clearing
 * - DELETE /auth/me         — account deletion
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { setSuspended } from '../../src/lib/suspension';
import { createIdentifyMiddleware } from '../../src/middleware/identify';
import { createAccountRouter } from '../../src/routes/account';
import { createLoginRouter } from '../../src/routes/login';
import { makeEventBus, makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';
import type { MutableTestRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(runtime: MutableTestRuntime) {
  const app = wrapWithRuntime(runtime);
  app.use('*', createIdentifyMiddleware(runtime));
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.route(
    '/',
    createAccountRouter(
      {
        primaryField: runtime.config.primaryField,
        refreshTokens: runtime.config.refreshToken ?? undefined,
        sessionPolicy: runtime.config.sessionPolicy,
      },
      runtime,
    ),
  );
  app.route('/', createLoginRouter({ primaryField: runtime.config.primaryField }, runtime));
  return app;
}

const jsonPost = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const jsonPatch = (body: Record<string, unknown>, token: string) => ({
  method: 'PATCH' as const,
  headers: { 'Content-Type': 'application/json', 'x-user-token': token },
  body: JSON.stringify(body),
});

const jsonDelete = (body: Record<string, unknown>, token: string) => ({
  method: 'DELETE' as const,
  headers: { 'Content-Type': 'application/json', 'x-user-token': token },
  body: JSON.stringify(body),
});

const EMAIL = 'user@example.com';
const PASSWORD = 'StrongPass1!';

/**
 * Register a user, log in, and return the session token + userId.
 */
async function seedAndLogin(
  app: ReturnType<typeof buildApp>,
  runtime: MutableTestRuntime,
  email = EMAIL,
  password = PASSWORD,
): Promise<{ token: string; userId: string }> {
  const hash = await Bun.password.hash(password);
  await runtime.adapter.create(email, hash);
  const res = await app.request('/auth/login', jsonPost({ email, password }));
  const body = await res.json();
  return { token: body.token, userId: body.userId };
}

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------

describe('GET /auth/me', () => {
  let runtime: MutableTestRuntime;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    runtime = makeTestRuntime();
    app = buildApp(runtime);
  });

  test('returns 200 with user profile for valid session', async () => {
    const { token, userId } = await seedAndLogin(app, runtime);

    const res = await app.request('/auth/me', {
      headers: { 'x-user-token': token },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(userId);
    expect(body.email).toBe(EMAIL);
    expect(body.emailVerified).toBe(false);
    expect(body.userMetadata).toEqual({});
  });

  test('returns 401 without token', async () => {
    const res = await app.request('/auth/me');

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeString();
  });

  test('returns 401 with invalid token', async () => {
    const res = await app.request('/auth/me', {
      headers: { 'x-user-token': 'invalid.jwt.token' },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeString();
  });

  test('returns 401 with expired/revoked session token', async () => {
    const { token, userId } = await seedAndLogin(app, runtime);

    // Revoke all sessions for the user
    const sessions = await runtime.repos.session.getUserSessions(userId, runtime.config);
    await Promise.all(
      sessions.map(s => runtime.repos.session.deleteSession(s.sessionId, runtime.config)),
    );

    const res = await app.request('/auth/me', {
      headers: { 'x-user-token': token },
    });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PATCH /auth/me
// ---------------------------------------------------------------------------

describe('PATCH /auth/me', () => {
  let runtime: MutableTestRuntime;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    runtime = makeTestRuntime();
    app = buildApp(runtime);
  });

  test('updates displayName and returns 200', async () => {
    const { token } = await seedAndLogin(app, runtime);

    const res = await app.request('/auth/me', jsonPatch({ displayName: 'New Name' }, token));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('updates userMetadata and returns 200', async () => {
    const { token } = await seedAndLogin(app, runtime);

    const res = await app.request(
      '/auth/me',
      jsonPatch({ userMetadata: { theme: 'dark', lang: 'en' } }, token),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify metadata was persisted by reading the profile
    const meRes = await app.request('/auth/me', {
      headers: { 'x-user-token': token },
    });
    const meBody = await meRes.json();
    expect(meBody.userMetadata).toEqual({ theme: 'dark', lang: 'en' });
  });

  test('returns 401 without auth', async () => {
    const res = await app.request('/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Nope' }),
    });

    expect(res.status).toBe(401);
  });

  test('empty body returns 200 (no-op)', async () => {
    const { token } = await seedAndLogin(app, runtime);

    const res = await app.request('/auth/me', jsonPatch({}, token));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('returns 403 for suspended accounts when route guard is responsible', async () => {
    runtime = makeTestRuntime({ checkSuspensionOnIdentify: false });
    app = buildApp(runtime);

    const { token, userId } = await seedAndLogin(app, runtime);
    await setSuspended(runtime.adapter, userId, true, 'security hold');

    const res = await app.request('/auth/me', jsonPatch({ displayName: 'Blocked Name' }, token));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('suspended');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/set-password
// ---------------------------------------------------------------------------

describe('POST /auth/set-password', () => {
  let runtime: MutableTestRuntime;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    runtime = makeTestRuntime();
    app = buildApp(runtime);
  });

  test('sets password for first time (OAuth-only user)', async () => {
    // Create user without a password (pass null hash)
    const { id: userId } = await runtime.adapter.create(EMAIL, '');
    // Log in using a direct session since there is no password to log in with
    // We need to create a session manually and get a token
    const { createSessionForUser } = await import('../../src/services/auth');
    const session = await createSessionForUser(userId, runtime, {});
    const token = session.token;

    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token },
      body: JSON.stringify({ password: 'NewSecure123!' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('changes password with correct currentPassword', async () => {
    const { token } = await seedAndLogin(app, runtime);

    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token },
      body: JSON.stringify({ password: 'NewSecure456!', currentPassword: PASSWORD }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify new password works by logging in again
    const loginRes = await app.request(
      '/auth/login',
      jsonPost({ email: EMAIL, password: 'NewSecure456!' }),
    );
    expect(loginRes.status).toBe(200);
  });

  test('returns 401 when currentPassword is wrong', async () => {
    const { token } = await seedAndLogin(app, runtime);

    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token },
      body: JSON.stringify({ password: 'NewSecure456!', currentPassword: 'WrongOldPass1!' }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('incorrect');
  });

  test('returns 400 when currentPassword missing but user has password', async () => {
    const { token } = await seedAndLogin(app, runtime);

    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token },
      body: JSON.stringify({ password: 'NewSecure456!' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Current password is required');
  });

  test('returns 400 when new password is weak (too short)', async () => {
    const { token } = await seedAndLogin(app, runtime);

    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token },
      body: JSON.stringify({ password: 'short', currentPassword: PASSWORD }),
    });

    expect([400, 422]).toContain(res.status);
  });

  test('returns 401 without auth', async () => {
    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'NewSecure456!' }),
    });

    expect(res.status).toBe(401);
  });

  test('rate limits after 5 attempts', async () => {
    const { token } = await seedAndLogin(app, runtime);

    // Exhaust rate limit (5 attempts with wrong current password)
    for (let i = 0; i < 5; i++) {
      await app.request('/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-token': token },
        body: JSON.stringify({ password: `NewPass${i}123!`, currentPassword: PASSWORD }),
      });
    }

    // 6th attempt should be rate limited
    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token },
      body: JSON.stringify({ password: 'AnotherPass123!', currentPassword: PASSWORD }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Too many');
  });

  test('password change emits security.auth.password.change event', async () => {
    const emitted: string[] = [];
    runtime.eventBus = makeEventBus(event => emitted.push(event));
    app = buildApp(runtime);

    const { token } = await seedAndLogin(app, runtime);

    await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token },
      body: JSON.stringify({ password: 'NewSecure456!', currentPassword: PASSWORD }),
    });

    expect(emitted).toContain('security.auth.password.change');
  });

  test('revoke_all_and_reissue blocks fresh session issuance for suspended accounts', async () => {
    runtime = makeTestRuntime({
      checkSuspensionOnIdentify: false,
      sessionPolicy: { onPasswordChange: 'revoke_all_and_reissue' },
    });
    app = buildApp(runtime);

    const { token, userId } = await seedAndLogin(app, runtime);
    await setSuspended(runtime.adapter, userId, true, 'security hold');

    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token },
      body: JSON.stringify({ password: 'NewSecure456!', currentPassword: PASSWORD }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('suspended');
  });

  test('revoke_all_and_reissue blocks fresh session issuance for newly-unverified accounts', async () => {
    runtime = makeTestRuntime({
      primaryField: 'email',
      emailVerification: { required: true, tokenExpiry: 86400 },
      sessionPolicy: { onPasswordChange: 'revoke_all_and_reissue' },
    });
    app = buildApp(runtime);

    const hash = await Bun.password.hash(PASSWORD);
    const { id: userId } = await runtime.adapter.create(EMAIL, hash);
    await runtime.adapter.setEmailVerified?.(userId, true);
    const { createSessionForUser } = await import('../../src/services/auth');
    const session = await createSessionForUser(userId, runtime, {});
    await runtime.adapter.setEmailVerified?.(userId, false);

    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': session.token },
      body: JSON.stringify({ password: 'NewSecure456!', currentPassword: PASSWORD }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Email not verified');
  });

  test('returns 403 when email verification becomes required before password change', async () => {
    runtime = makeTestRuntime({
      primaryField: 'email',
      emailVerification: { required: true, tokenExpiry: 86_400 },
    });
    app = buildApp(runtime);

    const hash = await Bun.password.hash(PASSWORD);
    const { id: userId } = await runtime.adapter.create(EMAIL, hash);
    await runtime.adapter.setEmailVerified?.(userId, true);
    const { createSessionForUser } = await import('../../src/services/auth');
    const session = await createSessionForUser(userId, runtime, {});
    await runtime.adapter.setEmailVerified?.(userId, false);

    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': session.token },
      body: JSON.stringify({ password: 'NewSecure456!', currentPassword: PASSWORD }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Email not verified');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

describe('POST /auth/logout', () => {
  let runtime: MutableTestRuntime;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    runtime = makeTestRuntime();
    app = buildApp(runtime);
  });

  test('returns 200 with valid token', async () => {
    const { token } = await seedAndLogin(app, runtime);

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { 'x-user-token': token },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('returns 200 even without valid token (graceful)', async () => {
    const res = await app.request('/auth/logout', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('clears cookies in response (Set-Cookie headers)', async () => {
    const { token } = await seedAndLogin(app, runtime);

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { 'x-user-token': token },
    });

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeString();
    // Should contain token cookie deletion (Max-Age=0 or Expires in the past)
    expect(setCookie!).toContain('token=');
  });

  test('session invalidated after logout (subsequent /auth/me returns 401)', async () => {
    const { token } = await seedAndLogin(app, runtime);

    // Logout
    await app.request('/auth/logout', {
      method: 'POST',
      headers: { 'x-user-token': token },
    });

    // Attempt to access protected route with the same token
    const meRes = await app.request('/auth/me', {
      headers: { 'x-user-token': token },
    });

    expect(meRes.status).toBe(401);
  });

  test('logout accepts a hardened production cookie and clears hardened names', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      runtime = makeTestRuntime();
      app = buildApp(runtime);
      const { token } = await seedAndLogin(app, runtime);

      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: { Cookie: `__Host-token=${token}` },
      });

      expect(res.status).toBe(200);
      const setCookieHeaders = res.headers.getSetCookie();
      expect(setCookieHeaders.some(header => header.includes('__Host-token='))).toBe(true);
      expect(setCookieHeaders.some(header => header.includes('__Host-refresh_token='))).toBe(true);

      const meRes = await app.request('/auth/me', {
        headers: { Cookie: `__Host-token=${token}` },
      });
      expect(meRes.status).toBe(401);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /auth/me
// ---------------------------------------------------------------------------

describe('DELETE /auth/me', () => {
  let runtime: MutableTestRuntime;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    runtime = makeTestRuntime();
    app = buildApp(runtime);
  });

  test('deletes account with password verification', async () => {
    const { token } = await seedAndLogin(app, runtime);

    const res = await app.request(
      '/auth/me',
      jsonDelete({ method: 'password', password: PASSWORD }, token),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('returns 401 without auth', async () => {
    const res = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: PASSWORD }),
    });

    expect(res.status).toBe(401);
  });

  test('emits security.auth.account.deleted event', async () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    runtime.eventBus = {
      ...makeEventBus(),
      emit: ((event: string, payload: unknown) => {
        emitted.push({ event, payload });
      }) as ReturnType<typeof makeEventBus>['emit'],
    } as ReturnType<typeof makeEventBus>;
    app = buildApp(runtime);

    const { token, userId } = await seedAndLogin(app, runtime);

    await app.request('/auth/me', jsonDelete({ method: 'password', password: PASSWORD }, token));

    const deleteEvent = emitted.find(e => e.event === 'security.auth.account.deleted');
    expect(deleteEvent).toBeDefined();
    expect((deleteEvent!.payload as { userId: string }).userId).toBe(userId);
  });

  test('session revoked after deletion (subsequent /auth/me returns 401)', async () => {
    const { token } = await seedAndLogin(app, runtime);

    await app.request('/auth/me', jsonDelete({ method: 'password', password: PASSWORD }, token));

    const meRes = await app.request('/auth/me', {
      headers: { 'x-user-token': token },
    });

    expect(meRes.status).toBe(401);
  });

  test('rate limits after 3 attempts', async () => {
    const { token } = await seedAndLogin(app, runtime);

    // Exhaust rate limit (3 attempts with wrong password)
    for (let i = 0; i < 3; i++) {
      await app.request(
        '/auth/me',
        jsonDelete({ method: 'password', password: 'WrongPass!' }, token),
      );
    }

    // 4th attempt should be rate limited
    const res = await app.request(
      '/auth/me',
      jsonDelete({ method: 'password', password: PASSWORD }, token),
    );

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Too many');
  });

  test('returns 400 when verification required but not provided', async () => {
    const { token } = await seedAndLogin(app, runtime);

    // User has a password, so verification is required
    const res = await app.request('/auth/me', jsonDelete({}, token));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Verification is required');
  });

  test('returns 401 when password verification fails', async () => {
    const { token } = await seedAndLogin(app, runtime);

    const res = await app.request(
      '/auth/me',
      jsonDelete({ method: 'password', password: 'WrongPassword1!' }, token),
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Invalid verification');
  });

  test('allows deletion without verification for OAuth-only user (no password)', async () => {
    // Create user without a password
    const { id: userId } = await runtime.adapter.create(EMAIL, '');
    const { createSessionForUser } = await import('../../src/services/auth');
    const session = await createSessionForUser(userId, runtime, {});
    const token = session.token;

    const res = await app.request('/auth/me', jsonDelete({}, token));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('returns 403 when email verification becomes required before deletion', async () => {
    runtime = makeTestRuntime({
      primaryField: 'email',
      emailVerification: { required: true, tokenExpiry: 86_400 },
    });
    app = buildApp(runtime);

    const hash = await Bun.password.hash(PASSWORD);
    const { id: userId } = await runtime.adapter.create(EMAIL, hash);
    await runtime.adapter.setEmailVerified?.(userId, true);
    const { createSessionForUser } = await import('../../src/services/auth');
    const session = await createSessionForUser(userId, runtime, {});
    await runtime.adapter.setEmailVerified?.(userId, false);

    const res = await app.request(
      '/auth/me',
      jsonDelete({ method: 'password', password: PASSWORD }, session.token),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Email not verified');
  });
});
