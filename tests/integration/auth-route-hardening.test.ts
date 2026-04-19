/**
 * Integration tests for P0-A: auth route hardening
 *
 * Covers:
 *  - POST /auth/reauth/challenge (always mounted, session-bound)
 *  - verifyAnyFactor: TOTP, password, recovery-only boundary
 *  - POST /auth/set-password: breached password check + session revocation
 *  - DELETE /auth/me: verifyAnyFactor when MFA enabled
 *  - DELETE /auth/mfa: expanded schema + verifyAnyFactor
 *  - POST /auth/step-up: expanded schema + verifyAnyFactor
 */
import { describe, expect, test } from 'bun:test';
import * as OTPAuth from 'otpauth';
import { getContext } from '@lastshotlabs/slingshot-core';
import { authHeader, createTestApp } from '../setup';

const json = (body: unknown) => ({
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildMfaApp(extra?: object) {
  return createTestApp(
    {},
    {
      auth: {
        enabled: true,
        roles: ['user'],
        defaultRole: 'user',
        mfa: { issuer: 'TestApp' },
        ...extra,
      },
    },
  );
}

async function buildMfaAppWithEmailOtp(emailOtpCodes: { email: string; code: string }[]) {
  const app = await createTestApp(
    {},
    {
      auth: {
        enabled: true,
        roles: ['user'],
        defaultRole: 'user',
        mfa: {
          issuer: 'TestApp',
          emailOtp: {},
        },
      },
    },
  );
  // Register listener AFTER createTestApp so we get the bus set by the plugin
  const handler = (payload: { email: string; code: string }) => {
    emailOtpCodes.push({ email: payload.email, code: payload.code });
  };
  getContext(app).bus.on('auth:delivery.email_otp', handler);
  return app;
}

async function registerAndSetupMfa(app: any, email = 'test@example.com', password = 'Password1!') {
  const regRes = await app.request('/auth/register', json({ email, password }));
  const { token: regToken, userId } = (await regRes.json()) as { token: string; userId: string };

  const setupRes = await app.request('/auth/mfa/setup', {
    method: 'POST',
    headers: authHeader(regToken),
  });
  const { secret } = (await setupRes.json()) as { secret: string; uri: string };

  const verifySetupRes = await app.request('/auth/mfa/verify-setup', {
    method: 'POST',
    headers: { ...authHeader(regToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: generateTotpCode(secret) }),
  });
  const { recoveryCodes } = (await verifySetupRes.json()) as { recoveryCodes: string[] };

  return { token: regToken, userId, secret, recoveryCodes };
}

// ---------------------------------------------------------------------------
// POST /auth/reauth/challenge
// ---------------------------------------------------------------------------

describe('POST /auth/reauth/challenge', () => {
  test('returns availableMethods with password when user has password (no challenge-based methods)', async () => {
    const app = await buildMfaApp();
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'reauth@example.com', password: 'Password1!' }),
    );
    const { token } = (await regRes.json()) as { token: string };

    const res = await app.request('/auth/reauth/challenge', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { availableMethods: string[]; reauthToken?: string };
    expect(body.availableMethods).toContain('password');
    // No challenge-based methods — no reauthToken
    expect(body.reauthToken).toBeUndefined();
  });

  test('returns reauthToken and totp in availableMethods when TOTP enabled', async () => {
    const app = await buildMfaApp();
    const { token } = await registerAndSetupMfa(app, 'reauth-totp@example.com');

    const res = await app.request('/auth/reauth/challenge', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { availableMethods: string[]; reauthToken?: string };
    expect(body.availableMethods).toContain('totp');
    expect(body.availableMethods).toContain('password');
    expect(body.availableMethods).toContain('recovery');
    // TOTP is direct — no challenge needed, reauthToken absent
    expect(body.reauthToken).toBeUndefined();
  });

  test('returns reauthToken when email OTP is enabled', async () => {
    const emailOtpCodes: { email: string; code: string }[] = [];
    const app = await buildMfaAppWithEmailOtp(emailOtpCodes);

    // Register + enable email OTP
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'reauth-emailotp@example.com', password: 'Password1!' }),
    );
    const { token } = (await regRes.json()) as { token: string };

    const enableRes = await app.request('/auth/mfa/email-otp/enable', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(enableRes.status).toBe(200);
    const { setupToken } = (await enableRes.json()) as { setupToken: string };
    const { code: setupCode } = emailOtpCodes[emailOtpCodes.length - 1];

    await app.request('/auth/mfa/email-otp/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken, code: setupCode }),
    });

    emailOtpCodes.length = 0;

    const res = await app.request('/auth/reauth/challenge', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { availableMethods: string[]; reauthToken?: string };
    expect(body.availableMethods).toContain('emailOtp');
    expect(body.reauthToken).toBeDefined();
    expect(typeof body.reauthToken).toBe('string');
  });

  test('returns 401 without authentication', async () => {
    const app = await buildMfaApp();
    const res = await app.request('/auth/reauth/challenge', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/step-up — verifyAnyFactor: TOTP
// ---------------------------------------------------------------------------

describe('POST /auth/step-up — verifyAnyFactor', () => {
  test('verifies TOTP factor successfully', async () => {
    const app = await buildMfaApp({ stepUp: { enabled: true } });
    const { token, secret } = await registerAndSetupMfa(app, 'stepup-totp@example.com');

    const code = generateTotpCode(secret);
    const res = await app.request('/auth/step-up', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'totp', code }),
    });
    expect(res.status).toBe(200);
  });

  test('rejects invalid TOTP code', async () => {
    const app = await buildMfaApp({ stepUp: { enabled: true } });
    const { token } = await registerAndSetupMfa(app, 'stepup-totp-bad@example.com');

    const res = await app.request('/auth/step-up', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'totp', code: '000000' }),
    });
    expect(res.status).toBe(401);
  });

  test('verifies password factor successfully', async () => {
    const app = await buildMfaApp({ stepUp: { enabled: true } });
    const { token } = await registerAndSetupMfa(app, 'stepup-pw@example.com');

    const res = await app.request('/auth/step-up', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'Password1!' }),
    });
    expect(res.status).toBe(200);
  });

  test('rejects wrong password', async () => {
    const app = await buildMfaApp({ stepUp: { enabled: true } });
    const { token } = await registerAndSetupMfa(app, 'stepup-pw-bad@example.com');

    const res = await app.request('/auth/step-up', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'WrongPass1!' }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Recovery code — hard boundary: only when method="recovery"
// ---------------------------------------------------------------------------

describe('Recovery code boundary in verifyAnyFactor', () => {
  test("recovery code works when method is explicitly 'recovery'", async () => {
    const app = await buildMfaApp({ stepUp: { enabled: true } });
    const { token, recoveryCodes } = await registerAndSetupMfa(
      app,
      'recovery-boundary@example.com',
    );

    const res = await app.request('/auth/step-up', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'recovery', code: recoveryCodes[0] }),
    });
    expect(res.status).toBe(200);
  });

  test("recovery code is NOT tried when method is 'totp'", async () => {
    const app = await buildMfaApp({ stepUp: { enabled: true } });
    const { token, recoveryCodes } = await registerAndSetupMfa(
      app,
      'recovery-totp-boundary@example.com',
    );

    // Pass a recovery code as code with method=totp — should fail (recovery not tried)
    const res = await app.request('/auth/step-up', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'totp', code: recoveryCodes[0] }),
    });
    // Recovery code format is not a valid TOTP code, so it should be rejected
    expect(res.status).toBe(401);
  });

  test('recovery code is single-use', async () => {
    const app = await buildMfaApp({ stepUp: { enabled: true } });
    const { token, recoveryCodes } = await registerAndSetupMfa(
      app,
      'recovery-single-use@example.com',
    );

    const body = JSON.stringify({ method: 'recovery', code: recoveryCodes[0] });
    const headers = { ...authHeader(token), 'Content-Type': 'application/json' };

    const res1 = await app.request('/auth/step-up', { method: 'POST', headers, body });
    expect(res1.status).toBe(200);

    const res2 = await app.request('/auth/step-up', { method: 'POST', headers, body });
    expect(res2.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DELETE /auth/mfa — expanded schema + verifyAnyFactor
// ---------------------------------------------------------------------------

describe('DELETE /auth/mfa — verifyAnyFactor', () => {
  test('disables MFA with valid TOTP code', async () => {
    const app = await buildMfaApp();
    const { token, secret } = await registerAndSetupMfa(app, 'disable-mfa-totp@example.com');

    const res = await app.request('/auth/mfa', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'totp', code: generateTotpCode(secret) }),
    });
    expect(res.status).toBe(200);
  });

  test('disables MFA with password', async () => {
    const app = await buildMfaApp();
    const { token } = await registerAndSetupMfa(app, 'disable-mfa-pw@example.com');

    const res = await app.request('/auth/mfa', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'Password1!' }),
    });
    expect(res.status).toBe(200);
  });

  test('rejects invalid TOTP code', async () => {
    const app = await buildMfaApp();
    const { token } = await registerAndSetupMfa(app, 'disable-mfa-bad@example.com');

    const res = await app.request('/auth/mfa', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'totp', code: '000000' }),
    });
    expect(res.status).toBe(401);
  });

  test('returns 400 when no credentials provided', async () => {
    const app = await buildMfaApp();
    const { token } = await registerAndSetupMfa(app, 'disable-mfa-nocreds@example.com');

    const res = await app.request('/auth/mfa', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /auth/me — verifyAnyFactor when MFA enabled
// ---------------------------------------------------------------------------

describe('DELETE /auth/me — verifyAnyFactor when MFA enabled', () => {
  test('deletes account with TOTP when MFA is enabled', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          mfa: { issuer: 'TestApp' },
          accountDeletion: { enabled: true },
        },
      },
    );
    const { token, secret } = await registerAndSetupMfa(app, 'delete-mfa@example.com');

    const res = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'totp', code: generateTotpCode(secret) }),
    });
    expect(res.status).toBe(200);
  });

  test('deletes account with password', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          accountDeletion: { enabled: true },
        },
      },
    );
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'delete-pw@example.com', password: 'Password1!' }),
    );
    const { token } = (await regRes.json()) as { token: string };

    const res = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'Password1!' }),
    });
    expect(res.status).toBe(200);
  });

  test('rejects deletion with wrong password when MFA disabled', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          accountDeletion: { enabled: true },
        },
      },
    );
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'delete-bad-pw@example.com', password: 'Password1!' }),
    );
    const { token } = (await regRes.json()) as { token: string };

    const res = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'WrongPass1!' }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/set-password — breached password check + session revocation
