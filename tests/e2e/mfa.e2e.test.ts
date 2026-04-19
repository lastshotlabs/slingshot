/**
 * E2E tests for TOTP MFA flows.
 *
 * Uses the `otpauth` package (same as integration tests) to generate valid TOTP codes
 * from the secret returned by /auth/mfa/setup.
 *
 * Key endpoints (confirmed from integration tests):
 *   POST /auth/mfa/setup         → { secret, uri }
 *   POST /auth/mfa/verify-setup  → { ok: true, recoveryCodes: string[] }
 *   DELETE /auth/mfa             → 200 (with { code })
 *   GET  /auth/mfa/methods       → { methods: string[] }
 *   POST /auth/mfa/verify        → { token, userId }
 *   POST /auth/mfa/recovery-codes → { recoveryCodes: string[] }
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as OTPAuth from 'otpauth';
import { type E2EServerHandle, createTestHttpServer } from '../setup-e2e';

let handle: E2EServerHandle;

beforeAll(async () => {
  handle = await createTestHttpServer(
    {},
    {
      auth: {
        mfa: {
          issuer: 'TestApp',
          emailOtp: {},
        },
      },
    },
  );
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

function generateTotpCode(secret: string): string {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    issuer: 'TestApp',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate();
}

async function registerUser(email = 'mfa-e2e@example.com', password = 'Password123!') {
  const res = await post('/auth/register', { email, password });
  return res.json() as Promise<{ token: string; userId: string }>;
}

async function setupTotp(token: string) {
  const setupRes = await fetch(`${handle.baseUrl}/auth/mfa/setup`, {
    method: 'POST',
    headers: { 'x-user-token': token },
  });
  expect(setupRes.status).toBe(200);
  return setupRes.json() as Promise<{ secret: string; uri: string }>;
}

async function enableTotp(token: string, secret: string) {
  const code = generateTotpCode(secret);
  const verifyRes = await post('/auth/mfa/verify-setup', { code }, { 'x-user-token': token });
  expect(verifyRes.status).toBe(200);
  return verifyRes.json() as Promise<{ message: string; recoveryCodes: string[] }>;
}

// ---------------------------------------------------------------------------
// TOTP Setup
// ---------------------------------------------------------------------------

describe('POST /auth/mfa/setup — E2E', () => {
  test('returns secret (base32) and otpauth URI', async () => {
    const { token } = await registerUser('mfa-setup@example.com');

    const res = await fetch(`${handle.baseUrl}/auth/mfa/setup`, {
      method: 'POST',
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secret).toBeString();
    expect(body.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(body.uri).toMatch(/^otpauth:\/\/totp\//);
  });

  test('requires authentication — returns 401 without token', async () => {
    const res = await fetch(`${handle.baseUrl}/auth/mfa/setup`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// TOTP Verify Setup
// ---------------------------------------------------------------------------

describe('POST /auth/mfa/verify-setup — E2E', () => {
  test('enables MFA and returns 10 recovery codes', async () => {
    const { token } = await registerUser('mfa-verify@example.com');
    const { secret } = await setupTotp(token);

    const code = generateTotpCode(secret);
    const res = await post('/auth/mfa/verify-setup', { code }, { 'x-user-token': token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recoveryCodes).toBeArray();
    expect(body.recoveryCodes).toHaveLength(10);
    // Each recovery code should be a non-empty string
    for (const code of body.recoveryCodes) {
      expect(code).toBeString();
      expect(code.length).toBeGreaterThan(0);
    }
  });

  test('rejects invalid TOTP code with 401', async () => {
    const { token } = await registerUser('mfa-badcode@example.com');
    await setupTotp(token);

    const res = await post('/auth/mfa/verify-setup', { code: '000000' }, { 'x-user-token': token });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// MFA Login Flow
// ---------------------------------------------------------------------------

describe('MFA login flow — E2E', () => {
  test('login returns mfaRequired when TOTP enabled', async () => {
    const { token } = await registerUser('mfa-login@example.com');
    const { secret } = await setupTotp(token);
    await enableTotp(token, secret);

    // Re-register to restore user in fresh store state
    const { token: freshToken } = await registerUser('mfa-login2@example.com');
    const { secret: freshSecret } = await setupTotp(freshToken);
    await enableTotp(freshToken, freshSecret);

    const loginRes = await post('/auth/login', {
      email: 'mfa-login2@example.com',
      password: 'Password123!',
    });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.mfaRequired).toBe(true);
    expect(loginBody.mfaToken).toBeString();
    expect(loginBody.mfaMethods).toContain('totp');
    expect(loginBody.token).toBe('');
  });

  test('full TOTP login flow: login → mfa/verify → /auth/me', async () => {
    const { token } = await registerUser('mfa-fullflow@example.com');
    const { secret } = await setupTotp(token);
    await enableTotp(token, secret);

    const loginRes = await post('/auth/login', {
      email: 'mfa-fullflow@example.com',
      password: 'Password123!',
    });
    const { mfaToken } = await loginRes.json();

    const code = generateTotpCode(secret);
    const verifyRes = await post('/auth/mfa/verify', { mfaToken, code });
    expect(verifyRes.status).toBe(200);
    const { token: sessionToken, userId } = await verifyRes.json();
    expect(sessionToken).toBeString();
    expect(userId).toBeString();

    const meRes = await fetch(`${handle.baseUrl}/auth/me`, {
      headers: { 'x-user-token': sessionToken },
    });
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me.userId).toBe(userId);
  });

  test('recovery code can be used as MFA fallback', async () => {
    const { token } = await registerUser('mfa-recovery@example.com');
    const { secret } = await setupTotp(token);
    const { recoveryCodes } = await enableTotp(token, secret);

    const loginRes = await post('/auth/login', {
      email: 'mfa-recovery@example.com',
      password: 'Password123!',
    });
    const { mfaToken } = await loginRes.json();

    const verifyRes = await post('/auth/mfa/verify', {
      mfaToken,
      code: recoveryCodes[0],
    });
    expect(verifyRes.status).toBe(200);
    const { token: sessionToken } = await verifyRes.json();
    expect(sessionToken).toBeString();
  });

  test('invalid mfaToken returns 401', async () => {
    const res = await post('/auth/mfa/verify', {
      mfaToken: 'not-a-real-mfa-token',
      code: '123456',
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/mfa/methods
// ---------------------------------------------------------------------------

describe('GET /auth/mfa/methods — E2E', () => {
  test('returns enabled methods after TOTP setup', async () => {
    const { token } = await registerUser('mfa-methods@example.com');
    const { secret } = await setupTotp(token);
    await enableTotp(token, secret);

    const res = await fetch(`${handle.baseUrl}/auth/mfa/methods`, {
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.methods).toContain('totp');
  });

  test('returns empty array for user without MFA', async () => {
    const { token } = await registerUser('mfa-nomfa@example.com');

    const res = await fetch(`${handle.baseUrl}/auth/mfa/methods`, {
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.methods).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Disable MFA
// ---------------------------------------------------------------------------

describe('DELETE /auth/mfa — E2E', () => {
  test('disables TOTP — login no longer requires MFA', async () => {
    const { token } = await registerUser('mfa-disable@example.com');
    const { secret } = await setupTotp(token);
    await enableTotp(token, secret);

    const code = generateTotpCode(secret);
    const delRes = await fetch(`${handle.baseUrl}/auth/mfa`, {
      method: 'DELETE',
      headers: { 'x-user-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(delRes.status).toBe(200);

    // Login should return a full token, not mfaRequired
    const loginRes = await post('/auth/login', {
      email: 'mfa-disable@example.com',
      password: 'Password123!',
    });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.mfaRequired).toBeUndefined();
    expect(loginBody.token).toBeString();
    expect(loginBody.token.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Recovery Codes Regeneration
// ---------------------------------------------------------------------------

describe('POST /auth/mfa/recovery-codes — E2E', () => {
  test('regenerates recovery codes with valid TOTP code', async () => {
    const { token } = await registerUser('mfa-regen@example.com');
    const { secret } = await setupTotp(token);
    const { recoveryCodes: originalCodes } = await enableTotp(token, secret);

    const code = generateTotpCode(secret);
    const res = await post('/auth/mfa/recovery-codes', { code }, { 'x-user-token': token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recoveryCodes).toBeArray();
    expect(body.recoveryCodes).toHaveLength(10);
    // New codes are different from original
    expect(body.recoveryCodes).not.toEqual(originalCodes);
  });
});
