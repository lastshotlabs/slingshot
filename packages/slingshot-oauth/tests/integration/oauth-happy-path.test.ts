/**
 * Tests for OAuth happy-path login flow, postRedirect schema validation,
 * and allowedRedirectUrls safety checks.
 *
 * Covers:
 *   - Successful OAuth login: provider callback -> code exchange -> session
 *   - postRedirect schema validation (relative, absolute, protocol-relative)
 *   - Redirect target after successful OAuth login
 */
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { oauthPluginConfigSchema } from '../../src/plugin';
import { createOAuthRouter } from '../../src/routes/oauth';
import { makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';

type TestRuntime = ReturnType<typeof makeTestRuntime>;

function buildApp(runtime: TestRuntime, providers: string[] = ['google'], postRedirect = '/') {
  const app = wrapWithRuntime(runtime);
  app.route('/', createOAuthRouter(providers, postRedirect, runtime));
  return app;
}

// ---------------------------------------------------------------------------
// Successful OAuth login flow
// ---------------------------------------------------------------------------

describe('OAuth login happy path — provider callback to code exchange', () => {
  let runtime: TestRuntime;

  beforeEach(() => {
    runtime = makeTestRuntime();
  });

  test('successful Google OAuth callback issues a redirect with a one-time code', async () => {
    const callbackProvider = {
      createAuthorizationURL(state: string, codeVerifier: string, _scopes: string[]) {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('state', state);
        url.searchParams.set('code_verifier', codeVerifier);
        return url;
      },
      validateAuthorizationCode() {
        return Promise.resolve({
          accessToken: () => 'google-access-token',
        });
      },
    };
    runtime.oauth.providers.google = callbackProvider as never;

    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          sub: 'google-sub-happy',
          email: 'happy@example.com',
          name: 'Happy User',
          picture: 'https://example.com/avatar.jpg',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = buildApp(runtime, ['google'], '/dashboard');
    await runtime.oauth.stateStore.store('state-happy', 'code-verifier-happy');

    const callbackRes = await app.request(
      '/auth/google/callback?code=auth-code-123&state=state-happy',
    );

    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get('location') ?? '';
    expect(location).toContain('/dashboard');
    expect(location).toContain('code=');
    expect(location).toContain('user=happy%40example.com');

    // Extract the one-time code from the redirect URL
    const codeMatch = location.match(/code=([^&]+)/);
    expect(codeMatch).toBeTruthy();
    const oauthCode = codeMatch![1];

    // Exchange the code for a session token
    const exchangeRes = await app.request('/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: oauthCode }),
    });

    expect(exchangeRes.status).toBe(200);
    const exchangeBody = await exchangeRes.json();
    expect(exchangeBody.token).toBeString();
    expect(exchangeBody.token.length).toBeGreaterThan(0);

    mockFetch.mockRestore();
  });

  test('OAuth callback creates a new user and redirects with email parameter', async () => {
    const callbackProvider = {
      createAuthorizationURL(state: string, codeVerifier: string, _scopes: string[]) {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('state', state);
        url.searchParams.set('code_verifier', codeVerifier);
        return url;
      },
      validateAuthorizationCode() {
        return Promise.resolve({
          accessToken: () => 'google-access-token',
        });
      },
    };
    runtime.oauth.providers.google = callbackProvider as never;

    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          sub: 'google-sub-new',
          email: 'newuser@example.com',
          name: 'New User',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = buildApp(runtime, ['google'], '/welcome');
    await runtime.oauth.stateStore.store('state-new', 'code-verifier-new');

    const res = await app.request('/auth/google/callback?code=auth-code&state=state-new');

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/welcome');
    expect(location).toContain('code=');
    expect(location).toContain('user=newuser%40example.com');

    mockFetch.mockRestore();
  });

  test('OAuth login initiation redirects to provider consent screen', async () => {
    const loginProvider = {
      createAuthorizationURL(state: string, codeVerifier: string, _scopes: string[]) {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('state', state);
        url.searchParams.set('code_verifier', codeVerifier);
        return url;
      },
    };
    runtime.oauth.providers.google = loginProvider as never;

    const app = buildApp(runtime);

    const res = await app.request('/auth/google', {
      method: 'POST',
    });

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('accounts.google.com');
  });

  test('callback with invalid state returns 400', async () => {
    const callbackProvider = {
      validateAuthorizationCode() {
        return Promise.resolve({ accessToken: () => 'token' });
      },
    };
    runtime.oauth.providers.google = callbackProvider as never;

    const app = buildApp(runtime);

    const res = await app.request('/auth/google/callback?code=some-code&state=invalid-state');

    expect(res.status).toBe(400);
  });

  test('exchange with an already-consumed code fails', async () => {
    const callbackProvider = {
      createAuthorizationURL(state: string, codeVerifier: string, _scopes: string[]) {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('state', state);
        url.searchParams.set('code_verifier', codeVerifier);
        return url;
      },
      validateAuthorizationCode() {
        return Promise.resolve({
          accessToken: () => 'google-access-token',
        });
      },
    };
    runtime.oauth.providers.google = callbackProvider as never;

    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          sub: 'google-sub-replay',
          email: 'replay@example.com',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = buildApp(runtime, ['google'], '/app');
    await runtime.oauth.stateStore.store('state-replay', 'code-verifier-replay');

    const callbackRes = await app.request(
      '/auth/google/callback?code=code-replay&state=state-replay',
    );
    const location = callbackRes.headers.get('location') ?? '';
    const codeMatch = location.match(/code=([^&]+)/);
    const oauthCode = codeMatch![1];

    // First exchange succeeds
    const firstExchange = await app.request('/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: oauthCode }),
    });
    expect(firstExchange.status).toBe(200);

    // Second exchange with same code fails (one-time use)
    const secondExchange = await app.request('/auth/oauth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: oauthCode }),
    });
    expect(secondExchange.status).not.toBe(200);

    mockFetch.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// postRedirect URL validation (schema level)
// ---------------------------------------------------------------------------

describe('OAuth postRedirect schema validation', () => {
  test('accepts relative paths starting with /', () => {
    const result = oauthPluginConfigSchema.safeParse({ postRedirect: '/dashboard' });
    expect(result.success).toBe(true);
  });

  test('accepts relative path with query parameters', () => {
    const result = oauthPluginConfigSchema.safeParse({ postRedirect: '/callback?source=oauth' });
    expect(result.success).toBe(true);
  });

  test('accepts absolute HTTPS URLs', () => {
    const result = oauthPluginConfigSchema.safeParse({
      postRedirect: 'https://app.example.com/dashboard',
    });
    expect(result.success).toBe(true);
  });

  test('accepts absolute HTTP URLs', () => {
    const result = oauthPluginConfigSchema.safeParse({
      postRedirect: 'http://localhost:3000/dashboard',
    });
    expect(result.success).toBe(true);
  });

  test('rejects protocol-relative URLs (//) as postRedirect', () => {
    const result = oauthPluginConfigSchema.safeParse({
      postRedirect: '//evil.example.com/path',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty string as postRedirect', () => {
    const result = oauthPluginConfigSchema.safeParse({ postRedirect: '' });
    expect(result.success).toBe(false);
  });

  test('validates allowedRedirectUrls must be valid absolute HTTP URLs', () => {
    const result = oauthPluginConfigSchema.safeParse({
      allowedRedirectUrls: ['ftp://files.example.com'],
    });
    expect(result.success).toBe(false);
  });

  test('accepts valid absolute URLs in allowedRedirectUrls', () => {
    const result = oauthPluginConfigSchema.safeParse({
      allowedRedirectUrls: ['https://app.example.com', 'https://staging.example.com'],
    });
    expect(result.success).toBe(true);
  });

  test('rejects data: protocol in allowedRedirectUrls', () => {
    const result = oauthPluginConfigSchema.safeParse({
      allowedRedirectUrls: ['data:text/html,<h1>evil</h1>'],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Redirect behavior at the router level
// ---------------------------------------------------------------------------

describe('OAuth redirect behavior', () => {
  let runtime: TestRuntime;

  beforeEach(() => {
    runtime = makeTestRuntime();
  });

  test('successful login redirects to the configured postRedirect path', async () => {
    const callbackProvider = {
      createAuthorizationURL(state: string, codeVerifier: string, _scopes: string[]) {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('state', state);
        return url;
      },
      validateAuthorizationCode() {
        return Promise.resolve({
          accessToken: () => 'google-access-token',
        });
      },
    };
    runtime.oauth.providers.google = callbackProvider as never;

    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          sub: 'google-sub-redirect',
          email: 'redirect@example.com',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = buildApp(runtime, ['google'], '/custom/redirect');
    await runtime.oauth.stateStore.store('state-redirect', 'cv-redirect');

    const res = await app.request('/auth/google/callback?code=redirect-code&state=state-redirect');

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/custom/redirect');

    mockFetch.mockRestore();
  });

  test('successful login redirects to an absolute postRedirect URL', async () => {
    const callbackProvider = {
      createAuthorizationURL(state: string, codeVerifier: string, _scopes: string[]) {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('state', state);
        return url;
      },
      validateAuthorizationCode() {
        return Promise.resolve({
          accessToken: () => 'google-access-token',
        });
      },
    };
    runtime.oauth.providers.google = callbackProvider as never;

    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          sub: 'google-sub-abs',
          email: 'abs@example.com',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = buildApp(runtime, ['google'], 'https://app.example.com/dashboard');
    await runtime.oauth.stateStore.store('state-abs', 'cv-abs');

    const res = await app.request('/auth/google/callback?code=abs-code&state=state-abs');

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('https://app.example.com/dashboard');
    expect(location).toContain('code=');

    mockFetch.mockRestore();
  });
});
