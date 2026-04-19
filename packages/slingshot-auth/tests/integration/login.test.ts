import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createLockoutService, createMemoryLockoutRepository } from '../../src/lib/accountLockout';
import { createLoginRouter } from '../../src/routes/login';
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
  app.route('/', createLoginRouter({ primaryField: 'email' }, runtime));
  return app;
}

function buildAppWithRefresh(runtime: MutableTestRuntime) {
  const app = wrapWithRuntime(runtime);
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.route(
    '/',
    createLoginRouter(
      {
        primaryField: 'email',
        refreshTokens: {
          accessTokenExpiry: 900,
          refreshTokenExpiry: 2592000,
          rotationGraceSeconds: 10,
        },
      },
      runtime,
    ),
  );
  return app;
}

const jsonPost = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const EMAIL = 'user@example.com';
const PASSWORD = 'StrongPass1!';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /auth/login', () => {
  let runtime: MutableTestRuntime;

  beforeEach(() => {
    runtime = makeTestRuntime();
  });

  // -----------------------------------------------------------------------
  // 1. Happy path — valid credentials
  // -----------------------------------------------------------------------
  test('returns 200 with token and userId for valid credentials', async () => {
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);
    const app = buildApp(runtime);

    const res = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.userId).toBeString();
    expect(body.userId.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 2. Wrong password
  // -----------------------------------------------------------------------
  test('returns 401 for wrong password', async () => {
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);
    const app = buildApp(runtime);

    const res = await app.request(
      '/auth/login',
      jsonPost({ email: EMAIL, password: 'WrongPassword1!' }),
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeString();
  });

  // -----------------------------------------------------------------------
  // 3. Non-existent user — same 401 as wrong password (no enumeration)
  // -----------------------------------------------------------------------
  test('returns 401 for non-existent user (no user enumeration)', async () => {
    const app = buildApp(runtime);

    const res = await app.request(
      '/auth/login',
      jsonPost({ email: 'nobody@example.com', password: PASSWORD }),
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid credentials');
  });

  // -----------------------------------------------------------------------
  // 4. Empty password
  // -----------------------------------------------------------------------
  test('rejects empty password', async () => {
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);
    const app = buildApp(runtime);

    const res = await app.request('/auth/login', jsonPost({ email: EMAIL, password: '' }));

    // Zod min(1) on password field → validation error (400 or 422)
    expect([400, 422]).toContain(res.status);
  });

  // -----------------------------------------------------------------------
  // 5. Empty email — validation error
  // -----------------------------------------------------------------------
  test('rejects empty email with validation error', async () => {
    const app = buildApp(runtime);

    const res = await app.request('/auth/login', jsonPost({ email: '', password: PASSWORD }));

    expect([400, 422]).toContain(res.status);
  });

  // -----------------------------------------------------------------------
  // 6. Missing body fields
  // -----------------------------------------------------------------------
  test('rejects missing email field', async () => {
    const app = buildApp(runtime);

    const res = await app.request('/auth/login', jsonPost({ password: PASSWORD }));

    expect([400, 422]).toContain(res.status);
  });

  test('rejects missing password field', async () => {
    const app = buildApp(runtime);

    const res = await app.request('/auth/login', jsonPost({ email: EMAIL }));

    expect([400, 422]).toContain(res.status);
  });

  test('rejects completely empty body', async () => {
    const app = buildApp(runtime);

    const res = await app.request('/auth/login', jsonPost({}));

    expect([400, 422]).toContain(res.status);
  });

  // -----------------------------------------------------------------------
  // 7. Account lockout — after N failed attempts, login is blocked
  // -----------------------------------------------------------------------
  describe('account lockout', () => {
    beforeEach(() => {
      runtime.lockout = createLockoutService(
        { maxAttempts: 3, lockoutDuration: 60 },
        createMemoryLockoutRepository(),
      );
    });

    test('blocks login after maxAttempts consecutive failures', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      await runtime.adapter.create(EMAIL, hash);
      const app = buildApp(runtime);

      // 3 failed attempts to trigger lockout
      for (let i = 0; i < 3; i++) {
        await app.request('/auth/login', jsonPost({ email: EMAIL, password: 'wrong' }));
      }

      // Now even valid credentials should be rejected — account is locked
      // The route returns 401 (not 423) to conceal lockout status (M5 security fix)
      const res = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));

      expect(res.status).toBe(401);
    });

    test('valid credentials succeed before reaching maxAttempts', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      await runtime.adapter.create(EMAIL, hash);
      const app = buildApp(runtime);

      // 2 failed attempts — below threshold of 3
      for (let i = 0; i < 2; i++) {
        await app.request('/auth/login', jsonPost({ email: EMAIL, password: 'wrong' }));
      }

      const res = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));

      expect(res.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Successful login resets failure count
  // -----------------------------------------------------------------------
  test('successful login resets failure count so subsequent failures do not lock out prematurely', async () => {
    runtime.lockout = createLockoutService(
      { maxAttempts: 3, lockoutDuration: 60 },
      createMemoryLockoutRepository(),
    );
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);
    const app = buildApp(runtime);

    // 2 failures
    for (let i = 0; i < 2; i++) {
      await app.request('/auth/login', jsonPost({ email: EMAIL, password: 'wrong' }));
    }

    // Successful login — should reset counter
    const success = await app.request(
      '/auth/login',
      jsonPost({ email: EMAIL, password: PASSWORD }),
    );
    expect(success.status).toBe(200);

    // 2 more failures — total is 2, not 4, because counter was reset
    for (let i = 0; i < 2; i++) {
      await app.request('/auth/login', jsonPost({ email: EMAIL, password: 'wrong' }));
    }

    // Should still be able to log in (2 < 3 threshold)
    const res = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // 9. Events emitted
  // -----------------------------------------------------------------------
  describe('event emission', () => {
    test('emits security.auth.login.success on successful login', async () => {
      const emitted: string[] = [];
      runtime.eventBus = makeEventBus(event => emitted.push(event));
      const hash = await Bun.password.hash(PASSWORD);
      await runtime.adapter.create(EMAIL, hash);
      const app = buildApp(runtime);

      await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));

      expect(emitted).toContain('security.auth.login.success');
    });

    test('emits security.auth.login.failure on failed login', async () => {
      const emitted: string[] = [];
      runtime.eventBus = makeEventBus(event => emitted.push(event));
      const hash = await Bun.password.hash(PASSWORD);
      await runtime.adapter.create(EMAIL, hash);
      const app = buildApp(runtime);

      await app.request('/auth/login', jsonPost({ email: EMAIL, password: 'wrong' }));

      expect(emitted).toContain('security.auth.login.failure');
    });

    test('emits security.auth.login.blocked when account is locked', async () => {
      const emitted: string[] = [];
      runtime.eventBus = makeEventBus(event => emitted.push(event));
      runtime.lockout = createLockoutService(
        { maxAttempts: 2, lockoutDuration: 60 },
        createMemoryLockoutRepository(),
      );
      const hash = await Bun.password.hash(PASSWORD);
      await runtime.adapter.create(EMAIL, hash);
      const app = buildApp(runtime);

      // Lock the account with 2 failures
      for (let i = 0; i < 2; i++) {
        await app.request('/auth/login', jsonPost({ email: EMAIL, password: 'wrong' }));
      }

      // Clear emitted events to isolate the blocked event
      emitted.length = 0;

      // Attempt login on locked account
      await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));

      expect(emitted).toContain('security.auth.login.blocked');
    });

    test('emits security.auth.login.failure for non-existent user', async () => {
      const emitted: string[] = [];
      runtime.eventBus = makeEventBus(event => emitted.push(event));
      const app = buildApp(runtime);

      await app.request(
        '/auth/login',
        jsonPost({ email: 'ghost@example.com', password: 'anything' }),
      );

      expect(emitted).toContain('security.auth.login.failure');
    });
  });

  // -----------------------------------------------------------------------
  // 10. Token contains correct claims
  // -----------------------------------------------------------------------
  test('returned JWT contains sub claim matching userId', async () => {
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);
    const app = buildApp(runtime);

    const res = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));

    expect(res.status).toBe(200);
    const body = await res.json();

    // Decode the JWT payload (base64url-encoded middle segment)
    const [, payloadB64] = body.token.split('.');
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));

    expect(payload.sub).toBe(body.userId);
    expect(payload.sid).toBeString();
    expect(payload.exp).toBeNumber();
    expect(payload.iat).toBeNumber();
  });

  // -----------------------------------------------------------------------
  // 11. Refresh token — when configured, response includes refreshToken
  // -----------------------------------------------------------------------
  test('returns refreshToken when refreshTokens config is present', async () => {
    runtime = makeTestRuntime({
      refreshToken: {
        accessTokenExpiry: 900,
        refreshTokenExpiry: 2592000,
        rotationGraceSeconds: 10,
      },
    });
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);
    const app = buildAppWithRefresh(runtime);

    const res = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshToken).toBeString();
    expect(body.refreshToken!.length).toBeGreaterThan(0);
    expect(body.token).toBeString();
    expect(body.token.length).toBeGreaterThan(0);
  });

  test('does not return refreshToken when refreshTokens config is absent', async () => {
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);
    const app = buildApp(runtime);

    const res = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshToken).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 12. Timing safety — non-existent user is not significantly faster
  // -----------------------------------------------------------------------
  test('non-existent user takes similar time to wrong password (timing safety)', async () => {
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);
    const app = buildApp(runtime);

    // Warm up to avoid first-call overhead
    await app.request('/auth/login', jsonPost({ email: 'warmup@example.com', password: 'warmup' }));
    await app.request('/auth/login', jsonPost({ email: EMAIL, password: 'warmup' }));

    // Measure non-existent user
    const samples = 3;
    let nonExistentTotal = 0;
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      await app.request(
        '/auth/login',
        jsonPost({ email: `nonexistent${i}@example.com`, password: 'SomePass1!' }),
      );
      nonExistentTotal += performance.now() - start;
    }
    const nonExistentAvg = nonExistentTotal / samples;

    // Measure wrong password (user exists)
    let wrongPasswordTotal = 0;
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      await app.request('/auth/login', jsonPost({ email: EMAIL, password: `WrongPass${i}!` }));
      wrongPasswordTotal += performance.now() - start;
    }
    const wrongPasswordAvg = wrongPasswordTotal / samples;

    // The ratio should be close to 1.0. Allow up to 3x to account for CI variance,
    // but the real point is that non-existent should NOT be near-zero (no bcrypt skip).
    const ratio = nonExistentAvg / wrongPasswordAvg;
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(5);
  });

  // -----------------------------------------------------------------------
  // 13. Invalid email format
  // -----------------------------------------------------------------------
  test('rejects invalid email format with validation error', async () => {
    const app = buildApp(runtime);

    const res = await app.request(
      '/auth/login',
      jsonPost({ email: 'not-an-email', password: PASSWORD }),
    );

    expect([400, 422]).toContain(res.status);
  });

  // -----------------------------------------------------------------------
  // 14. Response body structure on success
  // -----------------------------------------------------------------------
  test('successful login response has expected shape', async () => {
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);
    const app = buildApp(runtime);

    const res = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('token');
    expect(body).toHaveProperty('userId');
    // mfaRequired should not be present for a normal login
    expect(body.mfaRequired).toBeUndefined();
    expect(body.mfaToken).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 15. Lockout with non-existent user does not lock unknown accounts
  // -----------------------------------------------------------------------
  test('failed logins for non-existent user do not trigger lockout for other users', async () => {
    runtime.lockout = createLockoutService(
      { maxAttempts: 2, lockoutDuration: 60 },
      createMemoryLockoutRepository(),
    );
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);
    const app = buildApp(runtime);

    // Fail many times with a non-existent user
    for (let i = 0; i < 5; i++) {
      await app.request('/auth/login', jsonPost({ email: 'ghost@example.com', password: 'wrong' }));
    }

    // The real user should still be able to log in
    const res = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // 16. Token cookie is set on successful login
  // -----------------------------------------------------------------------
  test('sets session cookie on successful login', async () => {
    const hash = await Bun.password.hash(PASSWORD);
    await runtime.adapter.create(EMAIL, hash);
    const app = buildApp(runtime);

    const res = await app.request('/auth/login', jsonPost({ email: EMAIL, password: PASSWORD }));

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeString();
    expect(setCookie!).toContain('token=');
  });

  // -----------------------------------------------------------------------
  // 17. Password exceeding max length is rejected
  // -----------------------------------------------------------------------
  test('rejects password exceeding max length (128 chars)', async () => {
    const app = buildApp(runtime);
    const longPassword = 'A'.repeat(129);

    const res = await app.request(
      '/auth/login',
      jsonPost({ email: EMAIL, password: longPassword }),
    );

    expect([400, 422]).toContain(res.status);
  });
});
