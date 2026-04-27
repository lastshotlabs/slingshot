/**
 * End-to-end passkey login test.
 *
 * Spins up a real Bun HTTP server backed by an in-memory slingshot app, then uses
 * the snapshot ApiClient to exercise the full passkey login flow — the same
 * HTTP calls the snapshot hooks make in production.
 *
 * @simplewebauthn/server is mocked because passkey assertions require a real
 * browser authenticator (Windows Hello / Touch ID). The mock lets us verify
 * all the slingshot plumbing (challenge tokens, credential lookup, sign-count
 * update, session issuance) without a browser.
 */
import type { Server } from 'bun';
import { mock } from 'bun:test';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { getAuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import { getContext } from '@lastshotlabs/slingshot-core';
import type { HookContext } from '../../packages/slingshot-auth/src/config/authConfig';
import { createTestApp } from '../setup';

const CRED_ID = 'test-passkey-cred-e2e';
let verifyCallCount = 0;

mock.module('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: async (opts: any) => ({
    challenge: 'dGVzdC1jaGFsbGVuZ2UtZTJl',
    rpId: opts.rpID,
    timeout: opts.timeout ?? 60000,
    userVerification: opts.userVerification ?? 'required',
    allowCredentials: opts.allowCredentials ?? [],
  }),
  verifyAuthenticationResponse: async (args: any) => {
    verifyCallCount++;
    return {
      verified: true,
      authenticationInfo: {
        newCounter: (args.credential?.counter ?? 0) + 1,
        credentialID: CRED_ID,
        userVerified: true,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    };
  },
  generateRegistrationOptions: async (opts: any) => ({
    challenge: 'dGVzdC1yZWctY2hhbGxlbmdl',
    rp: { name: opts.rpName ?? 'Test App', id: opts.rpID },
    user: {
      id: Buffer.from('testuser').toString('base64url'),
      name: opts.userName,
      displayName: opts.userName,
    },
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
    timeout: 60000,
    excludeCredentials: [],
    authenticatorSelection: opts.authenticatorSelection,
  }),
  verifyRegistrationResponse: async () => ({
    verified: true,
    registrationInfo: {
      credential: { id: CRED_ID, publicKey: new Uint8Array(65), counter: 0 },
    },
  }),
}));

let server: Server<undefined>;
let api: TestApiClient;
let app: Awaited<ReturnType<typeof createTestApp>>;
let preLoginCalls: Array<{ identifier: string } & HookContext>;
let loginSuccessEvents: Array<{ userId: string }>;
let authLoginEvents: Array<{ userId: string; sessionId: string }>;
const tokenStore = { value: null as string | null, refresh: null as string | null };
const storage = {
  get: () => tokenStore.value,
  set: (t: string) => {
    tokenStore.value = t;
  },
  clear: () => {
    tokenStore.value = null;
  },
  getRefreshToken: () => tokenStore.refresh,
  setRefreshToken: (t: string) => {
    tokenStore.refresh = t;
  },
  clearRefreshToken: () => {
    tokenStore.refresh = null;
  },
};

type TokenStorage = typeof storage;

class TestApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TestApiError';
  }
}

class TestApiClient {
  private storage: TokenStorage | null = null;

  constructor(private readonly apiUrl: string) {}

