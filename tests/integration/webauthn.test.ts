import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { getAuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import { getContext } from '@lastshotlabs/slingshot-core';
import { authHeader, createTestApp } from '../setup';

// ---------------------------------------------------------------------------
// Mock @simplewebauthn/server BEFORE any app imports
// ---------------------------------------------------------------------------

const mockGenerateRegistrationOptions = mock(async () => ({
  challenge: 'test-challenge-base64url',
  rp: { name: 'Test', id: 'localhost' },
  user: { id: 'user-id', name: 'test@example.com', displayName: 'test' },
}));
const mockVerifyRegistrationResponse = mock(async () => ({
  verified: true,
  registrationInfo: {
    credential: {
      id: 'credential-id-123',
      publicKey: new Uint8Array([1, 2, 3, 4]),
      counter: 0,
    },
  },
}));
const mockGenerateAuthenticationOptions = mock(async (opts: { rpID?: string }) => ({
  challenge: 'auth-challenge-base64url',
  allowCredentials: [],
  rpId: opts?.rpID,
  userVerification: 'required',
}));
const mockVerifyAuthenticationResponse = mock(async () => ({
  verified: true,
  authenticationInfo: { newCounter: 1 },
}));

mock.module('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mockGenerateRegistrationOptions,
  verifyRegistrationResponse: mockVerifyRegistrationResponse,
  generateAuthenticationOptions: mockGenerateAuthenticationOptions,
  verifyAuthenticationResponse: mockVerifyAuthenticationResponse,
}));

let app: OpenAPIHono<any>;

