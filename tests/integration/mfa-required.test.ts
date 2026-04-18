import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as OTPAuth from 'otpauth';
import { authHeader, createMemoryAuthAdapter, createTestApp } from '../setup';

let app: OpenAPIHono<any>;
let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;

beforeEach(async () => {
  memoryAuthAdapter = createMemoryAuthAdapter();
  app = await createTestApp(
    {},
    {
      auth: {
        adapter: memoryAuthAdapter,
        enabled: true,
        roles: ['admin', 'user'],
        defaultRole: 'user',
        mfa: {
          issuer: 'TestApp',
          required: true,
        },
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

async function registerUser(email = 'mfa@example.com', password = 'password123') {
  const res = await app.request('/auth/register', json({ email, password }));
  return res.json() as Promise<{ token: string; userId: string }>;
}

async function registerAndSetupMfa(email = 'mfa@example.com', password = 'password123') {
  const { token, userId } = await registerUser(email, password);

  const setupRes = await app.request('/auth/mfa/setup', {
    method: 'POST',
    headers: authHeader(token),
  });
  const { secret } = (await setupRes.json()) as { secret: string };

  const code = generateTotpCode(secret);
  await app.request('/auth/mfa/verify-setup', {
    method: 'POST',
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });

  return { token, userId, secret };
}

// ---------------------------------------------------------------------------
// Enforcement: authenticated user without MFA → 403
// ---------------------------------------------------------------------------

describe('MFA required enforcement', () => {
  test('blocks authenticated user without MFA on service routes', async () => {
    const { token } = await registerUser();

    const res = await app.request('/protected/action', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MFA_SETUP_REQUIRED');
    expect(body.error).toBe('MFA setup required');
  });

  test('blocks authenticated user without MFA on GET routes', async () => {
    const { token } = await registerUser();

    const res = await app.request('/protected/admin', {
      headers: authHeader(token),
    });
    // userAuth would return 401 for non-admin, but requireMfaSetup runs first
    // as global middleware — returns 403 before route-level userAuth/requireRole
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MFA_SETUP_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// Exempt paths: auth and MFA routes remain accessible
// ---------------------------------------------------------------------------

describe('MFA required exemptions', () => {
  test('allows /auth/me for user without MFA', async () => {
    const { token } = await registerUser();

    const res = await app.request('/auth/me', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
  });

  test('allows /auth/mfa/setup for user without MFA', async () => {
    const { token } = await registerUser();

    const res = await app.request('/auth/mfa/setup', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
  });

  test('allows /auth/logout for user without MFA', async () => {
    const { token } = await registerUser();

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
  });

  test('allows /auth/login without MFA', async () => {
    await registerUser();

    const res = await app.request(
      '/auth/login',
      json({ email: 'mfa@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(200);
  });

  test('allows /health without MFA', async () => {
    const { token } = await registerUser();

    const res = await app.request('/health', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
  });

  test('allows unauthenticated requests through', async () => {
    const res = await app.request('/public/action', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// User with MFA enabled → full access
// ---------------------------------------------------------------------------

describe('MFA required — user with MFA', () => {
  test('allows access to service routes after MFA setup', async () => {
    const { token } = await registerAndSetupMfa();

    const res = await app.request('/protected/action', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Default behavior — required not set
// ---------------------------------------------------------------------------

describe('MFA not required (default)', () => {
  let defaultApp: OpenAPIHono<any>;

  beforeAll(async () => {
    defaultApp = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['admin', 'user'],
          defaultRole: 'user',
          mfa: {
            issuer: 'TestApp',
            // required not set — defaults to false
          },
        },
      },
    );
  });

  test('does not block authenticated user without MFA', async () => {
    const regRes = await defaultApp.request(
      '/auth/register',
      json({ email: 'nomfa@example.com', password: 'password123' }),
    );
    const { token } = (await regRes.json()) as { token: string };

    const res = await defaultApp.request('/protected/action', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
  });
});