  setStorage(storageAdapter: TokenStorage): void {
    this.storage = storageAdapter;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers = new Headers();
    headers.set('accept', 'application/json');
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    const token = this.storage?.get();
    if (token) {
      headers.set('x-user-token', token);
    }

    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.text();
      let detail = payload;
      try {
        const parsed = JSON.parse(payload) as { error?: unknown; message?: unknown };
        detail =
          typeof parsed.error === 'string'
            ? parsed.error
            : typeof parsed.message === 'string'
              ? parsed.message
              : payload;
      } catch {
        // Non-JSON error responses are still useful in the thrown message.
      }
      throw new TestApiError(
        `Request ${method} ${path} failed with HTTP ${response.status}: ${detail}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }
}

afterAll(() => server?.stop(true));

async function bootPasskeyApp(authOverrides: Record<string, unknown> = {}) {
  tokenStore.value = null;
  tokenStore.refresh = null;
  verifyCallCount = 0;
  preLoginCalls = [];
  loginSuccessEvents = [];
  authLoginEvents = [];

  if (server) server.stop(true);

  app = await createTestApp(
    {},
    {
      auth: {
        hooks: {
          preLogin: async data => {
            preLoginCalls.push(data);
          },
        },
        mfa: {
          webauthn: {
            rpId: 'example.com',
            origin: 'https://example.com',
            rpName: 'Test App',
            allowPasswordlessLogin: true,
          },
        },
        ...authOverrides,
      },
    },
  );

  const bus = getContext(app).bus;
  bus.on('security.auth.login.success', payload => {
    loginSuccessEvents.push(payload);
  });
  bus.on('auth:login', payload => {
    authLoginEvents.push(payload);
  });

  server = Bun.serve({ port: 0, fetch: app.fetch });
  const apiUrl = `http://localhost:${server.port}`;
  api = new TestApiClient(apiUrl);
  api.setStorage(storage);
}

beforeEach(async () => {
  await bootPasskeyApp();
});

/** Register a user and inject a fake WebAuthn credential directly into the adapter. */
async function setupUserWithPasskey(email = 'passkey@example.com') {
  const { token, userId } = await api.post<{ token: string; userId: string }>('/auth/register', {
    email,
    password: 'Password123!',
  });
  const adapter = getAuthRuntimeContext(getContext(app).pluginState).adapter;
  await adapter.addWebAuthnCredential!(userId, {
    credentialId: CRED_ID,
    publicKey: Buffer.from(new Uint8Array(65)).toString('base64url'),
    signCount: 0,
    transports: ['internal'],
    createdAt: Date.now(),
  });
  return { token, userId };
}

/** Minimal assertion response shape — content is irrelevant since verifyAuthenticationResponse is mocked. */
function fakeAssertion(credentialId: string) {
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: 'dGVzdC1jaGFsbGVuZ2UtZTJl',
          origin: 'https://example.com',
          crossOrigin: false,
        }),
      ).toString('base64url'),
      authenticatorData: Buffer.from(new Uint8Array(37)).toString('base64url'),
      signature: Buffer.from(new Uint8Array(64)).toString('base64url'),
    },
  };
}

// ---------------------------------------------------------------------------

