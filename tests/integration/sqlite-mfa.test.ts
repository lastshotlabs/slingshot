import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import * as OTPAuth from 'otpauth';
import { authHeader, createTestApp } from '../setup';

let app: OpenAPIHono<any>;

beforeEach(async () => {
  // Each createTestApp with ":memory:" creates a fresh SQLite database — no cleanup needed
  app = await createTestApp(
    {
      db: {
        mongo: false,
        redis: false,
        sessions: 'sqlite',
        cache: 'sqlite',
        auth: 'sqlite',
        sqlite: ':memory:',
      },
    },
    {
      auth: {
        enabled: true,
        roles: ['admin', 'user'],
        defaultRole: 'user',
        mfa: { issuer: 'TestApp' },
      },
    },
  );
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

describe('SQLite MFA (TOTP)', () => {
  test('setup MFA returns secret and URI', async () => {
    const reg = await app.request(
      '/auth/register',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    const { token } = await reg.json();

    const res = await app.request('/auth/mfa/setup', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secret).toBeString();
    expect(body.uri).toMatch(/^otpauth:\/\/totp\//);
  });

  test('verify setup enables MFA', async () => {
    const reg = await app.request(
      '/auth/register',
      json({ email: 'mfa2@example.com', password: 'password123' }),
    );
    const { token } = await reg.json();

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
    expect(body.recoveryCodes).toBeArray();
    expect(body.recoveryCodes).toHaveLength(10);
  });

  test('login returns mfaRequired when MFA enabled', async () => {
    const reg = await app.request(
      '/auth/register',
      json({ email: 'mfa3@example.com', password: 'password123' }),
    );
    const { token } = await reg.json();

    const setupRes = await app.request('/auth/mfa/setup', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { secret } = await setupRes.json();
    await app.request('/auth/mfa/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: generateTotpCode(secret) }),
    });

    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'mfa3@example.com', password: 'password123' }),
    );
    const body = await loginRes.json();
    expect(body.mfaRequired).toBe(true);
    expect(body.mfaToken).toBeString();
  });

  test('MFA verify with TOTP completes login', async () => {
    const reg = await app.request(
      '/auth/register',
      json({ email: 'mfa4@example.com', password: 'password123' }),
    );
    const { token } = await reg.json();

    const setupRes = await app.request('/auth/mfa/setup', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { secret } = await setupRes.json();
    await app.request('/auth/mfa/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: generateTotpCode(secret) }),
    });

    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'mfa4@example.com', password: 'password123' }),
    );
    const { mfaToken } = await loginRes.json();

    const code = generateTotpCode(secret);
    const verifyRes = await app.request('/auth/mfa/verify', json({ mfaToken, code }));
    expect(verifyRes.status).toBe(200);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.token).toBeString();
  });

  test('disable MFA with TOTP code', async () => {
    const reg = await app.request(
      '/auth/register',
      json({ email: 'mfa5@example.com', password: 'password123' }),
    );
    const { token } = await reg.json();

    const setupRes = await app.request('/auth/mfa/setup', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { secret } = await setupRes.json();
    await app.request('/auth/mfa/verify-setup', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: generateTotpCode(secret) }),
    });

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
      json({ email: 'mfa5@example.com', password: 'password123' }),
    );
    const body = await loginRes.json();
    expect(body.mfaRequired).toBeUndefined();
    expect(body.token).toBeString();
  });
});
