import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import * as OTPAuth from 'otpauth';
import { getContext } from '@lastshotlabs/slingshot-core';
import { authHeader, createTestApp } from '../setup';

let app: OpenAPIHono<any>;
const emailOtpCodes: { email: string; code: string }[] = [];
const getBus = (targetApp: object) => getContext(targetApp).bus;

// Capture email OTP delivery events into the shared array
const emailOtpHandler = (payload: { email: string; code: string }) => {
  emailOtpCodes.push({ email: payload.email, code: payload.code });
};

beforeEach(async () => {
  emailOtpCodes.length = 0;
  app = await createTestApp(
    {},
    {
      auth: {
        enabled: true,
        roles: ['admin', 'user'],
        defaultRole: 'user',
        mfa: {
          issuer: 'TestApp',
          emailOtp: {},
        },
      },
    },
  );
  getBus(app).off('auth:delivery.email_otp', emailOtpHandler);
  getBus(app).on('auth:delivery.email_otp', emailOtpHandler);
});

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function generateTotpCode(secret: string): string {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    issuer: 'TestApp',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate();
}

async function registerUser(email = 'mfa@example.com', password = 'password123') {
  const res = await app.request('/auth/register', json({ email, password }));
  return res.json() as Promise<{ token: string; userId: string }>;
}