describe('passkey login — snapshot ApiClient ↔ slingshot', () => {
  test('login-options returns challenge options and a passkeyToken', async () => {
    const { options, passkeyToken } = await api.post<{ options: any; passkeyToken: string }>(
      '/auth/passkey/login-options',
      {},
    );
    expect(passkeyToken).toBeString();
    expect(passkeyToken.length).toBeGreaterThan(0);
    expect(options.challenge).toBeString();
    expect(options.rpId).toBe('example.com');
  });

  test('login-options returns same shape for unknown email (enumeration prevention)', async () => {
    const known = await api.post<any>('/auth/passkey/login-options', {});
    const ghost = await api.post<any>('/auth/passkey/login-options', {
      email: 'ghost@example.com',
    });
    expect(known.passkeyToken).toBeString();
    expect(ghost.passkeyToken).toBeString();
    expect(known.passkeyToken).not.toBe(ghost.passkeyToken);
  });

  test('full flow: login-options → login → /auth/me', async () => {
    const { userId } = await setupUserWithPasskey();
    tokenStore.value = null; // start the login flow unauthenticated

    // Step 1 — get challenge (same call snapshot's usePasskeyLoginOptions makes)
    const { passkeyToken } = await api.post<{ options: any; passkeyToken: string }>(
      '/auth/passkey/login-options',
      {},
    );
    expect(passkeyToken).toBeString();

    // Step 2 — simulate what @simplewebauthn/browser startAuthentication() returns
    const assertionResponse = fakeAssertion(CRED_ID);

    // Step 3 — verify (same call snapshot's usePasskeyLogin makes)
    const result = await api.post<{ token: string; userId: string }>('/auth/passkey/login', {
      passkeyToken,
      assertionResponse,
    });
    expect(result.token).toBeString();
    expect(result.userId).toBe(userId);
    expect(verifyCallCount).toBe(1);
    expect(preLoginCalls).toHaveLength(1);
    expect(preLoginCalls[0].identifier).toBe('passkey@example.com');
    expect(loginSuccessEvents).toHaveLength(1);
    expect(loginSuccessEvents[0].userId).toBe(userId);
    expect(authLoginEvents).toHaveLength(1);
    expect(authLoginEvents[0].userId).toBe(userId);
    expect(authLoginEvents[0].sessionId).toBeString();

    // Step 4 — use the session token to access an authenticated endpoint
    tokenStore.value = result.token;
    const me = await api.get<{ userId: string }>('/auth/me');
    expect(me.userId).toBe(userId);
  });

  test('sign count is incremented in the credential record after login', async () => {
    const { userId } = await setupUserWithPasskey();
    tokenStore.value = null;

    const { passkeyToken } = await api.post<any>('/auth/passkey/login-options', {});
    await api.post<any>('/auth/passkey/login', {
      passkeyToken,
      assertionResponse: fakeAssertion(CRED_ID),
    });

    const adapter = getAuthRuntimeContext(getContext(app).pluginState).adapter;
    const creds = await adapter.getWebAuthnCredentials!(userId);
    const cred = creds.find(c => c.credentialId === CRED_ID);
    expect(cred!.signCount).toBe(1); // mock returns newCounter = 0 + 1
  });

  test('passkeyToken is single-use — second login with the same token returns 401', async () => {
    await setupUserWithPasskey();
    tokenStore.value = null;

    const { passkeyToken } = await api.post<any>('/auth/passkey/login-options', {});
    const assertion = fakeAssertion(CRED_ID);

    // First attempt consumes the token
    await api.post<any>('/auth/passkey/login', { passkeyToken, assertionResponse: assertion });

    // Second attempt — token is gone
    let threw = false;
    try {
      await api.post<any>('/auth/passkey/login', { passkeyToken, assertionResponse: assertion });
    } catch (e: any) {
      threw = true;
      expect(e.status).toBe(401);
    }
    expect(threw).toBe(true);
  });

  test('login with a credential not registered to any user returns 401', async () => {
    await setupUserWithPasskey();
    tokenStore.value = null;

    const { passkeyToken } = await api.post<any>('/auth/passkey/login-options', {});

    let threw = false;
    try {
      await api.post<any>('/auth/passkey/login', {
        passkeyToken,
        assertionResponse: fakeAssertion('not-a-real-credential'),
      });
    } catch (e: any) {
      threw = true;
      expect(e.status).toBe(401);
    }
    expect(threw).toBe(true);
  });

  test('required email verification blocks passkey login for unverified accounts', async () => {
    await bootPasskeyApp({
      emailVerification: {
        required: true,
        tokenExpiry: 86400,
      },
    });

    const { userId } = await setupUserWithPasskey('unverified-passkey@example.com');
    const adapter = getAuthRuntimeContext(getContext(app).pluginState).adapter;
    await adapter.setEmailVerified?.(userId, false);
    tokenStore.value = null;

    const { passkeyToken } = await api.post<any>('/auth/passkey/login-options', {});

    let threw = false;
    try {
      await api.post<any>('/auth/passkey/login', {
        passkeyToken,
        assertionResponse: fakeAssertion(CRED_ID),
      });
    } catch (e: any) {
      threw = true;
      expect(e.status).toBe(403);
      expect(String(e.message ?? '')).toMatch(/email not verified/i);
    }
    expect(threw).toBe(true);
    expect(loginSuccessEvents).toHaveLength(0);
    expect(authLoginEvents).toHaveLength(0);
  });

  test('session from passkey login is invalidated after logout', async () => {
    await setupUserWithPasskey('logout-test@example.com');
    tokenStore.value = null;

    const { passkeyToken } = await api.post<any>('/auth/passkey/login-options', {});
    const { token } = await api.post<{ token: string; userId: string }>('/auth/passkey/login', {
      passkeyToken,
      assertionResponse: fakeAssertion(CRED_ID),
    });

    tokenStore.value = token;
    await api.get('/auth/me'); // works

    await api.post('/auth/logout', {});
    // token is still in storage but session is revoked on the server
    let threw = false;
    try {
      await api.get('/auth/me');
    } catch (e: any) {
      threw = true;
      expect(e.status).toBe(401);
    }
    expect(threw).toBe(true);
  });
});
