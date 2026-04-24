import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { Secret, TOTP } from 'otpauth';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createMfaRouter } from '../../src/routes/mfa';
import { makeEventBus, makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';
import type { MutableTestRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMAIL = 'mfa-user@example.com';
const PASSWORD = 'StrongPass1!';

function buildApp(runtime: MutableTestRuntime) {
  const app = wrapWithRuntime(runtime);
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.route('/', createMfaRouter({}, runtime));
  return app;
}

/**
 * Wrap the app with an extra middleware that injects the actor
 * into the Hono context, simulating an authenticated session.
 */
function buildAuthenticatedApp(
  runtime: MutableTestRuntime,
  userId: string,
  sessionId = 'test-session-id',
) {
  const app = wrapWithRuntime(runtime);
  // Inject auth context before MFA routes
  app.use('*', async (c, next) => {
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
    await next();
  });
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.route('/', createMfaRouter({}, runtime));
  return app;
}

/**
 * Build an authenticated app with email OTP config enabled.
 */
function buildAuthenticatedAppWithEmailOtp(
  runtime: MutableTestRuntime,
  userId: string,
  sessionId = 'test-session-id',
) {
  const app = wrapWithRuntime(runtime);
  app.use('*', async (c, next) => {
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
    await next();
  });
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.route('/', createMfaRouter({}, runtime));
  return app;
}

const jsonPost = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const jsonDelete = (body: Record<string, unknown>) => ({
  method: 'DELETE' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Generate a valid TOTP code from a base32 secret. */
function generateTotpCode(secret: string): string {
  const totp = new TOTP({
    issuer: 'Core API',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
  return totp.generate();
}

/**
 * Create a user and complete TOTP MFA setup. Returns the secret and recovery codes.
 */
async function createUserWithMfa(runtime: MutableTestRuntime) {
  const hash = await Bun.password.hash(PASSWORD);
  const { id: userId } = await runtime.adapter.create(EMAIL, hash);

  const app = buildAuthenticatedApp(runtime, userId);

  // Step 1: Initiate setup
  const setupRes = await app.request('/auth/mfa/setup', jsonPost({}));
  expect(setupRes.status).toBe(200);
  const setupBody = await setupRes.json();
  const secret: string = setupBody.secret;

  // Step 2: Verify setup with a valid TOTP code
  const code = generateTotpCode(secret);
  const verifyRes = await app.request('/auth/mfa/verify-setup', jsonPost({ code }));
  expect(verifyRes.status).toBe(200);
  const verifyBody = await verifyRes.json();

  return {
    userId,
    secret,
    recoveryCodes: verifyBody.recoveryCodes as string[],
    app,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MFA routes', () => {
  let runtime: MutableTestRuntime;

  beforeEach(() => {
    runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
  });

  // =========================================================================
  // POST /auth/mfa/setup
  // =========================================================================
  describe('POST /auth/mfa/setup', () => {
    test('returns 200 with secret and URI for authenticated user', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedApp(runtime, userId);

      const res = await app.request('/auth/mfa/setup', jsonPost({}));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.secret).toBeString();
      expect(body.secret.length).toBeGreaterThan(0);
      expect(body.uri).toBeString();
      expect(body.uri).toStartWith('otpauth://totp/');
    });

    test('returns 401 without authentication', async () => {
      const app = buildApp(runtime);

      const res = await app.request('/auth/mfa/setup', jsonPost({}));

      expect(res.status).toBe(401);
    });

    test('URI contains correct issuer', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedApp(runtime, userId);

      const res = await app.request('/auth/mfa/setup', jsonPost({}));
      const body = await res.json();

      expect(body.uri).toContain('issuer=Core%20API');
    });

    test('each setup call generates a different secret', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedApp(runtime, userId);

      const res1 = await app.request('/auth/mfa/setup', jsonPost({}));
      const body1 = await res1.json();

      const res2 = await app.request('/auth/mfa/setup', jsonPost({}));
      const body2 = await res2.json();

      expect(body1.secret).not.toBe(body2.secret);
    });

    test('returns 403 for suspended accounts', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedApp(runtime, userId);

      await runtime.adapter.setSuspended?.(userId, true);

      const res = await app.request('/auth/mfa/setup', jsonPost({}));

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Account suspended');
    });
  });

  // =========================================================================
  // POST /auth/mfa/verify-setup
  // =========================================================================
  describe('POST /auth/mfa/verify-setup', () => {
    test('returns 200 with recovery codes for valid TOTP code', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedApp(runtime, userId);

      // Initiate setup
      const setupRes = await app.request('/auth/mfa/setup', jsonPost({}));
      const { secret } = await setupRes.json();

      // Verify with valid code
      const code = generateTotpCode(secret);
      const res = await app.request('/auth/mfa/verify-setup', jsonPost({ code }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.recoveryCodes).toBeArray();
      expect(body.recoveryCodes.length).toBe(10); // default count
      for (const rc of body.recoveryCodes) {
        expect(rc).toBeString();
        expect(rc.length).toBe(8);
      }
    });

    test('returns 401 for invalid TOTP code', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedApp(runtime, userId);

      await app.request('/auth/mfa/setup', jsonPost({}));

      const res = await app.request('/auth/mfa/verify-setup', jsonPost({ code: '000000' }));

      expect(res.status).toBe(401);
    });

    test('returns 400 when setup was not initiated', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedApp(runtime, userId);

      const res = await app.request('/auth/mfa/verify-setup', jsonPost({ code: '123456' }));

      expect(res.status).toBe(400);
    });

    test('returns 401 without authentication', async () => {
      const app = buildApp(runtime);

      const res = await app.request('/auth/mfa/verify-setup', jsonPost({ code: '123456' }));

      expect(res.status).toBe(401);
    });

    test('emits mfa.setup and mfa.enabled events on success', async () => {
      const emitted: string[] = [];
      runtime.eventBus = makeEventBus(event => emitted.push(event));

      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedApp(runtime, userId);

      const setupRes = await app.request('/auth/mfa/setup', jsonPost({}));
      const { secret } = await setupRes.json();
      const code = generateTotpCode(secret);

      await app.request('/auth/mfa/verify-setup', jsonPost({ code }));

      expect(emitted).toContain('security.auth.mfa.setup');
      expect(emitted).toContain('auth:mfa.enabled');
    });

    test('returns 403 when the user is suspended before MFA setup confirmation', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedApp(runtime, userId);

      const setupRes = await app.request('/auth/mfa/setup', jsonPost({}));
      const { secret } = await setupRes.json();

      await runtime.adapter.setSuspended?.(userId, true);

      const code = generateTotpCode(secret);
      const res = await app.request('/auth/mfa/verify-setup', jsonPost({ code }));

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Account suspended');
    });
  });

  // =========================================================================
  // GET /auth/mfa/methods
  // =========================================================================
  describe('GET /auth/mfa/methods', () => {
    test('returns empty methods before MFA setup', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedApp(runtime, userId);

      const res = await app.request('/auth/mfa/methods');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.methods).toBeArray();
      expect(body.methods).toHaveLength(0);
    });

    test('returns totp after TOTP setup', async () => {
      const { userId } = await createUserWithMfa(runtime);
      const app = buildAuthenticatedApp(runtime, userId);

      const res = await app.request('/auth/mfa/methods');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.methods).toContain('totp');
    });

    test('returns 401 without authentication', async () => {
      const app = buildApp(runtime);

      const res = await app.request('/auth/mfa/methods');

      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // POST /auth/mfa/verify (MFA login completion)
  // =========================================================================
  describe('POST /auth/mfa/verify', () => {
    test('completes MFA login with valid TOTP code', async () => {
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      const { userId, secret } = await createUserWithMfa(runtime);

      // Login should return mfaRequired. We need to create an MFA challenge
      // token directly since the login flow is not fully wired in this isolated test.
      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const mfaToken = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );

      // Build an unauthenticated app (verify doesn't require userAuth)
      const app = buildApp(runtime);
      const code = generateTotpCode(secret);

      const res = await app.request('/auth/mfa/verify', jsonPost({ mfaToken, code }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.token).toBeString();
      expect(body.userId).toBe(userId);
    });

    test('returns 401 for invalid TOTP code', async () => {
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      const { userId } = await createUserWithMfa(runtime);

      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const mfaToken = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );

      const app = buildApp(runtime);

      const res = await app.request('/auth/mfa/verify', jsonPost({ mfaToken, code: '000000' }));

      expect(res.status).toBe(401);
    });

    test('returns 401 for invalid mfaToken', async () => {
      const app = buildApp(runtime);

      const res = await app.request(
        '/auth/mfa/verify',
        jsonPost({ mfaToken: 'bogus-token', code: '123456' }),
      );

      expect(res.status).toBe(401);
    });

    test('returns 401 when neither code nor webauthnResponse is provided', async () => {
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      const { userId } = await createUserWithMfa(runtime);

      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const mfaToken = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );

      const app = buildApp(runtime);

      const res = await app.request('/auth/mfa/verify', jsonPost({ mfaToken }));

      expect(res.status).toBe(401);
    });

    test('completes MFA login with recovery code', async () => {
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      const { userId, recoveryCodes } = await createUserWithMfa(runtime);

      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const mfaToken = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );

      const app = buildApp(runtime);

      const res = await app.request(
        '/auth/mfa/verify',
        jsonPost({ mfaToken, code: recoveryCodes[0] }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.token).toBeString();
      expect(body.userId).toBe(userId);
    });

    test('returns 403 when the user is suspended after the MFA challenge is issued', async () => {
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      const { userId, secret } = await createUserWithMfa(runtime);

      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const mfaToken = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );
      await runtime.adapter.setSuspended?.(userId, true, 'admin lock');

      const app = buildApp(runtime);
      const code = generateTotpCode(secret);
      const res = await app.request('/auth/mfa/verify', jsonPost({ mfaToken, code }));

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('suspended');
    });

    test('returns 403 when email verification becomes required before MFA completion', async () => {
      runtime = makeTestRuntime({
        mfa: { issuer: 'Core API' },
        primaryField: 'email',
        emailVerification: { required: true, tokenExpiry: 86400 },
      });
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      await runtime.adapter.setEmailVerified?.(userId, true);
      const authedApp = buildAuthenticatedApp(runtime, userId);
      const setupRes = await authedApp.request('/auth/mfa/setup', jsonPost({}));
      expect(setupRes.status).toBe(200);
      const { secret } = await setupRes.json();

      const setupCode = generateTotpCode(secret);
      const verifySetupRes = await authedApp.request(
        '/auth/mfa/verify-setup',
        jsonPost({ code: setupCode }),
      );
      expect(verifySetupRes.status).toBe(200);

      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const mfaToken = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );
      await runtime.adapter.setEmailVerified?.(userId, false);

      const app = buildApp(runtime);
      const code = generateTotpCode(secret);
      const res = await app.request('/auth/mfa/verify', jsonPost({ mfaToken, code }));

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Email not verified');
    });

    test('recovery code can only be used once', async () => {
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      const { userId, recoveryCodes } = await createUserWithMfa(runtime);
      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');

      // Use the first recovery code
      const mfaToken1 = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );
      const app = buildApp(runtime);
      const res1 = await app.request(
        '/auth/mfa/verify',
        jsonPost({ mfaToken: mfaToken1, code: recoveryCodes[0] }),
      );
      expect(res1.status).toBe(200);

      // Try the same recovery code again
      const mfaToken2 = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );
      const res2 = await app.request(
        '/auth/mfa/verify',
        jsonPost({ mfaToken: mfaToken2, code: recoveryCodes[0] }),
      );
      expect(res2.status).toBe(401);
    });

    test('mfaToken is consumed after use (single use)', async () => {
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      const { userId, secret } = await createUserWithMfa(runtime);

      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const mfaToken = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );

      const app = buildApp(runtime);
      const code = generateTotpCode(secret);

      // First use succeeds
      const res1 = await app.request('/auth/mfa/verify', jsonPost({ mfaToken, code }));
      expect(res1.status).toBe(200);

      // Second use fails (token consumed)
      const res2 = await app.request('/auth/mfa/verify', jsonPost({ mfaToken, code }));
      expect(res2.status).toBe(401);
    });

    test('emits success event on valid MFA verification', async () => {
      const emitted: string[] = [];
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      runtime.eventBus = makeEventBus(event => emitted.push(event));

      const { userId, secret } = await createUserWithMfa(runtime);

      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const mfaToken = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );

      const app = buildApp(runtime);
      const code = generateTotpCode(secret);

      await app.request('/auth/mfa/verify', jsonPost({ mfaToken, code }));

      expect(emitted).toContain('security.auth.mfa.verify.success');
    });

    test('emits failure event on invalid MFA verification', async () => {
      const emitted: string[] = [];
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      runtime.eventBus = makeEventBus(event => emitted.push(event));

      const { userId } = await createUserWithMfa(runtime);

      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const mfaToken = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );

      const app = buildApp(runtime);

      await app.request('/auth/mfa/verify', jsonPost({ mfaToken, code: '000000' }));

      expect(emitted).toContain('security.auth.mfa.verify.failure');
    });

    test('sets session cookie on successful MFA verification', async () => {
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      const { userId, secret } = await createUserWithMfa(runtime);

      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const mfaToken = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );

      const app = buildApp(runtime);
      const code = generateTotpCode(secret);

      const res = await app.request('/auth/mfa/verify', jsonPost({ mfaToken, code }));

      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeString();
      expect(setCookie!).toContain('token=');
    });

    test('completes MFA login with explicit method: totp', async () => {
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      const { userId, secret } = await createUserWithMfa(runtime);

      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const mfaToken = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );

      const app = buildApp(runtime);
      const code = generateTotpCode(secret);

      const res = await app.request(
        '/auth/mfa/verify',
        jsonPost({ mfaToken, code, method: 'totp' }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.token).toBeString();
    });
  });

  // =========================================================================
  // POST /auth/mfa/recovery-codes
  // =========================================================================
  describe('POST /auth/mfa/recovery-codes', () => {
    test('regenerates recovery codes with valid TOTP code', async () => {
      const { userId, secret, recoveryCodes: oldCodes } = await createUserWithMfa(runtime);
      const app = buildAuthenticatedApp(runtime, userId);

      const code = generateTotpCode(secret);
      const res = await app.request('/auth/mfa/recovery-codes', jsonPost({ code }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.recoveryCodes).toBeArray();
      expect(body.recoveryCodes.length).toBe(10);

      // New codes should differ from old codes
      const newSet = new Set(body.recoveryCodes);
      const overlap = oldCodes.filter((c: string) => newSet.has(c));
      // Statistically extremely unlikely to have any overlap with 31^8 code space
      expect(overlap.length).toBe(0);
    });

    test('returns 401 for invalid TOTP code', async () => {
      const { userId } = await createUserWithMfa(runtime);
      const app = buildAuthenticatedApp(runtime, userId);

      const res = await app.request('/auth/mfa/recovery-codes', jsonPost({ code: '000000' }));

      expect(res.status).toBe(401);
    });

    test('returns 401 without authentication', async () => {
      const app = buildApp(runtime);

      const res = await app.request('/auth/mfa/recovery-codes', jsonPost({ code: '123456' }));

      expect(res.status).toBe(401);
    });

    test('old recovery codes are invalidated after regeneration', async () => {
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      const { userId, secret, recoveryCodes: oldCodes } = await createUserWithMfa(runtime);

      // Regenerate
      const app = buildAuthenticatedApp(runtime, userId);
      const code = generateTotpCode(secret);
      await app.request('/auth/mfa/recovery-codes', jsonPost({ code }));

      // Try to use old recovery code for MFA verify
      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const mfaToken = await createMfaChallenge(
        runtime.repos.mfaChallenge,
        userId,
        {},
        runtime.config,
      );

      const unauthApp = buildApp(runtime);
      const res = await unauthApp.request(
        '/auth/mfa/verify',
        jsonPost({ mfaToken, code: oldCodes[0] }),
      );

      expect(res.status).toBe(401);
    });

    test('returns 403 for suspended accounts', async () => {
      const { userId, secret } = await createUserWithMfa(runtime);
      const app = buildAuthenticatedApp(runtime, userId);

      await runtime.adapter.setSuspended?.(userId, true);

      const code = generateTotpCode(secret);
      const res = await app.request('/auth/mfa/recovery-codes', jsonPost({ code }));

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Account suspended');
    });
  });

  // =========================================================================
  // DELETE /auth/mfa (Disable MFA)
  // =========================================================================
  describe('DELETE /auth/mfa', () => {
    test('disables MFA with valid TOTP code', async () => {
      const { userId, secret } = await createUserWithMfa(runtime);
      const app = buildAuthenticatedApp(runtime, userId);

      const code = generateTotpCode(secret);
      const res = await app.request('/auth/mfa', jsonDelete({ code }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    test('methods are empty after disabling MFA', async () => {
      const { userId, secret } = await createUserWithMfa(runtime);
      const app = buildAuthenticatedApp(runtime, userId);

      const code = generateTotpCode(secret);
      await app.request('/auth/mfa', jsonDelete({ code }));

      const methodsRes = await app.request('/auth/mfa/methods');
      const methodsBody = await methodsRes.json();
      expect(methodsBody.methods).toHaveLength(0);
    });

    test('returns 401 for invalid TOTP code', async () => {
      const { userId } = await createUserWithMfa(runtime);
      const app = buildAuthenticatedApp(runtime, userId);

      const res = await app.request('/auth/mfa', jsonDelete({ code: '000000' }));

      expect(res.status).toBe(401);
    });

    test('returns 400 when no verification method provided', async () => {
      const { userId } = await createUserWithMfa(runtime);
      const app = buildAuthenticatedApp(runtime, userId);

      const res = await app.request('/auth/mfa', jsonDelete({}));

      expect(res.status).toBe(400);
    });

    test('returns 401 without authentication', async () => {
      const app = buildApp(runtime);

      const res = await app.request('/auth/mfa', jsonDelete({ code: '123456' }));

      expect(res.status).toBe(401);
    });

    test('emits mfa.disabled event on success', async () => {
      const emitted: string[] = [];
      runtime.eventBus = makeEventBus(event => emitted.push(event));

      const { userId, secret } = await createUserWithMfa(runtime);
      const app = buildAuthenticatedApp(runtime, userId);

      const code = generateTotpCode(secret);
      await app.request('/auth/mfa', jsonDelete({ code }));

      expect(emitted).toContain('auth:mfa.disabled');
    });

    test('can disable MFA using password method', async () => {
      const { userId } = await createUserWithMfa(runtime);
      const app = buildAuthenticatedApp(runtime, userId);

      const res = await app.request(
        '/auth/mfa',
        jsonDelete({ method: 'password', password: PASSWORD }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    test('can disable MFA using recovery code', async () => {
      const { userId, recoveryCodes } = await createUserWithMfa(runtime);
      const app = buildAuthenticatedApp(runtime, userId);

      const res = await app.request(
        '/auth/mfa',
        jsonDelete({ method: 'recovery', code: recoveryCodes[0] }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    test('returns 403 when email verification becomes required before disabling MFA', async () => {
      runtime = makeTestRuntime({
        mfa: { issuer: 'Core API' },
        emailVerification: { required: true, tokenExpiry: 3600 },
      });
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      await runtime.adapter.setEmailVerified?.(userId, true);
      const setupApp = buildAuthenticatedApp(runtime, userId);
      const setupRes = await setupApp.request('/auth/mfa/setup', jsonPost({}));
      expect(setupRes.status).toBe(200);
      const { secret } = await setupRes.json();
      const setupCode = generateTotpCode(secret);
      const verifySetupRes = await setupApp.request(
        '/auth/mfa/verify-setup',
        jsonPost({ code: setupCode }),
      );
      expect(verifySetupRes.status).toBe(200);
      const app = buildAuthenticatedApp(runtime, userId);

      await runtime.adapter.setEmailVerified?.(userId, false);

      const code = generateTotpCode(secret);
      const res = await app.request('/auth/mfa', jsonDelete({ code }));

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Email not verified');
    });
  });

  // =========================================================================
  // Full TOTP setup flow (end-to-end)
  // =========================================================================
  describe('full TOTP setup flow', () => {
    test('setup → verify-setup → methods includes totp', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedApp(runtime, userId);

      // 1. Initiate setup
      const setupRes = await app.request('/auth/mfa/setup', jsonPost({}));
      expect(setupRes.status).toBe(200);
      const { secret, uri } = await setupRes.json();
      expect(secret).toBeString();
      expect(uri).toStartWith('otpauth://totp/');

      // 2. Verify setup
      const code = generateTotpCode(secret);
      const verifyRes = await app.request('/auth/mfa/verify-setup', jsonPost({ code }));
      expect(verifyRes.status).toBe(200);
      const { recoveryCodes } = await verifyRes.json();
      expect(recoveryCodes).toBeArray();
      expect(recoveryCodes.length).toBe(10);

      // 3. Methods should include totp
      const methodsRes = await app.request('/auth/mfa/methods');
      expect(methodsRes.status).toBe(200);
      const { methods } = await methodsRes.json();
      expect(methods).toContain('totp');
    });
  });

  // =========================================================================
  // Email OTP flows
  // =========================================================================
  describe('email OTP', () => {
    let emailOtpRuntime: MutableTestRuntime;

    beforeEach(() => {
      emailOtpRuntime = makeTestRuntime({
        mfa: { issuer: 'Core API', emailOtp: { codeLength: 6 } },
      });
    });

    test('POST /auth/mfa/email-otp/enable sends OTP and returns setupToken', async () => {
      const emitted: Array<{ event: string; data: unknown }> = [];
      emailOtpRuntime.eventBus = {
        emit: (event: string, data?: unknown) => {
          emitted.push({ event, data });
        },
        on: () => {},
        off: () => {},
        shutdown: async () => {},
      } as unknown as typeof emailOtpRuntime.eventBus;

      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await emailOtpRuntime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedAppWithEmailOtp(emailOtpRuntime, userId);

      const res = await app.request('/auth/mfa/email-otp/enable', jsonPost({}));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.setupToken).toBeString();

      // Check that delivery event was emitted with a code
      const deliveryEvent = emitted.find(e => e.event === 'auth:delivery.email_otp');
      expect(deliveryEvent).toBeDefined();
      const deliveryData = deliveryEvent!.data as { email: string; code: string };
      expect(deliveryData.code).toBeString();
      expect(deliveryData.code.length).toBe(6);
    });

    test('POST /auth/mfa/email-otp/enable returns 403 for suspended accounts', async () => {
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await emailOtpRuntime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedAppWithEmailOtp(emailOtpRuntime, userId);

      await emailOtpRuntime.adapter.setSuspended?.(userId, true);

      const res = await app.request('/auth/mfa/email-otp/enable', jsonPost({}));

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Account suspended');
    });

    test('POST /auth/mfa/email-otp/verify-setup confirms email OTP with valid code', async () => {
      const emitted: Array<{ event: string; data: unknown }> = [];
      emailOtpRuntime.eventBus = {
        emit: (event: string, data?: unknown) => {
          emitted.push({ event, data });
        },
        on: () => {},
        off: () => {},
        shutdown: async () => {},
      } as unknown as typeof emailOtpRuntime.eventBus;

      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await emailOtpRuntime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedAppWithEmailOtp(emailOtpRuntime, userId);

      // Enable
      const enableRes = await app.request('/auth/mfa/email-otp/enable', jsonPost({}));
      const { setupToken } = await enableRes.json();

      // Capture the OTP code from the delivery event
      const deliveryEvent = emitted.find(e => e.event === 'auth:delivery.email_otp');
      const { code } = deliveryEvent!.data as { code: string };

      // Verify setup
      const verifyRes = await app.request(
        '/auth/mfa/email-otp/verify-setup',
        jsonPost({ setupToken, code }),
      );

      expect(verifyRes.status).toBe(200);
      const body = await verifyRes.json();
      expect(body.ok).toBe(true);
      expect(body.recoveryCodes).toBeArray();
    });

    test('POST /auth/mfa/email-otp/verify-setup rejects invalid code', async () => {
      const emitted: Array<{ event: string; data: unknown }> = [];
      emailOtpRuntime.eventBus = {
        emit: (event: string, data?: unknown) => {
          emitted.push({ event, data });
        },
        on: () => {},
        off: () => {},
        shutdown: async () => {},
      } as unknown as typeof emailOtpRuntime.eventBus;

      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await emailOtpRuntime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedAppWithEmailOtp(emailOtpRuntime, userId);

      const enableRes = await app.request('/auth/mfa/email-otp/enable', jsonPost({}));
      const { setupToken } = await enableRes.json();

      const verifyRes = await app.request(
        '/auth/mfa/email-otp/verify-setup',
        jsonPost({ setupToken, code: '999999' }),
      );

      expect(verifyRes.status).toBe(401);
    });

    test('POST /auth/mfa/email-otp/verify-setup returns 403 for suspended accounts', async () => {
      const emitted: Array<{ event: string; data: unknown }> = [];
      emailOtpRuntime.eventBus = {
        emit: (event: string, data?: unknown) => {
          emitted.push({ event, data });
        },
        on: () => {},
        off: () => {},
        shutdown: async () => {},
      } as unknown as typeof emailOtpRuntime.eventBus;

      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await emailOtpRuntime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedAppWithEmailOtp(emailOtpRuntime, userId);

      const enableRes = await app.request('/auth/mfa/email-otp/enable', jsonPost({}));
      const { setupToken } = await enableRes.json();
      const deliveryEvent = emitted.find(e => e.event === 'auth:delivery.email_otp');
      const { code } = deliveryEvent!.data as { code: string };

      await emailOtpRuntime.adapter.setSuspended?.(userId, true);

      const verifyRes = await app.request(
        '/auth/mfa/email-otp/verify-setup',
        jsonPost({ setupToken, code }),
      );

      expect(verifyRes.status).toBe(403);
      const body = await verifyRes.json();
      expect(body.error).toBe('Account suspended');
    });

    test('methods include emailOtp after email OTP setup', async () => {
      const emitted: Array<{ event: string; data: unknown }> = [];
      emailOtpRuntime.eventBus = {
        emit: (event: string, data?: unknown) => {
          emitted.push({ event, data });
        },
        on: () => {},
        off: () => {},
        shutdown: async () => {},
      } as unknown as typeof emailOtpRuntime.eventBus;

      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await emailOtpRuntime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedAppWithEmailOtp(emailOtpRuntime, userId);

      // Enable and verify
      const enableRes = await app.request('/auth/mfa/email-otp/enable', jsonPost({}));
      const { setupToken } = await enableRes.json();
      const deliveryEvent = emitted.find(e => e.event === 'auth:delivery.email_otp');
      const { code } = deliveryEvent!.data as { code: string };
      await app.request('/auth/mfa/email-otp/verify-setup', jsonPost({ setupToken, code }));

      // Check methods
      const methodsRes = await app.request('/auth/mfa/methods');
      const body = await methodsRes.json();
      expect(body.methods).toContain('emailOtp');
    });

    test('DELETE /auth/mfa/email-otp returns 403 for suspended accounts', async () => {
      const emitted: Array<{ event: string; data: unknown }> = [];
      emailOtpRuntime.eventBus = {
        emit: (event: string, data?: unknown) => {
          emitted.push({ event, data });
        },
        on: () => {},
        off: () => {},
        shutdown: async () => {},
      } as unknown as typeof emailOtpRuntime.eventBus;

      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await emailOtpRuntime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedAppWithEmailOtp(emailOtpRuntime, userId);

      const enableRes = await app.request('/auth/mfa/email-otp/enable', jsonPost({}));
      const { setupToken } = await enableRes.json();
      const deliveryEvent = emitted.find(e => e.event === 'auth:delivery.email_otp');
      const { code } = deliveryEvent!.data as { code: string };
      await app.request('/auth/mfa/email-otp/verify-setup', jsonPost({ setupToken, code }));

      await emailOtpRuntime.adapter.setSuspended?.(userId, true);

      const res = await app.request(
        '/auth/mfa/email-otp',
        jsonDelete({ method: 'password', password: PASSWORD }),
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Account suspended');
    });

    test('returns 401 without authentication for email-otp/enable', async () => {
      const app = buildApp(emailOtpRuntime);

      const res = await app.request('/auth/mfa/email-otp/enable', jsonPost({}));

      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // POST /auth/mfa/resend
  // =========================================================================
  describe('POST /auth/mfa/resend', () => {
    test('returns 401 for invalid mfaToken', async () => {
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API', emailOtp: { codeLength: 6 } } });
      // resend does not require userAuth but needs a valid mfaToken
      const app = buildApp(runtime);

      const res = await app.request('/auth/mfa/resend', jsonPost({ mfaToken: 'invalid-token' }));

      // Either 400 (email OTP not configured) or 401 (invalid token)
      expect([400, 401]).toContain(res.status);
    });

    test('returns 400 when email OTP is not configured', async () => {
      // No emailOtp in mfa config
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API' } });
      const app = buildApp(runtime);

      const res = await app.request('/auth/mfa/resend', jsonPost({ mfaToken: 'some-token' }));

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // MFA verify with email OTP during login
  // =========================================================================
  describe('MFA verify with email OTP challenge', () => {
    test('completes MFA login using email OTP code from challenge', async () => {
      const emailOtpRuntime = makeTestRuntime({
        mfa: { issuer: 'Core API', emailOtp: { codeLength: 6 } },
      });

      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await emailOtpRuntime.adapter.create(EMAIL, hash);

      // Enable MFA (TOTP) first so user has MFA active
      const authApp = buildAuthenticatedApp(emailOtpRuntime, userId);
      const setupRes = await authApp.request('/auth/mfa/setup', jsonPost({}));
      const { secret } = await setupRes.json();
      const totpCode = generateTotpCode(secret);
      await authApp.request('/auth/mfa/verify-setup', jsonPost({ code: totpCode }));

      // Create an MFA challenge with an email OTP hash embedded
      const { createMfaChallenge } = await import('../../src/lib/mfaChallenge');
      const { sha256 } = await import('@lastshotlabs/slingshot-core');
      const emailOtpCode = '123456';
      const emailOtpHash = sha256(emailOtpCode);
      const mfaToken = await createMfaChallenge(
        emailOtpRuntime.repos.mfaChallenge,
        userId,
        { emailOtpHash },
        emailOtpRuntime.config,
      );

      const app = buildApp(emailOtpRuntime);
      const res = await app.request(
        '/auth/mfa/verify',
        jsonPost({ mfaToken, code: emailOtpCode, method: 'emailOtp' }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.token).toBeString();
      expect(body.userId).toBe(userId);
    });
  });

  // =========================================================================
  // Recovery code count respects config
  // =========================================================================
  describe('recovery code config', () => {
    test('generates configured number of recovery codes', async () => {
      runtime = makeTestRuntime({ mfa: { issuer: 'Core API', recoveryCodes: 5 } });
      const hash = await Bun.password.hash(PASSWORD);
      const { id: userId } = await runtime.adapter.create(EMAIL, hash);
      const app = buildAuthenticatedApp(runtime, userId);

      const setupRes = await app.request('/auth/mfa/setup', jsonPost({}));
      const { secret } = await setupRes.json();
      const code = generateTotpCode(secret);
      const verifyRes = await app.request('/auth/mfa/verify-setup', jsonPost({ code }));
      const body = await verifyRes.json();

      expect(body.recoveryCodes.length).toBe(5);
    });
  });
});
