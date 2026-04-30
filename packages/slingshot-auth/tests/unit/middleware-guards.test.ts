import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HttpError, getActor } from '@lastshotlabs/slingshot-core';
import { requireMfaSetup } from '../../src/middleware/requireMfaSetup';
import { requireStepUp } from '../../src/middleware/requireStepUp';
import { requireVerifiedEmail } from '../../src/middleware/requireVerifiedEmail';
import { userAuth } from '../../src/middleware/userAuth';
import { makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';
import type { MutableTestRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildApp(runtime: MutableTestRuntime) {
  const app = wrapWithRuntime(runtime);
  app.onError((err, c) =>
    c.json(
      { error: err.message, ...(err instanceof HttpError && err.code ? { code: err.code } : {}) },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  return app;
}

/**
 * Middleware to simulate an authenticated user by injecting `actor` into the
 * Hono context (normally done by the `identify` middleware).
 */
function simulateAuth(userId: string | null, sessionId: string | null = 'test-session') {
  return async (c: { set(key: string, value: unknown): void }, next: () => Promise<void>) => {
    if (userId) {
      c.set(
        'actor',
        Object.freeze({
          id: userId,
          kind: 'user' as const,
          tenantId: null,
          sessionId,
          roles: null,
          claims: {},
        }),
      );
    } else {
      c.set(
        'actor',
        Object.freeze({
          id: null,
          kind: 'anonymous' as const,
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      );
    }
    await next();
  };
}

function simulateActor(actor: {
  id: string | null;
  kind: 'anonymous' | 'user' | 'service-account' | 'api-key' | 'system';
  sessionId?: string | null;
}) {
  return async (c: { set(key: string, value: unknown): void }, next: () => Promise<void>) => {
    c.set(
      'actor',
      Object.freeze({
        id: actor.id,
        kind: actor.kind,
        tenantId: null,
        sessionId: actor.sessionId ?? null,
        roles: null,
        claims: {},
      }),
    );
    await next();
  };
}

// ---------------------------------------------------------------------------
// 1. userAuth
// ---------------------------------------------------------------------------

describe('userAuth', () => {
  let runtime: MutableTestRuntime;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    runtime = makeTestRuntime();
    app = buildApp(runtime);
  });

  test('authenticated user passes through with 200', async () => {
    app.use('/protected', simulateAuth('user-123'), userAuth);
    app.get('/protected', c => c.json({ ok: true }));

    const res = await app.request('/protected');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('unauthenticated user (anonymous actor) receives 401', async () => {
    app.use('/protected', simulateAuth(null), userAuth);
    app.get('/protected', c => c.json({ ok: true }));

    const res = await app.request('/protected');
    expect(res.status).toBe(401);
  });

  test('service-account actor receives 401', async () => {
    app.use('/protected', simulateActor({ id: 'svc-123', kind: 'service-account' }), userAuth);
    app.get('/protected', c => c.json({ ok: true }));

    const res = await app.request('/protected');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('api-key actor receives 401', async () => {
    app.use('/protected', simulateActor({ id: 'api-123', kind: 'api-key' }), userAuth);
    app.get('/protected', c => c.json({ ok: true }));

    const res = await app.request('/protected');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('empty string actor id is treated as unauthenticated (401)', async () => {
    app.use('/protected', simulateAuth(''), userAuth);
    app.get('/protected', c => c.json({ ok: true }));

    const res = await app.request('/protected');
    // Empty string is falsy, so userAuth should reject
    expect(res.status).toBe(401);
  });

  test('middleware calls next() on success and handler executes', async () => {
    let handlerCalled = false;
    app.use('/protected', simulateAuth('user-123'), userAuth);
    app.get('/protected', c => {
      handlerCalled = true;
      return c.json({ ok: true });
    });

    await app.request('/protected');
    expect(handlerCalled).toBe(true);
  });

  test('response body is { error: "Unauthorized" } on failure', async () => {
    app.use('/protected', simulateAuth(null), userAuth);
    app.get('/protected', c => c.json({ ok: true }));

    const res = await app.request('/protected');
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('works with different user IDs', async () => {
    app.use('/protected', simulateAuth('abc-different-user'), userAuth);
    app.get('/protected', c => c.json({ userId: getActor(c).id }));

    const res = await app.request('/protected');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'abc-different-user' });
  });
});

// ---------------------------------------------------------------------------
// 2. requireVerifiedEmail
// ---------------------------------------------------------------------------

describe('requireVerifiedEmail', () => {
  let runtime: MutableTestRuntime;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    runtime = makeTestRuntime();
    app = buildApp(runtime);
  });

  test('authenticated user with verified email passes through with 200', async () => {
    const user = await runtime.adapter.create('verified@example.com', 'hashed-pw');
    await runtime.adapter.setEmailVerified!(user.id, true);

    app.use('/protected', simulateAuth(user.id), requireVerifiedEmail);
    app.get('/protected', c => c.json({ ok: true }));

    const res = await app.request('/protected');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('authenticated user with unverified email receives 403', async () => {
    const user = await runtime.adapter.create('unverified@example.com', 'hashed-pw');
    // Email is not verified by default

    app.use('/protected', simulateAuth(user.id), requireVerifiedEmail);
    app.get('/protected', c => c.json({ ok: true }));

    const res = await app.request('/protected');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Email not verified' });
  });

  test('unauthenticated user receives 401', async () => {
    app.use('/protected', simulateAuth(null), requireVerifiedEmail);
    app.get('/protected', c => c.json({ ok: true }));

    const res = await app.request('/protected');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('setEmailVerified toggles the verification state', async () => {
    const user = await runtime.adapter.create('toggle@example.com', 'hashed-pw');

    app.use('/protected', simulateAuth(user.id), requireVerifiedEmail);
    app.get('/protected', c => c.json({ ok: true }));

    // Not verified initially
    const res1 = await app.request('/protected');
    expect(res1.status).toBe(403);

    // Verify
    await runtime.adapter.setEmailVerified!(user.id, true);
    const res2 = await app.request('/protected');
    expect(res2.status).toBe(200);

    // Unverify
    await runtime.adapter.setEmailVerified!(user.id, false);
    const res3 = await app.request('/protected');
    expect(res3.status).toBe(403);
  });

  test('middleware checks adapter on each request, not a cached value', async () => {
    const user = await runtime.adapter.create('fresh@example.com', 'hashed-pw');

    app.use('/protected', simulateAuth(user.id), requireVerifiedEmail);
    app.get('/protected', c => c.json({ ok: true }));

    // First request: unverified
    const res1 = await app.request('/protected');
    expect(res1.status).toBe(403);

    // Verify between requests
    await runtime.adapter.setEmailVerified!(user.id, true);

    // Second request: verified (proves no caching)
    const res2 = await app.request('/protected');
    expect(res2.status).toBe(200);
  });

  test('throws 500 when adapter lacks getEmailVerified', async () => {
    const user = await runtime.adapter.create('noadapter@example.com', 'hashed-pw');

    // Remove the method to simulate an adapter that does not support it
    const original = runtime.adapter.getEmailVerified;
    runtime.adapter.getEmailVerified = undefined as unknown as typeof original;

    app.use('/protected', simulateAuth(user.id), requireVerifiedEmail);
    app.get('/protected', c => c.json({ ok: true }));

    const res = await app.request('/protected');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });

    // Restore
    runtime.adapter.getEmailVerified = original;
  });
});

// ---------------------------------------------------------------------------
// 3. requireMfaSetup
// ---------------------------------------------------------------------------

describe('requireMfaSetup', () => {
  let runtime: MutableTestRuntime;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    runtime = makeTestRuntime();
    app = buildApp(runtime);
  });

  test('authenticated user with MFA enabled passes through', async () => {
    const user = await runtime.adapter.create('mfa-ok@example.com', 'hashed-pw');
    await runtime.adapter.setMfaEnabled!(user.id, true);

    app.use('/dashboard', simulateAuth(user.id), requireMfaSetup);
    app.get('/dashboard', c => c.json({ ok: true }));

    const res = await app.request('/dashboard');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('authenticated user without MFA enabled receives 403 with MFA_SETUP_REQUIRED code', async () => {
    const user = await runtime.adapter.create('no-mfa@example.com', 'hashed-pw');

    app.use('/dashboard', simulateAuth(user.id), requireMfaSetup);
    app.get('/dashboard', c => c.json({ ok: true }));

    const res = await app.request('/dashboard');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('MFA setup required');
    expect(body.code).toBe('MFA_SETUP_REQUIRED');
  });

  test('unauthenticated user passes through (no MFA check needed)', async () => {
    app.use('/dashboard', simulateAuth(null), requireMfaSetup);
    app.get('/dashboard', c => c.json({ ok: true }));

    const res = await app.request('/dashboard');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('auth paths are exempt (/auth/*)', async () => {
    const user = await runtime.adapter.create('auth-exempt@example.com', 'hashed-pw');
    // MFA is NOT enabled

    app.use('/auth/*', simulateAuth(user.id), requireMfaSetup);
    app.get('/auth/mfa/setup', c => c.json({ ok: true }));

    const res = await app.request('/auth/mfa/setup');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('health endpoint is exempt', async () => {
    const user = await runtime.adapter.create('health-exempt@example.com', 'hashed-pw');
    // MFA is NOT enabled

    app.use('/health', simulateAuth(user.id), requireMfaSetup);
    app.get('/health', c => c.json({ ok: true }));

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('passes through when adapter lacks isMfaEnabled method', async () => {
    const user = await runtime.adapter.create('no-method@example.com', 'hashed-pw');

    const original = runtime.adapter.isMfaEnabled;
    runtime.adapter.isMfaEnabled = undefined as unknown as typeof original;

    app.use('/dashboard', simulateAuth(user.id), requireMfaSetup);
    app.get('/dashboard', c => c.json({ ok: true }));

    const res = await app.request('/dashboard');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    runtime.adapter.isMfaEnabled = original;
  });
});

// ---------------------------------------------------------------------------
// 4. requireStepUp
// ---------------------------------------------------------------------------

describe('requireStepUp', () => {
  let runtime: MutableTestRuntime;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    runtime = makeTestRuntime();
    app = buildApp(runtime);
  });

  test('authenticated user with recently verified MFA passes through', async () => {
    const sessionId = 'step-up-session';
    await runtime.repos.session.createSession(
      'user-123',
      'fake-token',
      sessionId,
      undefined,
      runtime.config,
    );
    await runtime.repos.session.setMfaVerifiedAt(sessionId);

    app.use('/sensitive', simulateAuth('user-123', sessionId), requireStepUp());
    app.get('/sensitive', c => c.json({ ok: true }));

    const res = await app.request('/sensitive');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('authenticated user with expired MFA verification receives 403 STEP_UP_REQUIRED', async () => {
    const sessionId = 'expired-session';
    await runtime.repos.session.createSession(
      'user-123',
      'fake-token',
      sessionId,
      undefined,
      runtime.config,
    );
    await runtime.repos.session.setMfaVerifiedAt(sessionId);

    // Monkey-patch getMfaVerifiedAt to return a timestamp from 10 minutes ago
    const original = runtime.repos.session.getMfaVerifiedAt;
    runtime.repos.session.getMfaVerifiedAt = async () => Math.floor(Date.now() / 1000) - 600;

    app.use('/sensitive', simulateAuth('user-123', sessionId), requireStepUp());
    app.get('/sensitive', c => c.json({ ok: true }));

    const res = await app.request('/sensitive');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Step-up authentication expired');
    expect(body.code).toBe('STEP_UP_REQUIRED');

    runtime.repos.session.getMfaVerifiedAt = original;
  });

  test('authenticated user who never completed MFA receives 403 STEP_UP_REQUIRED', async () => {
    const sessionId = 'no-mfa-session';
    await runtime.repos.session.createSession(
      'user-123',
      'fake-token',
      sessionId,
      undefined,
      runtime.config,
    );
    // Do NOT call setMfaVerifiedAt

    app.use('/sensitive', simulateAuth('user-123', sessionId), requireStepUp());
    app.get('/sensitive', c => c.json({ ok: true }));

    const res = await app.request('/sensitive');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Step-up authentication required');
    expect(body.code).toBe('STEP_UP_REQUIRED');
  });

  test('no session (sessionId = null) throws 401', async () => {
    app.use('/sensitive', simulateAuth('user-123', null), requireStepUp());
    app.get('/sensitive', c => c.json({ ok: true }));

    const res = await app.request('/sensitive');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Authentication required' });
  });

  test('custom maxAge is respected', async () => {
    const sessionId = 'custom-age-session';
    await runtime.repos.session.createSession(
      'user-123',
      'fake-token',
      sessionId,
      undefined,
      runtime.config,
    );
    await runtime.repos.session.setMfaVerifiedAt(sessionId);

    // Return a timestamp from 61 seconds ago — within default 300s but outside custom 60s
    const original = runtime.repos.session.getMfaVerifiedAt;
    runtime.repos.session.getMfaVerifiedAt = async () => Math.floor(Date.now() / 1000) - 61;

    app.use('/sensitive', simulateAuth('user-123', sessionId), requireStepUp({ maxAge: 60 }));
    app.get('/sensitive', c => c.json({ ok: true }));

    const res = await app.request('/sensitive');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Step-up authentication expired');
    expect(body.code).toBe('STEP_UP_REQUIRED');

    runtime.repos.session.getMfaVerifiedAt = original;
  });

  test('default maxAge is 300 seconds (5 minutes)', async () => {
    const sessionId = 'default-age-session';
    await runtime.repos.session.createSession(
      'user-123',
      'fake-token',
      sessionId,
      undefined,
      runtime.config,
    );
    await runtime.repos.session.setMfaVerifiedAt(sessionId);

    // Return a timestamp from 299 seconds ago — within default 300s window
    const original = runtime.repos.session.getMfaVerifiedAt;
    runtime.repos.session.getMfaVerifiedAt = async () => Math.floor(Date.now() / 1000) - 299;

    app.use('/sensitive', simulateAuth('user-123', sessionId), requireStepUp());
    app.get('/sensitive', c => c.json({ ok: true }));

    const res = await app.request('/sensitive');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    runtime.repos.session.getMfaVerifiedAt = original;
  });

  test('verification at exactly maxAge boundary is still valid', async () => {
    const sessionId = 'boundary-session';
    await runtime.repos.session.createSession(
      'user-123',
      'fake-token',
      sessionId,
      undefined,
      runtime.config,
    );

    // Return a timestamp from exactly 300 seconds ago — boundary of default maxAge
    const original = runtime.repos.session.getMfaVerifiedAt;
    runtime.repos.session.getMfaVerifiedAt = async () => Math.floor(Date.now() / 1000) - 300;

    app.use('/sensitive', simulateAuth('user-123', sessionId), requireStepUp());
    app.get('/sensitive', c => c.json({ ok: true }));

    const res = await app.request('/sensitive');
    // now - verifiedAt === maxAge, the check is `now - verifiedAt > maxAge` (strict >),
    // so exactly 300 is NOT expired
    expect(res.status).toBe(200);

    runtime.repos.session.getMfaVerifiedAt = original;
  });

  test('verification one second past maxAge is expired', async () => {
    const sessionId = 'past-boundary-session';
    await runtime.repos.session.createSession(
      'user-123',
      'fake-token',
      sessionId,
      undefined,
      runtime.config,
    );

    const original = runtime.repos.session.getMfaVerifiedAt;
    runtime.repos.session.getMfaVerifiedAt = async () => Math.floor(Date.now() / 1000) - 301;

    app.use('/sensitive', simulateAuth('user-123', sessionId), requireStepUp());
    app.get('/sensitive', c => c.json({ ok: true }));

    const res = await app.request('/sensitive');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('STEP_UP_REQUIRED');

    runtime.repos.session.getMfaVerifiedAt = original;
  });
});
