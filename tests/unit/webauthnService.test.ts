import {
  assertWebAuthnDependency,
  completeWebAuthnRegistration,
  disableWebAuthn,
  generateWebAuthnAuthenticationOptions,
  initiateWebAuthnRegistration,
  removeWebAuthnCredential,
  verifyWebAuthn,
} from '@auth/services/mfa';
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
const getRuntime = () => getAuthRuntimeContext(getContext(app).pluginState);

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

async function registerUser(email = 'webauthn@example.com') {
  const res = await app.request('/auth/register', json({ email, password: 'password123' }));
  const { token, userId } = await res.json();
  return { token, userId };
}

// ---------------------------------------------------------------------------
// assertWebAuthnDependency
// ---------------------------------------------------------------------------

describe('assertWebAuthnDependency', () => {
  test('resolves without error', async () => {
    await expect(assertWebAuthnDependency()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateWebAuthnAuthenticationOptions
// ---------------------------------------------------------------------------

describe('generateWebAuthnAuthenticationOptions', () => {
  test('returns null when user has no credentials', async () => {
    const { userId } = await registerUser('wa-auth-nocred@example.com');
    const result = await generateWebAuthnAuthenticationOptions(userId, getRuntime());
    expect(result).toBeNull();
  });

  test('returns challenge+options when user has credentials', async () => {
    const { token, userId } = await registerUser('wa-auth-cred@example.com');

    // Register a WebAuthn credential first
    const { registrationToken } = await initiateWebAuthnRegistration(userId, getRuntime());
    await completeWebAuthnRegistration(
      userId,
      registrationToken,
      {
        id: 'cred-for-auth',
        rawId: 'cred-for-auth',
        response: { clientDataJSON: '', attestationObject: '', transports: ['internal'] },
        clientExtensionResults: {},
        type: 'public-key',
      },
      getRuntime(),
    );

    const result = await generateWebAuthnAuthenticationOptions(userId, getRuntime());
    expect(result).not.toBeNull();
    expect(result!.challenge).toBe('auth-challenge-base64url');
    expect(result!.options).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// initiateWebAuthnRegistration
// ---------------------------------------------------------------------------

describe('initiateWebAuthnRegistration', () => {
  test('returns options and registrationToken', async () => {
    const { userId } = await registerUser('wa-init@example.com');
    const result = await initiateWebAuthnRegistration(userId, getRuntime());
    expect(result.options).toBeDefined();
    expect(result.registrationToken).toBeString();
  });
});

// ---------------------------------------------------------------------------
// completeWebAuthnRegistration
// ---------------------------------------------------------------------------

describe('completeWebAuthnRegistration', () => {
  test('stores credential on verification and returns recovery codes', async () => {
    const { userId } = await registerUser('wa-complete@example.com');
    const { registrationToken } = await initiateWebAuthnRegistration(userId, getRuntime());

    const result = await completeWebAuthnRegistration(
      userId,
      registrationToken,
      {
        id: 'cred-complete',
        rawId: 'cred-complete',
        response: { clientDataJSON: '', attestationObject: '', transports: ['usb'] },
        clientExtensionResults: {},
        type: 'public-key',
      },
      getRuntime(),
    );
    expect(result.credentialId).toBe('credential-id-123');
    expect(result.recoveryCodes).toBeArray();
    expect(result.recoveryCodes!.length).toBeGreaterThan(0);
  });

  test('throws on invalid/expired registration token', async () => {
    const { userId } = await registerUser('wa-badtoken@example.com');
    await expect(
      completeWebAuthnRegistration(
        userId,
        'invalid-token',
        {
          id: 'cred-bad',
          rawId: 'cred-bad',
          response: { clientDataJSON: '', attestationObject: '' },
          clientExtensionResults: {},
          type: 'public-key',
        },
        getRuntime(),
      ),
    ).rejects.toThrow('Invalid or expired registration token');
  });

  test('throws on failed verification', async () => {
    const { userId } = await registerUser('wa-failverify@example.com');
    const { registrationToken } = await initiateWebAuthnRegistration(userId, getRuntime());

    mockVerifyRegistrationResponse.mockImplementationOnce(
      async () =>
        ({
          verified: false,
          registrationInfo: null,
        }) as any,
    );

    await expect(
      completeWebAuthnRegistration(
        userId,
        registrationToken,
        {
          id: 'cred-fail',
          rawId: 'cred-fail',
          response: { clientDataJSON: '', attestationObject: '' },
          clientExtensionResults: {},
          type: 'public-key',
        },
        getRuntime(),
      ),
    ).rejects.toThrow('WebAuthn registration verification failed');
  });
});

// ---------------------------------------------------------------------------
// verifyWebAuthn
// ---------------------------------------------------------------------------

describe('verifyWebAuthn', () => {
  test('returns true on valid assertion', async () => {
    const { userId } = await registerUser('wa-verify@example.com');
    const { registrationToken } = await initiateWebAuthnRegistration(userId, getRuntime());
    await completeWebAuthnRegistration(
      userId,
      registrationToken,
      {
        id: 'cred-verify-ok',
        rawId: 'cred-verify-ok',
        response: { clientDataJSON: '', attestationObject: '', transports: ['internal'] },
        clientExtensionResults: {},
        type: 'public-key',
      },
      getRuntime(),
    );

    const result = await verifyWebAuthn(
      userId,
      {
        id: 'credential-id-123',
        rawId: 'credential-id-123',
        response: { clientDataJSON: '', authenticatorData: '', signature: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      'expected-challenge',
      getRuntime(),
    );
    expect(result).toBe(true);
  });

  test('returns false when no matching credential', async () => {
    const { userId } = await registerUser('wa-nomatch@example.com');
    const { registrationToken } = await initiateWebAuthnRegistration(userId, getRuntime());
    await completeWebAuthnRegistration(
      userId,
      registrationToken,
      {
        id: 'cred-nomatch',
        rawId: 'cred-nomatch',
        response: { clientDataJSON: '', attestationObject: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      getRuntime(),
    );

    const result = await verifyWebAuthn(
      userId,
      {
        id: 'nonexistent-cred',
        rawId: 'nonexistent-cred',
        response: { clientDataJSON: '', authenticatorData: '', signature: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      'challenge',
      getRuntime(),
    );
    expect(result).toBe(false);
  });

  test('returns false on failed assertion', async () => {
    const { userId } = await registerUser('wa-failassert@example.com');
    const { registrationToken } = await initiateWebAuthnRegistration(userId, getRuntime());
    await completeWebAuthnRegistration(
      userId,
      registrationToken,
      {
        id: 'cred-failassert',
        rawId: 'cred-failassert',
        response: { clientDataJSON: '', attestationObject: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      getRuntime(),
    );

    mockVerifyAuthenticationResponse.mockImplementationOnce(
      async () =>
        ({
          verified: false,
          authenticationInfo: null,
        }) as any,
    );

    const result = await verifyWebAuthn(
      userId,
      {
        id: 'credential-id-123',
        rawId: 'credential-id-123',
        response: { clientDataJSON: '', authenticatorData: '', signature: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      'challenge',
      getRuntime(),
    );
    expect(result).toBe(false);
  });

  test('returns false on exception', async () => {
    const { userId } = await registerUser('wa-exception@example.com');
    const { registrationToken } = await initiateWebAuthnRegistration(userId, getRuntime());
    await completeWebAuthnRegistration(
      userId,
      registrationToken,
      {
        id: 'cred-exc',
        rawId: 'cred-exc',
        response: { clientDataJSON: '', attestationObject: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      getRuntime(),
    );

    mockVerifyAuthenticationResponse.mockImplementationOnce(async () => {
      throw new Error('verification error');
    });

    const result = await verifyWebAuthn(
      userId,
      {
        id: 'credential-id-123',
        rawId: 'credential-id-123',
        response: { clientDataJSON: '', authenticatorData: '', signature: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      'challenge',
      getRuntime(),
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeWebAuthnCredential
// ---------------------------------------------------------------------------

describe('removeWebAuthnCredential', () => {
  test('removes credential', async () => {
    const { userId } = await registerUser('wa-remove@example.com');

    // Register two credentials so removal doesn't require identity verification
    const { registrationToken: t1 } = await initiateWebAuthnRegistration(userId, getRuntime());
    await completeWebAuthnRegistration(
      userId,
      t1,
      {
        id: 'cred-remove-1',
        rawId: 'cred-remove-1',
        response: { clientDataJSON: '', attestationObject: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      getRuntime(),
    );

    // For second credential, mock a different credential ID
    mockVerifyRegistrationResponse.mockImplementationOnce(async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'credential-id-second',
          publicKey: new Uint8Array([5, 6, 7, 8]),
          counter: 0,
        },
      },
    }));
    const { registrationToken: t2 } = await initiateWebAuthnRegistration(userId, getRuntime());
    await completeWebAuthnRegistration(
      userId,
      t2,
      {
        id: 'cred-remove-2',
        rawId: 'cred-remove-2',
        response: { clientDataJSON: '', attestationObject: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      getRuntime(),
    );

    // Remove one — should succeed without identity verification
    await removeWebAuthnCredential(userId, 'credential-id-123', {}, getRuntime());
  });

  test('throws 404 for unknown credential', async () => {
    const { userId } = await registerUser('wa-remove404@example.com');
    await expect(removeWebAuthnCredential(userId, 'nonexistent', {}, getRuntime())).rejects.toThrow(
      'Credential not found',
    );
  });

  test('requires identity verification for last credential', async () => {
    const { userId } = await registerUser('wa-removelast@example.com');
    const { registrationToken } = await initiateWebAuthnRegistration(userId, getRuntime());
    await completeWebAuthnRegistration(
      userId,
      registrationToken,
      {
        id: 'cred-last',
        rawId: 'cred-last',
        response: { clientDataJSON: '', attestationObject: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      getRuntime(),
    );

    // Removing last credential without password or code should fail
    await expect(
      removeWebAuthnCredential(userId, 'credential-id-123', {}, getRuntime()),
    ).rejects.toThrow('Password required');
  });

  test('removes last credential with password and disables MFA', async () => {
    const { userId } = await registerUser('wa-removelastpw@example.com');
    const { registrationToken } = await initiateWebAuthnRegistration(userId, getRuntime());
    await completeWebAuthnRegistration(
      userId,
      registrationToken,
      {
        id: 'cred-lastpw',
        rawId: 'cred-lastpw',
        response: { clientDataJSON: '', attestationObject: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      getRuntime(),
    );

    await removeWebAuthnCredential(
      userId,
      'credential-id-123',
      { password: 'password123' },
      getRuntime(),
    );
  });
});

// ---------------------------------------------------------------------------
// disableWebAuthn
// ---------------------------------------------------------------------------

describe('disableWebAuthn', () => {
  test('removes all credentials and disables MFA with password', async () => {
    const { userId } = await registerUser('wa-disable@example.com');
    const { registrationToken } = await initiateWebAuthnRegistration(userId, getRuntime());
    await completeWebAuthnRegistration(
      userId,
      registrationToken,
      {
        id: 'cred-disable',
        rawId: 'cred-disable',
        response: { clientDataJSON: '', attestationObject: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      getRuntime(),
    );

    await disableWebAuthn(userId, { password: 'password123' }, getRuntime());

    // Should have no credentials now — generateWebAuthnAuthenticationOptions returns null
    const result = await generateWebAuthnAuthenticationOptions(userId, getRuntime());
    expect(result).toBeNull();
  });

  test('requires password verification', async () => {
    const { userId } = await registerUser('wa-disablenopw@example.com');
    const { registrationToken } = await initiateWebAuthnRegistration(userId, getRuntime());
    await completeWebAuthnRegistration(
      userId,
      registrationToken,
      {
        id: 'cred-disablenopw',
        rawId: 'cred-disablenopw',
        response: { clientDataJSON: '', attestationObject: '' },
        clientExtensionResults: {},
        type: 'public-key',
      },
      getRuntime(),
    );

    await expect(disableWebAuthn(userId, {}, getRuntime())).rejects.toThrow('Password required');
  });
});
