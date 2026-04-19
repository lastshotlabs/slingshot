import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { COOKIE_CSRF_TOKEN, COOKIE_TOKEN } from '@lastshotlabs/slingshot-core';
import { signToken } from '../../../slingshot-auth/src/lib/jwt';
import { setSuspended } from '../../../slingshot-auth/src/lib/suspension';
import { csrfProtection } from '../../../slingshot-auth/src/middleware/csrf';
import { createIdentifyMiddleware } from '../../../slingshot-auth/src/middleware/identify';
import { createOAuthRouter } from '../../src/routes/oauth';
import { makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';

type TestRuntime = ReturnType<typeof makeTestRuntime>;

function extractCookie(res: Response, name: string): string | null {
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    const match = cookie.match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`));
    if (match) return match[1] ?? null;
  }
  const fallback = res.headers.get('set-cookie');
  if (!fallback) return null;
  const match = fallback.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1] ?? null;
}

function buildApp(runtime: TestRuntime, providers: string[] = ['google']) {
  const app = wrapWithRuntime(runtime);
  app.use('*', createIdentifyMiddleware(runtime));
  app.use(
    '*',
    csrfProtection({
      checkOrigin: false,
      signing: runtime.signing,
      protectedUnauthenticatedPaths: providers.map(provider => `/auth/${provider}`),
    }),
  );
  app.get('/csrf', c => c.json({ ok: true }));
  app.route('/', createOAuthRouter(providers, '/', runtime));
  return app;
}

async function createSession(runtime: TestRuntime, email: string, sessionId: string) {
  const { id: userId } = await runtime.adapter.create(email, 'hash');
  return createSessionForUser(runtime, userId, sessionId);
}

async function createSessionForUser(runtime: TestRuntime, userId: string, sessionId: string) {
  const token = await signToken(
    { sub: userId, sid: sessionId },
    3600,
    runtime.config,
    runtime.signing,
  );
  await runtime.repos.session.createSession(userId, token, sessionId, undefined, runtime.config);
  return { userId, token };
}

describe('OAuth link initiation CSRF protection', () => {
  let runtime: TestRuntime;

  beforeEach(() => {
    runtime = makeTestRuntime();
    const provider = {
      createAuthorizationURL(state: string, codeVerifier: string) {
        const url = new URL('https://provider.example/authorize');
        url.searchParams.set('state', state);
        url.searchParams.set('code_verifier', codeVerifier);
        return url;
      },
    };
    runtime.oauth.providers.google = provider as never;
  });

  test('cookie-authenticated POST /auth/google/link rejects requests without CSRF proof', async () => {
    const app = buildApp(runtime);
    const { token } = await createSession(runtime, 'cookie-user@example.com', 'sess-cookie-1');
    const csrfRes = await app.request('/csrf');
    const csrfToken = extractCookie(csrfRes, COOKIE_CSRF_TOKEN);
    expect(csrfToken).toBeTruthy();

    const res = await app.request('/auth/google/link', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_TOKEN}=${token}; ${COOKIE_CSRF_TOKEN}=${csrfToken}`,
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'CSRF token missing' });
  });

  test('cookie-authenticated POST /auth/google/link succeeds with a matching CSRF header', async () => {
    const app = buildApp(runtime);
    const { token } = await createSession(runtime, 'csrf-ok@example.com', 'sess-cookie-2');
    const csrfRes = await app.request('/csrf');
    const csrfToken = extractCookie(csrfRes, COOKIE_CSRF_TOKEN);
    expect(csrfToken).toBeTruthy();

    const res = await app.request('/auth/google/link', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_TOKEN}=${token}; ${COOKIE_CSRF_TOKEN}=${csrfToken}`,
        'x-csrf-token': csrfToken!,
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('https://provider.example/authorize');
  });

  test('header-authenticated POST /auth/google/link does not require CSRF cookies', async () => {
    const app = buildApp(runtime);
    const { token } = await createSession(runtime, 'header-user@example.com', 'sess-header-1');

    const res = await app.request('/auth/google/link', {
      method: 'POST',
      headers: {
        'x-user-token': token,
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('https://provider.example/authorize');
  });

  test('returns 403 for suspended accounts when route guard is responsible', async () => {
    runtime = makeTestRuntime({ checkSuspensionOnIdentify: false });
    const suspendedProvider = {
      createAuthorizationURL(state: string, codeVerifier: string) {
        const url = new URL('https://provider.example/authorize');
        url.searchParams.set('state', state);
        url.searchParams.set('code_verifier', codeVerifier);
        return url;
      },
    };
    runtime.oauth.providers.google = suspendedProvider as never;

    const app = buildApp(runtime);
    const { userId, token } = await createSession(runtime, 'suspended-link@example.com', 'sess-s1');
    await setSuspended(runtime.adapter, userId, true, 'security hold');

    const res = await app.request('/auth/google/link', {
      method: 'POST',
      headers: {
        'x-user-token': token,
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Account suspended' });
  });

  test('GET /auth/google/link is no longer mounted', async () => {
    const app = buildApp(runtime);
    const { token } = await createSession(runtime, 'legacy-get@example.com', 'sess-get-1');

    const res = await app.request('/auth/google/link', {
      headers: {
        'x-user-token': token,
      },
    });

    expect(res.status).toBe(404);
  });
});

describe('OAuth login initiation CSRF protection', () => {
  let runtime: TestRuntime;

  beforeEach(() => {
    runtime = makeTestRuntime();
    const loginProvider = {
      createAuthorizationURL(state: string, codeVerifier: string) {
        const url = new URL('https://provider.example/authorize');
        url.searchParams.set('state', state);
        url.searchParams.set('code_verifier', codeVerifier);
        return url;
      },
    };
    runtime.oauth.providers.google = loginProvider as never;
  });

  test('anonymous POST /auth/google rejects requests without CSRF proof', async () => {
    const app = buildApp(runtime);

    const res = await app.request('/auth/google', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'CSRF token missing' });
  });

  test('anonymous POST /auth/google succeeds with a matching CSRF header', async () => {
    const app = buildApp(runtime);
    const csrfRes = await app.request('/csrf');
    const csrfToken = extractCookie(csrfRes, COOKIE_CSRF_TOKEN);
    expect(csrfToken).toBeTruthy();

    const res = await app.request('/auth/google', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_CSRF_TOKEN}=${csrfToken}`,
        'x-csrf-token': csrfToken!,
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('https://provider.example/authorize');
  });

  test('GET /auth/google is no longer mounted', async () => {
    const app = buildApp(runtime);

    const res = await app.request('/auth/google');

    expect(res.status).toBe(404);
  });
});