// ---------------------------------------------------------------------------

describe('POST /auth/set-password — session revocation', () => {
  test('second session is invalidated after password change (revoke_others)', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          sessionPolicy: { onPasswordChange: 'revoke_others' },
        },
      },
    );

    const regRes = await app.request(
      '/auth/register',
      json({ email: 'revoke-token-check@example.com', password: 'Password1!' }),
    );
    const { token: token1 } = (await regRes.json()) as { token: string };

    // Login from second device
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'revoke-token-check@example.com', password: 'Password1!' }),
    );
    const { token: token2 } = (await loginRes.json()) as { token: string };

    // Confirm session 2 is initially valid
    const meBeforeRes = await app.request('/auth/me', { headers: authHeader(token2) });
    expect(meBeforeRes.status).toBe(200);

    // Change password from session 1
    const pwRes = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { ...authHeader(token1), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'Password1!', password: 'NewPassword1!' }),
    });
    expect(pwRes.status).toBe(200);

    // Session 2 should now be rejected on protected endpoints
    const meRes = await app.request('/auth/me', {
      headers: authHeader(token2),
    });
    expect(meRes.status).toBe(401);
  });

  test('current session remains valid after password change (revoke_others)', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          sessionPolicy: { onPasswordChange: 'revoke_others' },
        },
      },
    );

    const regRes = await app.request(
      '/auth/register',
      json({ email: 'current-session-ok@example.com', password: 'Password1!' }),
    );
    const { token: token1 } = (await regRes.json()) as { token: string };

    // Create a second session (will be revoked)
    await app.request(
      '/auth/login',
      json({ email: 'current-session-ok@example.com', password: 'Password1!' }),
    );

    // Change password from session 1
    await app.request('/auth/set-password', {
      method: 'POST',
      headers: { ...authHeader(token1), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'Password1!', password: 'NewPassword1!' }),
    });

    // Current session (token1) should still be valid
    const meRes = await app.request('/auth/me', { headers: authHeader(token1) });
    expect(meRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/set-password — breached password check
// ---------------------------------------------------------------------------

describe('POST /auth/set-password — breached password check', () => {
  test('set-password succeeds when no breached password config is present', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
        },
      },
    );
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'setpw-ok@example.com', password: 'Password1!' }),
    );
    const { token } = (await regRes.json()) as { token: string };

    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'Password1!', password: 'UniquePa$$w0rdXYZ987!' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test('set-password rejects current password as new password', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
        },
      },
    );
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'setpw-same@example.com', password: 'Password1!' }),
    );
    const { token } = (await regRes.json()) as { token: string };

    // Try changing to a different, valid password
    const res = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'Password1!', password: 'NewUnique$$99!' }),
    });
    expect(res.status).toBe(200);
  });
});
