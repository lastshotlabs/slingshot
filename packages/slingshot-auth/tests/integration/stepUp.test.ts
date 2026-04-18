import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createStepUpRouter } from '../../src/routes/stepUp';
import { makeEventBus, makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';
import type { MutableTestRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-id';

function buildApp(
  runtime: MutableTestRuntime,
  opts?: {
    userId?: string;
    authenticated?: boolean;
    rateLimit?: { mfaVerify?: { max: number; windowMs: number } };
  },
) {
  const app = wrapWithRuntime(runtime);
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  // Inject auth context if authenticated
  if (opts?.authenticated !== false && opts?.userId) {
    app.use('*', async (c, next) => {
      c.set('authUserId', opts.userId!);
      c.set('sessionId', SESSION_ID);
      await next();
    });
  }
  app.route(
    '/',
    createStepUpRouter({ stepUp: { maxAge: 300 }, rateLimit: opts?.rateLimit }, runtime),
  );
  return app;
}

const jsonPost = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const EMAIL = 'stepup@example.com';
const PASSWORD = 'StrongPass1!';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /auth/step-up', () => {
  let runtime: MutableTestRuntime;
  let userId: string;

  beforeEach(async () => {
    runtime = makeTestRuntime();
    const hash = await Bun.password.hash(PASSWORD);
    const user = await runtime.adapter.create(EMAIL, hash);
    userId = user.id;
    // Create a session so setMfaVerifiedAt can update it
    await runtime.repos.session.createSession(userId, 'fake-token', SESSION_ID);
  });

  // -----------------------------------------------------------------------
  // 1. Authentication required — no auth context
  // -----------------------------------------------------------------------
  test('returns 401 when no auth token is present', async () => {
    const app = buildApp(runtime, { authenticated: false });

    const res = await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: PASSWORD }),
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  // -----------------------------------------------------------------------
  // 2. Password-based step-up — success
  // -----------------------------------------------------------------------
  test('returns 200 with correct password', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    const res = await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: PASSWORD }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 3. Password-based step-up — wrong password
  // -----------------------------------------------------------------------
  test('returns 401 with wrong password', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    const res = await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: 'WrongPassword1!' }),
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid credentials');
  });

  // -----------------------------------------------------------------------
  // 4. Sets mfaVerifiedAt on session after successful step-up
  // -----------------------------------------------------------------------
  test('sets mfaVerifiedAt on session after successful step-up', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    // Verify mfaVerifiedAt is null before step-up
    const before = await runtime.repos.session.getMfaVerifiedAt(SESSION_ID);
    expect(before).toBeNull();

    await app.request('/auth/step-up', jsonPost({ method: 'password', password: PASSWORD }));

    const after = await runtime.repos.session.getMfaVerifiedAt(SESSION_ID);
    expect(after).toBeNumber();
    expect(after!).toBeGreaterThan(0);

    // Timestamp should be reasonably close to now (within 5 seconds)
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(after!).toBeGreaterThanOrEqual(nowSeconds - 5);
    expect(after!).toBeLessThanOrEqual(nowSeconds + 1);
  });

  // -----------------------------------------------------------------------
  // 5. Emits security.auth.step_up.success on successful step-up
  // -----------------------------------------------------------------------
  test('emits security.auth.step_up.success on successful step-up', async () => {
    const emitted: string[] = [];
    runtime.eventBus = makeEventBus(event => emitted.push(event));
    const app = buildApp(runtime, { userId, authenticated: true });

    await app.request('/auth/step-up', jsonPost({ method: 'password', password: PASSWORD }));

    expect(emitted).toContain('security.auth.step_up.success');
  });

  // -----------------------------------------------------------------------
  // 6. Emits security.auth.step_up.failure on failed step-up
  // -----------------------------------------------------------------------
  test('emits security.auth.step_up.failure on failed step-up', async () => {
    const emitted: string[] = [];
    runtime.eventBus = makeEventBus(event => emitted.push(event));
    const app = buildApp(runtime, { userId, authenticated: true });

    await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: 'WrongPassword1!' }),
    );

    expect(emitted).toContain('security.auth.step_up.failure');
  });

  // -----------------------------------------------------------------------
  // 7. Does not emit success event on failure
  // -----------------------------------------------------------------------
  test('does not emit success event on failed step-up', async () => {
    const emitted: string[] = [];
    runtime.eventBus = makeEventBus(event => emitted.push(event));
    const app = buildApp(runtime, { userId, authenticated: true });

    await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: 'WrongPassword1!' }),
    );

    expect(emitted).not.toContain('security.auth.step_up.success');
  });

  // -----------------------------------------------------------------------
  // 8. Validation — missing method field
  // -----------------------------------------------------------------------
  test('returns 400/422 when method is missing', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    const res = await app.request('/auth/step-up', jsonPost({ password: PASSWORD }));

    expect([400, 422]).toContain(res.status);
  });

  // -----------------------------------------------------------------------
  // 9. Validation — invalid method value
  // -----------------------------------------------------------------------
  test('returns 400/422 for invalid method value', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    const res = await app.request(
      '/auth/step-up',
      jsonPost({ method: 'invalid-method', password: PASSWORD }),
    );

    expect([400, 422]).toContain(res.status);
  });

  // -----------------------------------------------------------------------
  // 10. Password method without password field returns 401
  // -----------------------------------------------------------------------
  test('returns 401 when password method is used without password field', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    const res = await app.request('/auth/step-up', jsonPost({ method: 'password' }));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid credentials');
  });

  // -----------------------------------------------------------------------
  // 11. TOTP method without code returns 401
  // -----------------------------------------------------------------------
  test('returns 401 when totp method is used without code', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    const res = await app.request('/auth/step-up', jsonPost({ method: 'totp' }));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid credentials');
  });

  // -----------------------------------------------------------------------
  // 12. Rate limiting — 429 after too many attempts
  // -----------------------------------------------------------------------
  test('returns 429 after exceeding rate limit', async () => {
    const app = buildApp(runtime, {
      userId,
      authenticated: true,
      rateLimit: { mfaVerify: { max: 3, windowMs: 60_000 } },
    });

    // First two requests pass through (wrong password → 401); max=3 means count<3 passes.
    const r1 = await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: 'wrong' }),
    );
    expect(r1.status).toBe(401);

    const r2 = await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: 'wrong' }),
    );
    expect(r2.status).toBe(401);

    // Third request reaches rate limit (count=3 >= max=3)
    const r3 = await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: 'wrong' }),
    );
    expect(r3.status).toBe(429);
    const body = await r3.json();
    expect(body.error).toMatch(/too many/i);
  });

  // -----------------------------------------------------------------------
  // 13. Rate limit fires before credential verification
  // -----------------------------------------------------------------------
  test('rate limit fires before credential check: 429 beats 401', async () => {
    const app = buildApp(runtime, {
      userId,
      authenticated: true,
      rateLimit: { mfaVerify: { max: 3, windowMs: 60_000 } },
    });

    // Exhaust the rate limit with wrong passwords (max=3: counts 1,2 pass, 3 blocked)
    await app.request('/auth/step-up', jsonPost({ method: 'password', password: 'wrong' }));
    await app.request('/auth/step-up', jsonPost({ method: 'password', password: 'wrong' }));

    // Even a valid password should get 429 (count=3 >= max=3)
    const res = await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: PASSWORD }),
    );
    expect(res.status).toBe(429);
  });

  // -----------------------------------------------------------------------
  // 14. mfaVerifiedAt is NOT set on failed step-up
  // -----------------------------------------------------------------------
  test('does not set mfaVerifiedAt on failed step-up', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: 'WrongPassword1!' }),
    );

    const mfaAt = await runtime.repos.session.getMfaVerifiedAt(SESSION_ID);
    expect(mfaAt).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 15. Successful step-up returns { ok: true } body shape
  // -----------------------------------------------------------------------
  test('successful step-up response has expected shape', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    const res = await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: PASSWORD }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  // -----------------------------------------------------------------------
  // 16. Repeated successful step-ups update mfaVerifiedAt
  // -----------------------------------------------------------------------
  test('repeated step-ups update mfaVerifiedAt timestamp', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    await app.request('/auth/step-up', jsonPost({ method: 'password', password: PASSWORD }));
    const first = await runtime.repos.session.getMfaVerifiedAt(SESSION_ID);
    expect(first).toBeNumber();

    // Second step-up should also succeed and update the timestamp
    await app.request('/auth/step-up', jsonPost({ method: 'password', password: PASSWORD }));
    const second = await runtime.repos.session.getMfaVerifiedAt(SESSION_ID);
    expect(second).toBeNumber();
    expect(second!).toBeGreaterThanOrEqual(first!);
  });

  // -----------------------------------------------------------------------
  // 17. Empty body returns validation error
  // -----------------------------------------------------------------------
  test('rejects completely empty body', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    const res = await app.request('/auth/step-up', jsonPost({}));

    expect([400, 422]).toContain(res.status);
  });

  // -----------------------------------------------------------------------
  // 18. Recovery method without code returns 401
  // -----------------------------------------------------------------------
  test('returns 401 when recovery method is used without code', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    const res = await app.request('/auth/step-up', jsonPost({ method: 'recovery' }));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid credentials');
  });

  test('returns 403 and does not strengthen the session for suspended accounts', async () => {
    const app = buildApp(runtime, { userId, authenticated: true });

    await runtime.adapter.setSuspended?.(userId, true);

    const res = await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: PASSWORD }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Account suspended');
    expect(await runtime.repos.session.getMfaVerifiedAt(SESSION_ID)).toBeNull();
  });

  test('returns 403 when email verification becomes required before step-up completes', async () => {
    runtime = makeTestRuntime({
      emailVerification: { required: true, tokenExpiry: 3600 },
    });
    const hash = await Bun.password.hash(PASSWORD);
    const user = await runtime.adapter.create(EMAIL, hash);
    userId = user.id;
    await runtime.adapter.setEmailVerified?.(userId, true);
    await runtime.repos.session.createSession(userId, 'fake-token', SESSION_ID);
    const app = buildApp(runtime, { userId, authenticated: true });

    await runtime.adapter.setEmailVerified?.(userId, false);

    const res = await app.request(
      '/auth/step-up',
      jsonPost({ method: 'password', password: PASSWORD }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Email not verified');
    expect(await runtime.repos.session.getMfaVerifiedAt(SESSION_ID)).toBeNull();
  });
});