async function registerAndSetupMfa(email = 'mfa@example.com', password = 'password123') {
  const { token, userId } = await registerUser(email, password);

  // Setup MFA
  const setupRes = await app.request('/auth/mfa/setup', {
    method: 'POST',
    headers: authHeader(token),
  });
  const { secret, uri } = await setupRes.json();

  // Verify setup with valid TOTP code
  const code = generateTotpCode(secret);
  const verifyRes = await app.request('/auth/mfa/verify-setup', {
    method: 'POST',
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const { recoveryCodes } = await verifyRes.json();

  return { token, userId, secret, uri, recoveryCodes };
}

// ---------------------------------------------------------------------------
// MFA Setup
// ---------------------------------------------------------------------------

describe('POST /auth/mfa/setup', () => {
  test('returns secret and URI', async () => {
    const { token } = await registerUser();

    const res = await app.request('/auth/mfa/setup', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secret).toBeString();
    expect(body.secret).toMatch(/^[A-Z2-7]+=*$/); // base32
    expect(body.uri).toMatch(/^otpauth:\/\/totp\//);
  });
});

// ---------------------------------------------------------------------------
// MFA Verify Setup
// ---------------------------------------------------------------------------

describe('POST /auth/mfa/verify-setup', () => {
  test('enables MFA and returns recovery codes', async () => {
    const { token } = await registerUser();

    const setupRes = await app.request('/auth/mfa/setup', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { secret } = await setupRes.json();

    const code = generateTotpCode(secret);
    const res = await app.request('/auth/mfa/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recoveryCodes).toBeArray();
    expect(body.recoveryCodes).toHaveLength(10);
  });

  test('rejects invalid code', async () => {
    const { token } = await registerUser();

    await app.request('/auth/mfa/setup', {
      method: 'POST',
      headers: authHeader(token),
    });

    const res = await app.request('/auth/mfa/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// MFA Login Flow
// ---------------------------------------------------------------------------

describe('MFA login flow', () => {
  test('login returns mfaRequired when MFA enabled', async () => {
    await registerAndSetupMfa();

    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    expect(loginRes.status).toBe(200);
    const body = await loginRes.json();
    expect(body.mfaRequired).toBe(true);
    expect(body.mfaToken).toBeString();
    expect(body.mfaMethods).toContain('totp');
    expect(body.token).toBe('');
  });

  test('verify completes login with valid TOTP', async () => {
    const { secret } = await registerAndSetupMfa();

    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    const { mfaToken } = await loginRes.json();

    const code = generateTotpCode(secret);
    const verifyRes = await app.request('/auth/mfa/verify', json({ mfaToken, code }));
    expect(verifyRes.status).toBe(200);
    const { token, userId } = await verifyRes.json();
    expect(token).toBeString();
    expect(userId).toBeString();

    // Verify the session works
    const meRes = await app.request('/auth/me', { headers: authHeader(token) });
    expect(meRes.status).toBe(200);
  });

  test('verify accepts recovery code as fallback', async () => {
    const { recoveryCodes } = await registerAndSetupMfa();

    // Login to get MFA challenge
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    const { mfaToken } = await loginRes.json();

    // Use recovery code
    const verifyRes = await app.request(
      '/auth/mfa/verify',
      json({ mfaToken, code: recoveryCodes[0] }),
    );
    expect(verifyRes.status).toBe(200);
    const { token } = await verifyRes.json();
    expect(token).toBeString();

    // Same recovery code should not work again (need a new login + mfaToken)
    const loginRes2 = await app.request(
      '/auth/login',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    const { mfaToken: mfaToken2 } = await loginRes2.json();

    const verifyRes2 = await app.request(
      '/auth/mfa/verify',
      json({ mfaToken: mfaToken2, code: recoveryCodes[0] }),
    );
    expect(verifyRes2.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Disable MFA
// ---------------------------------------------------------------------------

describe('DELETE /auth/mfa', () => {
  test('disables MFA', async () => {
    const { token, secret } = await registerAndSetupMfa();

    const code = generateTotpCode(secret);
    const delRes = await app.request('/auth/mfa', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(delRes.status).toBe(200);

    // Login should no longer require MFA
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    expect(loginRes.status).toBe(200);
    const body = await loginRes.json();
    expect(body.mfaRequired).toBeUndefined();
    expect(body.token).toBeString();
    expect(body.token.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// MFA Verify — method parameter
// ---------------------------------------------------------------------------

describe('POST /auth/mfa/verify — method param', () => {
  test('returns error when neither code nor webauthnResponse provided', async () => {
    await registerAndSetupMfa();
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    const { mfaToken } = await loginRes.json();

    const res = await app.request('/auth/mfa/verify', json({ mfaToken }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('required');
  });

  test("verify with method: 'totp' succeeds", async () => {
    const { secret } = await registerAndSetupMfa();
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    const { mfaToken } = await loginRes.json();

    const code = generateTotpCode(secret);
    const res = await app.request('/auth/mfa/verify', json({ mfaToken, code, method: 'totp' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
  });

  test('verify with invalid MFA token returns 401', async () => {
    const res = await app.request(
      '/auth/mfa/verify',
      json({ mfaToken: 'invalid-token', code: '123456' }),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Regenerate Recovery Codes
// ---------------------------------------------------------------------------

describe('POST /auth/mfa/recovery-codes', () => {
  test('regenerates recovery codes with valid TOTP', async () => {
    const { token, secret } = await registerAndSetupMfa();

    const code = generateTotpCode(secret);
    const res = await app.request('/auth/mfa/recovery-codes', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recoveryCodes).toBeArray();
    expect(body.recoveryCodes).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/mfa/methods
// ---------------------------------------------------------------------------

describe('GET /auth/mfa/methods', () => {
  test('returns enabled methods', async () => {
    const { token } = await registerAndSetupMfa();

    const res = await app.request('/auth/mfa/methods', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.methods).toContain('totp');
  });

  test('returns empty for user without MFA', async () => {
    const { token } = await registerUser('nomfa@example.com');

    const res = await app.request('/auth/mfa/methods', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.methods).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Email OTP — enable, verify-setup, disable (route-level)
// ---------------------------------------------------------------------------

describe('Email OTP routes', () => {
  test('POST /auth/mfa/email-otp/enable sends code and returns setupToken', async () => {
    const { token } = await registerUser('eotp@example.com');

    const res = await app.request('/auth/mfa/email-otp/enable', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.setupToken).toBeString();
    expect(body.ok).toBe(true);
    expect(emailOtpCodes).toHaveLength(1);
    expect(emailOtpCodes[0].email).toBe('eotp@example.com');
  });

  test('POST /auth/mfa/email-otp/verify-setup enables email OTP', async () => {
    const { token } = await registerUser('eotpv@example.com');

    // Enable
    const enableRes = await app.request('/auth/mfa/email-otp/enable', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { setupToken } = await enableRes.json();
    const code = emailOtpCodes[0].code;

    // Verify setup
    const res = await app.request('/auth/mfa/email-otp/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken, code }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recoveryCodes).toBeArray();
  });

  test('DELETE /auth/mfa/email-otp disables email OTP with password', async () => {
    const { token } = await registerUser('eotpd@example.com');

    // Enable email OTP
    const enableRes = await app.request('/auth/mfa/email-otp/enable', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { setupToken } = await enableRes.json();
    const code = emailOtpCodes[0].code;
    await app.request('/auth/mfa/email-otp/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken, code }),
    });

    // Disable with password
    const res = await app.request('/auth/mfa/email-otp', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'password123' }),
    });
    expect(res.status).toBe(200);

    // Methods should no longer include emailOtp
    const methodsRes = await app.request('/auth/mfa/methods', { headers: authHeader(token) });
    const methods = await methodsRes.json();
    expect(methods.methods).not.toContain('emailOtp');
  });
});

// ---------------------------------------------------------------------------
// Email OTP login flow
// ---------------------------------------------------------------------------

describe('Email OTP login flow', () => {
  test('login auto-sends email OTP when emailOtp method enabled', async () => {
    const { token } = await registerUser('eotplogin@example.com');

    // Enable email OTP
    const enableRes = await app.request('/auth/mfa/email-otp/enable', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { setupToken } = await enableRes.json();
    const setupCode = emailOtpCodes[0].code;
    await app.request('/auth/mfa/email-otp/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken, code: setupCode }),
    });
    emailOtpCodes.length = 0;

    // Login should return mfaRequired and auto-send email OTP
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'eotplogin@example.com', password: 'password123' }),
    );
    const loginBody = await loginRes.json();
    expect(loginBody.mfaRequired).toBe(true);
    expect(loginBody.mfaMethods).toContain('emailOtp');
    // email_otp delivery event should have been emitted
    expect(emailOtpCodes).toHaveLength(1);

    // Verify with email OTP code
    const verifyRes = await app.request(
      '/auth/mfa/verify',
      json({
        mfaToken: loginBody.mfaToken,
        code: emailOtpCodes[0].code,
        method: 'emailOtp',
      }),
    );
    expect(verifyRes.status).toBe(200);
    const { token: sessionToken } = await verifyRes.json();
    expect(sessionToken).toBeString();
  });

  test('auto-detect picks email OTP first when hash present', async () => {
    const { token } = await registerUser('eotpauto@example.com');

    // Enable email OTP
    const enableRes = await app.request('/auth/mfa/email-otp/enable', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { setupToken } = await enableRes.json();
    await app.request('/auth/mfa/email-otp/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken, code: emailOtpCodes[0].code }),
    });
    emailOtpCodes.length = 0;

    // Login
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'eotpauto@example.com', password: 'password123' }),
    );
    const { mfaToken } = await loginRes.json();

    // Verify without specifying method — should auto-detect email OTP
    const verifyRes = await app.request(
      '/auth/mfa/verify',
      json({
        mfaToken,
        code: emailOtpCodes[0].code,
      }),
    );
    expect(verifyRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Resend Email OTP
// ---------------------------------------------------------------------------

describe('POST /auth/mfa/resend', () => {
  test('resends email OTP code', async () => {
    const { token } = await registerUser('resend@example.com');

    // Enable email OTP
    const enableRes = await app.request('/auth/mfa/email-otp/enable', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { setupToken } = await enableRes.json();
    await app.request('/auth/mfa/email-otp/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken, code: emailOtpCodes[0].code }),
    });
    emailOtpCodes.length = 0;

    // Login to get MFA token
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'resend@example.com', password: 'password123' }),
    );
    const { mfaToken } = await loginRes.json();
    emailOtpCodes.length = 0;

    // Resend
    const resendRes = await app.request('/auth/mfa/resend', json({ mfaToken }));
    expect(resendRes.status).toBe(200);
    expect(emailOtpCodes).toHaveLength(1);

    // Verify with new code
    const verifyRes = await app.request(
      '/auth/mfa/verify',
      json({
        mfaToken,
        code: emailOtpCodes[0].code,
        method: 'emailOtp',
      }),
    );
    expect(verifyRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// MFA Rate Limiting
// ---------------------------------------------------------------------------

describe('MFA verify rate limiting', () => {
  test('returns 429 after exceeding MFA verify attempts', async () => {
    // Use a dedicated app with rateLimit:{} so the route falls back to its built-in
    // default of max:10, instead of the authPlugin test-helper default of max:1000.
    const rlApp = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['admin', 'user'],
          defaultRole: 'user',
          mfa: { issuer: 'TestApp', emailOtp: {} },
          rateLimit: {},
        },
      },
    );

    const regRes = await rlApp.request(
      '/auth/register',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    const { token } = await regRes.json();
    const setupRes = await rlApp.request('/auth/mfa/setup', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { secret } = await setupRes.json();
    await rlApp.request('/auth/mfa/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: generateTotpCode(secret) }),
    });

    const loginRes = await rlApp.request(
      '/auth/login',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    const { mfaToken } = await loginRes.json();

    // Default limit: 10 per 15 min. Fire 10 attempts to reach the limit.
    for (let i = 0; i < 10; i++) {
      await rlApp.request('/auth/mfa/verify', json({ mfaToken, code: '000000' }));
    }

    // 11th attempt should be rate-limited (count 11 > max 10)
    const code = generateTotpCode(secret);
    const res = await rlApp.request('/auth/mfa/verify', json({ mfaToken, code }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Too many');
  });
});

describe('MFA resend rate limiting', () => {
  test('returns 429 after exceeding MFA resend attempts', async () => {
    // Use a dedicated app with rateLimit:{} so the route falls back to its built-in
    // default of max:5, instead of the authPlugin test-helper default of max:1000.
    const rlApp = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['admin', 'user'],
          defaultRole: 'user',
          mfa: { issuer: 'TestApp', emailOtp: {} },
          rateLimit: {},
        },
      },
    );

    const regRes = await rlApp.request(
      '/auth/register',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    const { token } = await regRes.json();
    const setupRes = await rlApp.request('/auth/mfa/setup', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { secret } = await setupRes.json();
    await rlApp.request('/auth/mfa/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: generateTotpCode(secret) }),
    });

    const loginRes = await rlApp.request(
      '/auth/login',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    const { mfaToken } = await loginRes.json();

    // Default limit: 5 per minute. Fire 5 requests to reach the limit.
    for (let i = 0; i < 5; i++) {
      await rlApp.request('/auth/mfa/resend', json({ mfaToken }));
    }

    // 6th attempt should be rate-limited (count 6 > max 5)
    const res = await rlApp.request('/auth/mfa/resend', json({ mfaToken }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Too many');
  });
});
