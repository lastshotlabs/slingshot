import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import { describe, expect, test } from 'bun:test';
import { getAuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import { getContext } from '@lastshotlabs/slingshot-core';
import { authHeader, createTestApp } from '../setup';

const json = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// DELETE /auth/me — 501 when adapter has no deleteUser
// ---------------------------------------------------------------------------

describe('DELETE /auth/me', () => {
  test('returns 501 when adapter has no deleteUser', async () => {
    const baseAdapter = createMemoryAuthAdapter();
    const adapterWithoutDelete = { ...baseAdapter, deleteUser: undefined };
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          accountDeletion: { enabled: true },
          adapter: adapterWithoutDelete as any,
        },
      },
    );

    const reg = await app.request(
      '/auth/register',
      json({ email: 'nodelete@test.com', password: 'Password1!' }),
    );
    const { token } = (await reg.json()) as { token: string };

    const res = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Password1!' }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('deleteUser');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/set-password — 501 when adapter has no setPassword
// ---------------------------------------------------------------------------

describe('POST /auth/set-password', () => {
  test('returns 501 when adapter has no setPassword', async () => {
    const baseAdapter = createMemoryAuthAdapter();
    const adapterWithoutSetPassword = { ...baseAdapter, setPassword: undefined };
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          adapter: adapterWithoutSetPassword as any,
        },
      },
    );

    const reg = await app.request(
      '/auth/register',
      json({ email: 'nosetpw@test.com', password: 'Password1!' }),
    );
    const { token } = (await reg.json()) as { token: string };

    const res = await app.request('/auth/set-password', {
      ...json({ password: 'NewPassword1!' }),
      headers: { ...authHeader(''), 'Content-Type': 'application/json', 'x-user-token': token },
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('setPassword');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/verify-email — 429 rate limit
// ---------------------------------------------------------------------------

describe('POST /auth/verify-email', () => {
  test('returns 429 when rate limit exceeded', async () => {
    let capturedToken: string | undefined;
    const evHandler = (payload: { token: string }) => {
      capturedToken = payload.token;
    };
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          emailVerification: {
            required: false,
          },
          rateLimit: { verifyEmail: { max: 1, windowMs: 60_000 } },
        },
      },
    );
    getContext(app).bus.on('auth:delivery.email_verification', evHandler);

    await app.request(
      '/auth/register',
      json({ email: 'verifyrl@test.com', password: 'Password1!' }),
    );

    // First attempt consumes the rate limit slot
    await app.request('/auth/verify-email', json({ token: 'invalid-token-1' }));

    // Second attempt should be rate limited
    const res = await app.request(
      '/auth/verify-email',
      json({ token: capturedToken ?? 'invalid-token-2' }),
    );
    getContext(app).bus.off('auth:delivery.email_verification', evHandler);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Too many');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/resend-verification — 501 when adapter has no getEmailVerified
// ---------------------------------------------------------------------------

describe('POST /auth/resend-verification', () => {
  test('returns 501 when adapter has no getEmailVerified', async () => {
    const baseAdapter = createMemoryAuthAdapter();
    const adapterWithoutGetEmailVerified = { ...baseAdapter, getEmailVerified: undefined };
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          emailVerification: {
            required: false,
          },
          adapter: adapterWithoutGetEmailVerified as any,
        },
      },
    );

    // Register succeeds (uses the base adapter methods)
    await app.request(
      '/auth/register',
      json({ email: 'resend501@test.com', password: 'Password1!' }),
    );

    const res = await app.request(
      '/auth/resend-verification',
      json({ email: 'resend501@test.com', password: 'Password1!' }),
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('email verification');
  });

  // -------------------------------------------------------------------------
  // POST /auth/resend-verification — 429 rate limit
  // -------------------------------------------------------------------------

  test('returns 429 when rate limit exceeded', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          emailVerification: {
            required: false,
          },
          rateLimit: { resendVerification: { max: 1, windowMs: 60_000 } },
        },
      },
    );

    await app.request(
      '/auth/register',
      json({ email: 'resendrl@test.com', password: 'Password1!' }),
    );

    // First request consumes the rate limit slot
    await app.request(
      '/auth/resend-verification',
      json({ email: 'resendrl@test.com', password: 'Password1!' }),
    );

    // Second request should be rate limited
    const res = await app.request(
      '/auth/resend-verification',
      json({ email: 'resendrl@test.com', password: 'Password1!' }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Too many');
  });

  // -------------------------------------------------------------------------
  // POST /auth/resend-verification — 401 wrong password
  // -------------------------------------------------------------------------

  test('returns 401 with wrong password', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          emailVerification: {
            required: false,
          },
        },
      },
    );

    await app.request(
      '/auth/register',
      json({ email: 'resend401@test.com', password: 'Password1!' }),
    );

    const res = await app.request(
      '/auth/resend-verification',
      json({ email: 'resend401@test.com', password: 'WrongPassword!' }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid credentials');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-password — 429 rate limit
// ---------------------------------------------------------------------------

describe('POST /auth/forgot-password', () => {
  test('returns 429 when rate limit exceeded', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          passwordReset: {},
          rateLimit: { forgotPassword: { max: 1, windowMs: 60_000 } },
        },
      },
    );

    await app.request(
      '/auth/register',
      json({ email: 'forgotrl@test.com', password: 'Password1!' }),
    );

    // First attempt consumes the rate limit slot
    await app.request('/auth/forgot-password', json({ email: 'forgotrl@test.com' }));

    // Second attempt should be rate limited
    const res = await app.request('/auth/forgot-password', json({ email: 'forgotrl@test.com' }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Too many');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/reset-password — 429 rate limit
// ---------------------------------------------------------------------------

describe('POST /auth/reset-password', () => {
  test('returns 429 when rate limit exceeded', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          passwordReset: {},
          rateLimit: { resetPassword: { max: 1, windowMs: 60_000 } },
        },
      },
    );

    // First attempt consumes the rate limit slot
    await app.request(
      '/auth/reset-password',
      json({ token: 'some-token', password: 'NewPassword1!' }),
    );

    // Second attempt should be rate limited
    const res = await app.request(
      '/auth/reset-password',
      json({ token: 'some-token', password: 'NewPassword1!' }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Too many');
  });

  // -------------------------------------------------------------------------
  // POST /auth/reset-password — 501 when adapter has no setPassword
  // -------------------------------------------------------------------------

  test('returns 501 when adapter has no setPassword', async () => {
    // Build the app with a full adapter so createApp validation passes and
    // forgot-password can create a reset token. Then swap the adapter via
    // setAuthAdapter (removing setPassword) before calling reset-password,
    // so the route hits the 501 branch.
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          passwordReset: {},
        },
      },
    );

    // Register listener AFTER createTestApp so we get the bus set by the plugin
    let resolveToken!: (t: string) => void;
    const tokenPromise = new Promise<string>(r => {
      resolveToken = r;
    });
    const prHandler = (payload: { token: string }) => {
      resolveToken(payload.token);
    };
    getContext(app).bus.on('auth:delivery.password_reset', prHandler);

    await app.request(
      '/auth/register',
      json({ email: 'reset501@test.com', password: 'Password1!' }),
    );
    await app.request('/auth/forgot-password', json({ email: 'reset501@test.com' }));
    const resetToken = await tokenPromise;
    getContext(app).bus.off('auth:delivery.password_reset', prHandler);

    // Swap out setPassword so the reset-password handler returns 501
    const runtime = getAuthRuntimeContext(getContext(app).pluginState);
    const originalSetPassword = runtime.adapter.setPassword;
    runtime.adapter.setPassword = undefined;

    const res = await app.request(
      '/auth/reset-password',
      json({ token: resetToken, password: 'NewPassword1!' }),
    );

    runtime.adapter.setPassword = originalSetPassword;

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('setPassword');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/refresh — 401 when no refresh token provided
// ---------------------------------------------------------------------------

describe('POST /auth/refresh', () => {
  test('returns 401 when no refresh token is provided', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          refreshTokens: {
            accessTokenExpiry: 900,
            refreshTokenExpiry: 86400,
            rotationGraceSeconds: 2,
          },
        },
      },
    );

    // Send empty body — no cookie, no header, no body field
    const res = await app.request('/auth/refresh', json({}));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Refresh token is required');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/mfa/setup — 429 after exceeding hardcoded max of 5
// ---------------------------------------------------------------------------

describe('POST /auth/mfa/setup', () => {
  test('returns 429 when the setup bucket reaches the hardcoded max of 5', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          mfa: {},
        },
      },
    );

    const reg = await app.request(
      '/auth/register',
      json({ email: 'mfasetup429@test.com', password: 'Password1!' }),
    );
    const { token } = (await reg.json()) as { token: string };

    // Calls 1–4 should succeed; the 5th reaches the configured ceiling and is rejected.
    for (let i = 0; i < 4; i++) {
      const res = await app.request('/auth/mfa/setup', {
        method: 'POST',
        headers: authHeader(token),
      });
      expect(res.status).toBe(200);
    }

    // 5th call should be rate limited (429) because trackAttempt limits at count >= max.
    const res = await app.request('/auth/mfa/setup', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Too many MFA setup attempts');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/refresh — 429 rate limit (hardcoded max: 30)
// ---------------------------------------------------------------------------

describe('POST /auth/refresh — rate limit', () => {
  test('returns 429 on the 30th attempt (hardcoded max: 30)', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          refreshTokens: {
            accessTokenExpiry: 900,
            refreshTokenExpiry: 86400,
            rotationGraceSeconds: 2,
          },
        },
      },
    );

    // trackAttempt returns true when count > max (30), so call 31 triggers 429.
    // Rate limit fires before token lookup, so any token value works.
    for (let i = 0; i < 30; i++) {
      await app.request('/auth/refresh', json({ refreshToken: 'fake-token' }));
    }
    const res = await app.request('/auth/refresh', json({ refreshToken: 'fake-token' }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Too many refresh attempts');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-password — fire-and-forget error handler (line 456)
// ---------------------------------------------------------------------------

describe('POST /auth/forgot-password — fire-and-forget', () => {
  test('returns 200 immediately (fire-and-forget delivery)', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          passwordReset: {},
        },
      },
    );

    await app.request(
      '/auth/register',
      json({ email: 'fireforget@test.com', password: 'Password1!' }),
    );
    const res = await app.request('/auth/forgot-password', json({ email: 'fireforget@test.com' }));
    expect(res.status).toBe(200);
  });
});