describe('OAuth reauth initiation CSRF protection', () => {
  let runtime: TestRuntime;

  beforeEach(() => {
    runtime = makeTestRuntime({
      oauthReauth: {
        enabled: true,
        promptType: 'login',
      },
    });
    const reauthProvider = {
      createAuthorizationURL(state: string) {
        const url = new URL('https://provider.example/reauth');
        url.searchParams.set('state', state);
        return url;
      },
    };
    runtime.oauth.providers.github = reauthProvider as never;
  });

  async function createLinkedSession() {
    const { userId, token } = await createSession(
      runtime,
      'reauth-user@example.com',
      'sess-reauth-1',
    );
    await runtime.adapter.linkProvider!(userId, 'github', 'gh-linked-1');
    return { userId, token };
  }

  test('cookie-authenticated POST /auth/github/reauth rejects requests without CSRF proof', async () => {
    const app = buildApp(runtime, ['github']);
    const { token } = await createLinkedSession();
    const csrfRes = await app.request('/csrf');
    const csrfToken = extractCookie(csrfRes, COOKIE_CSRF_TOKEN);
    expect(csrfToken).toBeTruthy();

    const res = await app.request('/auth/github/reauth?purpose=delete_account', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_TOKEN}=${token}; ${COOKIE_CSRF_TOKEN}=${csrfToken}`,
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'CSRF token missing' });
  });

  test('cookie-authenticated POST /auth/github/reauth succeeds with a matching CSRF header', async () => {
    const app = buildApp(runtime, ['github']);
    const { token } = await createLinkedSession();
    const csrfRes = await app.request('/csrf');
    const csrfToken = extractCookie(csrfRes, COOKIE_CSRF_TOKEN);
    expect(csrfToken).toBeTruthy();

    const res = await app.request('/auth/github/reauth?purpose=delete_account', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_TOKEN}=${token}; ${COOKIE_CSRF_TOKEN}=${csrfToken}`,
        'x-csrf-token': csrfToken!,
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('https://provider.example/reauth');
  });

  test('header-authenticated POST /auth/github/reauth does not require CSRF cookies', async () => {
    const app = buildApp(runtime, ['github']);
    const { token } = await createLinkedSession();

    const res = await app.request('/auth/github/reauth?purpose=delete_account', {
      method: 'POST',
      headers: {
        'x-user-token': token,
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('https://provider.example/reauth');
  });

  test('returns 403 when email verification becomes required before reauth initiation', async () => {
    runtime = makeTestRuntime({
      primaryField: 'email',
      emailVerification: { required: true, tokenExpiry: 86_400 },
      oauthReauth: {
        enabled: true,
        promptType: 'login',
      },
    });
    const verifyProvider = {
      createAuthorizationURL(state: string) {
        const url = new URL('https://provider.example/reauth');
        url.searchParams.set('state', state);
        return url;
      },
    };
    runtime.oauth.providers.github = verifyProvider as never;

    const app = buildApp(runtime, ['github']);
    const { id: userId } = await runtime.adapter.create('reauth-verify@example.com', 'hash');
    await runtime.adapter.setEmailVerified?.(userId, true);
    const { token } = await createSessionForUser(runtime, userId, 'sess-reauth-verify');
    await runtime.adapter.linkProvider!(userId, 'github', 'gh-linked-verify');
    await runtime.adapter.setEmailVerified?.(userId, false);

    const res = await app.request('/auth/github/reauth?purpose=delete_account', {
      method: 'POST',
      headers: {
        'x-user-token': token,
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Email not verified' });
  });

  test('GET /auth/github/reauth is no longer mounted', async () => {
    const app = buildApp(runtime, ['github']);
    const { token } = await createLinkedSession();

    const res = await app.request('/auth/github/reauth?purpose=delete_account', {
      headers: {
        'x-user-token': token,
      },
    });

    expect(res.status).toBe(404);
  });
});

describe('OAuth continuation stale-session protection', () => {
  test('google link callback returns 403 for suspended accounts and does not link the provider', async () => {
    const runtime = makeTestRuntime();
    const callbackProvider = {
      validateAuthorizationCode() {
        return Promise.resolve({
          accessToken: () => 'provider-access-token',
        });
      },
    };
    runtime.oauth.providers.google = callbackProvider as never;

    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sub: 'google-sub-1' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const app = buildApp(runtime);
    const { id: userId } = await runtime.adapter.create('callback-blocked@example.com', 'hash');
    await runtime.oauth.stateStore.store('state-link-blocked', 'code-verifier-1', userId);
    await setSuspended(runtime.adapter, userId, true, 'security hold');

    const res = await app.request('/auth/google/callback?code=oauth-code&state=state-link-blocked');

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Account suspended' });
    const user = await runtime.adapter.getUser?.(userId);
    expect(user?.providerIds).not.toContain('google:google-sub-1');
    mockFetch.mockRestore();
  });

  test('github reauth callback returns 403 before issuing a confirmation code for suspended accounts', async () => {
    const runtime = makeTestRuntime({
      oauthReauth: {
        enabled: true,
        promptType: 'login',
      },
    });
    const provider = {
      validateAuthorizationCode() {
        return Promise.resolve({
          accessToken: () => 'provider-access-token',
        });
      },
      createAuthorizationURL(state: string) {
        const url = new URL('https://provider.example/reauth');
        url.searchParams.set('state', state);
        return url;
      },
    };
    const validateAuthorizationCode = spyOn(provider, 'validateAuthorizationCode');
    runtime.oauth.providers.github = provider as never;

    const app = buildApp(runtime, ['github']);
    const { id: userId } = await runtime.adapter.create('reauth-callback@example.com', 'hash');
    await runtime.adapter.linkProvider!(userId, 'github', 'gh-linked-callback');
    await runtime.oauth.stateStore.store(
      'state-reauth-blocked',
      undefined,
      `reauth:${userId}:sess-reauth-callback:${encodeURIComponent('delete_account')}`,
    );
    await setSuspended(runtime.adapter, userId, true, 'security hold');

    const res = await app.request(
      '/auth/github/reauth/callback?code=oauth-code&state=state-reauth-blocked',
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Account suspended' });
    expect(validateAuthorizationCode).not.toHaveBeenCalled();
    validateAuthorizationCode.mockRestore();
  });
});