beforeEach(async () => {
  mockGenerateRegistrationOptions.mockClear();
  mockVerifyRegistrationResponse.mockClear();
  mockGenerateAuthenticationOptions.mockClear();
  mockVerifyAuthenticationResponse.mockClear();
  app = await createTestApp(
    {},
    {
      auth: {
        enabled: true,
        roles: ['admin', 'user'],
        defaultRole: 'user',
        mfa: {
          issuer: 'TestApp',
          webauthn: {
            rpId: 'localhost',
            rpName: 'Test',
            origin: 'http://localhost:3000',
          },
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

async function registerUser(email = 'wa-route@example.com') {
  const res = await app.request('/auth/register', json({ email, password: 'password123' }));
  return res.json() as Promise<{ token: string; userId: string }>;
}

// ---------------------------------------------------------------------------
// WebAuthn Route Integration Tests
// ---------------------------------------------------------------------------

describe('WebAuthn routes', () => {
  test('POST /auth/mfa/webauthn/register-options returns options', async () => {
    const { token } = await registerUser('wa-rt-opts@example.com');
    const res = await app.request('/auth/mfa/webauthn/register-options', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.options).toBeDefined();
    expect(body.registrationToken).toBeString();
  });

  test('POST /auth/mfa/webauthn/register-options returns 403 for suspended accounts when route guard is responsible', async () => {
    app = await createTestApp(
      {},
      {
        auth: {
          checkSuspensionOnIdentify: false,
          mfa: {
            webauthn: {
              rpId: 'localhost',
              rpName: 'Test',
              origin: 'http://localhost:3000',
            },
          },
        },
      },
    );
    const { token, userId } = await registerUser('wa-rt-opts-suspended@example.com');
    const runtime = getAuthRuntimeContext(getContext(app).pluginState);
    await runtime.adapter.setSuspended?.(userId, true, 'admin lock');

    const res = await app.request('/auth/mfa/webauthn/register-options', {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(403);
  });

  test('POST /auth/mfa/webauthn/register-options returns 401 without auth', async () => {
    const res = await app.request('/auth/mfa/webauthn/register-options', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  test('POST /auth/mfa/webauthn/register completes registration', async () => {
    const { token, userId } = await registerUser('wa-rt-reg@example.com');

    const optsRes = await app.request('/auth/mfa/webauthn/register-options', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { registrationToken } = await optsRes.json();

    const res = await app.request('/auth/mfa/webauthn/register', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registrationToken,
        attestationResponse: { id: 'cred-rt', response: { transports: ['internal'] } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentialId).toBeString();
    expect(body.recoveryCodes).toBeArray();

    app = await createTestApp(
      {},
      {
        auth: {
          checkSuspensionOnIdentify: false,
          mfa: {
            webauthn: {
              rpId: 'localhost',
              rpName: 'Test',
              origin: 'http://localhost:3000',
            },
          },
        },
      },
    );
    const secondUser = await registerUser('wa-rt-reg-suspended@example.com');
    const secondOptsRes = await app.request('/auth/mfa/webauthn/register-options', {
      method: 'POST',
      headers: authHeader(secondUser.token),
    });
    const { registrationToken: blockedToken } = await secondOptsRes.json();
    const runtime = getAuthRuntimeContext(getContext(app).pluginState);
    await runtime.adapter.setSuspended?.(secondUser.userId, true, 'admin lock');

    const blockedRes = await app.request('/auth/mfa/webauthn/register', {
      method: 'POST',
      headers: { ...authHeader(secondUser.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registrationToken: blockedToken,
        attestationResponse: { id: 'cred-blocked', response: {} },
      }),
    });
    expect(blockedRes.status).toBe(403);
  });

  test('GET /auth/mfa/webauthn/credentials returns empty when none', async () => {
    const { token } = await registerUser('wa-rt-nocreds@example.com');
    const res = await app.request('/auth/mfa/webauthn/credentials', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentials).toBeArray();
    expect(body.credentials).toHaveLength(0);
  });

  test('GET /auth/mfa/webauthn/credentials returns credentials after registration', async () => {
    const { token } = await registerUser('wa-rt-hascreds@example.com');

    const optsRes = await app.request('/auth/mfa/webauthn/register-options', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { registrationToken } = await optsRes.json();

    await app.request('/auth/mfa/webauthn/register', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registrationToken,
        attestationResponse: { id: 'cred-list', response: {} },
      }),
    });

    const res = await app.request('/auth/mfa/webauthn/credentials', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentials.length).toBeGreaterThanOrEqual(1);
  });

  test('DELETE /auth/mfa/webauthn/credentials/:id removes credential', async () => {
    app = await createTestApp(
      {},
      {
        auth: {
          checkSuspensionOnIdentify: false,
          mfa: {
            webauthn: {
              rpId: 'localhost',
              rpName: 'Test',
              origin: 'http://localhost:3000',
            },
          },
        },
      },
    );
    const { token, userId } = await registerUser('wa-rt-delcred@example.com');

    // Register a credential
    const optsRes = await app.request('/auth/mfa/webauthn/register-options', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { registrationToken } = await optsRes.json();
    await app.request('/auth/mfa/webauthn/register', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registrationToken,
        attestationResponse: { id: 'cred-del', response: {} },
      }),
    });

    // Delete it (last credential — needs password)
    const delRes = await app.request('/auth/mfa/webauthn/credentials/credential-id-123', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'password123' }),
    });
    expect(delRes.status).toBe(200);

    const runtime = getAuthRuntimeContext(getContext(app).pluginState);
    await runtime.adapter.setSuspended?.(userId, true, 'admin lock');

    const blockedRes = await app.request('/auth/mfa/webauthn/credentials/credential-id-123', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'password123' }),
    });
    expect(blockedRes.status).toBe(403);
  });

  test('DELETE /auth/mfa/webauthn disables all WebAuthn', async () => {
    app = await createTestApp(
      {},
      {
        auth: {
          checkSuspensionOnIdentify: false,
          mfa: {
            webauthn: {
              rpId: 'localhost',
              rpName: 'Test',
              origin: 'http://localhost:3000',
            },
          },
        },
      },
    );
    const { token, userId } = await registerUser('wa-rt-disableall@example.com');

    const optsRes = await app.request('/auth/mfa/webauthn/register-options', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { registrationToken } = await optsRes.json();
    await app.request('/auth/mfa/webauthn/register', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registrationToken,
        attestationResponse: { id: 'cred-disableall', response: {} },
      }),
    });

    const delRes = await app.request('/auth/mfa/webauthn', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'password123' }),
    });
    expect(delRes.status).toBe(200);

    // Credentials should be empty now
    const credsRes = await app.request('/auth/mfa/webauthn/credentials', {
      headers: authHeader(token),
    });
    const { credentials } = await credsRes.json();
    expect(credentials).toHaveLength(0);

    const runtime = getAuthRuntimeContext(getContext(app).pluginState);
    await runtime.adapter.setSuspended?.(userId, true, 'admin lock');

    const blockedRes = await app.request('/auth/mfa/webauthn', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'password123' }),
    });
    expect(blockedRes.status).toBe(403);
  });

  test('login returns mfaRequired with webauthnOptions when WebAuthn enabled', async () => {
    const { token } = await registerUser('wa-rt-login@example.com');

    // Register WebAuthn credential
    const optsRes = await app.request('/auth/mfa/webauthn/register-options', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { registrationToken } = await optsRes.json();
    await app.request('/auth/mfa/webauthn/register', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registrationToken,
        attestationResponse: { id: 'cred-login', response: {} },
      }),
    });

    // Login should require MFA
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'wa-rt-login@example.com', password: 'password123' }),
    );
    const body = await loginRes.json();
    expect(body.mfaRequired).toBe(true);
    expect(body.mfaToken).toBeString();
    expect(body.mfaMethods).toContain('webauthn');
  });

  test('MFA verify with webauthnResponse completes login', async () => {
    const { token } = await registerUser('wa-rt-mfaverify@example.com');

    // Register WebAuthn credential
    const optsRes = await app.request('/auth/mfa/webauthn/register-options', {
      method: 'POST',
      headers: authHeader(token),
    });
    const { registrationToken } = await optsRes.json();
    await app.request('/auth/mfa/webauthn/register', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registrationToken,
        attestationResponse: { id: 'cred-mfaverify', response: {} },
      }),
    });

    // Login → get mfaToken
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'wa-rt-mfaverify@example.com', password: 'password123' }),
    );
    const { mfaToken } = await loginRes.json();

    // Verify with WebAuthn assertion
    const verifyRes = await app.request(
      '/auth/mfa/verify',
      json({
        mfaToken,
        method: 'webauthn',
        webauthnResponse: { id: 'credential-id-123', response: {} },
      }),
    );
    expect(verifyRes.status).toBe(200);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.token).toBeString();
  });
});
