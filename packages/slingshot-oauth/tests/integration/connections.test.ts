import { OAuth2Tokens } from 'arctic';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createMemoryProviderConnectionStore } from '@lastshotlabs/slingshot-auth';
import { COOKIE_TOKEN } from '@lastshotlabs/slingshot-core';
import { signToken } from '../../../slingshot-auth/src/lib/jwt';
import { createIdentifyMiddleware } from '../../../slingshot-auth/src/middleware/identify';
import { createConnectionsRouter } from '../../src/connections';
import type { ConnectionOAuthClient } from '../../src/connections';
import { makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';

type TestRuntime = ReturnType<typeof makeTestRuntime>;

function makeFakeClient(calls: { exchanged: string[] }): ConnectionOAuthClient {
  return {
    usesPkce: false,
    createAuthorizationURL: (state, _verifier, scopes) => {
      const url = new URL('https://provider.example/authorize');
      url.searchParams.set('state', state);
      url.searchParams.set('scope', scopes.join(' '));
      return url;
    },
    validateAuthorizationCode: async code => {
      calls.exchanged.push(code);
      return new OAuth2Tokens({
        access_token: `access-for-${code}`,
        refresh_token: `refresh-for-${code}`,
        expires_in: 3600,
        scope: 'scope-a scope-b',
      });
    },
    refreshAccessToken: async () =>
      new OAuth2Tokens({ access_token: 'refreshed', expires_in: 3600 }),
    fetchProviderUserId: async () => 'provider-user-42',
  };
}

describe('provider connections routes', () => {
  let runtime: TestRuntime;
  let store: ReturnType<typeof createMemoryProviderConnectionStore>;
  let app: ReturnType<typeof wrapWithRuntime>;
  let calls: { exchanged: string[] };

  async function createSession(email: string) {
    const { id: userId } = await runtime.adapter.create(email, 'hash');
    const sessionId = `sess-${email}`;
    const token = await signToken(
      { sub: userId, sid: sessionId },
      3600,
      runtime.config,
      runtime.signing,
    );
    await runtime.repos.session.createSession(userId, token, sessionId, undefined, runtime.config);
    return { userId, token };
  }

  const authed = (token: string) => ({ headers: { Cookie: `${COOKIE_TOKEN}=${token}` } });

  beforeEach(() => {
    runtime = makeTestRuntime();
    store = createMemoryProviderConnectionStore();
    (runtime.oauth as { connectionStore?: unknown }).connectionStore = store;
    calls = { exchanged: [] };

    app = wrapWithRuntime(runtime);
    app.use('*', createIdentifyMiddleware(runtime));
    app.route(
      '/',
      createConnectionsRouter(
        app,
        {
          providers: {
            fake: {
              clientId: 'client-id',
              clientSecret: 'client-secret',
              redirectUri: 'http://localhost/auth/connections/fake/callback',
              scopes: ['scope-a', 'scope-b'],
              createClient: () => makeFakeClient(calls),
            },
          },
          postRedirect: '/settings',
        },
        runtime,
        '/',
      ),
    );
  });

  async function startFlow(token: string): Promise<string> {
    const res = await app.request('/auth/connections/fake/start', authed(token));
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const url = new URL(location);
    expect(url.origin).toBe('https://provider.example');
    expect(url.searchParams.get('scope')).toBe('scope-a scope-b');
    return url.searchParams.get('state')!;
  }

  test('start requires an authenticated user', async () => {
    const res = await app.request('/auth/connections/fake/start');
    expect(res.status).toBe(401);
  });

  test('start 404s for an unknown provider', async () => {
    const { token } = await createSession('a@example.com');
    const res = await app.request('/auth/connections/nope/start', authed(token));
    expect(res.status).toBe(404);
  });

  test('happy path: start → callback stores tokens, provider id, granted scopes', async () => {
    const { userId, token } = await createSession('a@example.com');
    const state = await startFlow(token);

    const res = await app.request(
      `/auth/connections/fake/callback?state=${encodeURIComponent(state)}&code=abc123`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/settings?connected=fake');
    expect(calls.exchanged).toEqual(['abc123']);

    const row = await store.get(userId, 'fake');
    expect(row).not.toBeNull();
    expect(row!.accessToken).toBe('access-for-abc123');
    expect(row!.refreshToken).toBe('refresh-for-abc123');
    expect(row!.providerUserId).toBe('provider-user-42');
    expect(row!.scopes).toEqual(['scope-a', 'scope-b']);
    expect(row!.accessTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  test('callback rejects a fabricated state and a replayed state (CSRF / single-use)', async () => {
    const { token } = await createSession('a@example.com');

    const forged = await app.request('/auth/connections/fake/callback?state=forged&code=abc');
    expect(forged.status).toBe(400);

    const state = await startFlow(token);
    const first = await app.request(
      `/auth/connections/fake/callback?state=${encodeURIComponent(state)}&code=one`,
    );
    expect(first.status).toBe(302);
    const replay = await app.request(
      `/auth/connections/fake/callback?state=${encodeURIComponent(state)}&code=two`,
    );
    expect(replay.status).toBe(400);
    expect(calls.exchanged).toEqual(['one']);
  });

  test('callback with a DIFFERENT authenticated user rejects', async () => {
    const { token } = await createSession('owner@example.com');
    const { token: otherToken } = await createSession('other@example.com');
    const state = await startFlow(token);

    const res = await app.request(
      `/auth/connections/fake/callback?state=${encodeURIComponent(state)}&code=abc`,
      authed(otherToken),
    );
    expect(res.status).toBe(401);
  });

  test('provider consent denial redirects with an error code, storing nothing', async () => {
    const { userId, token } = await createSession('a@example.com');
    await startFlow(token);
    const res = await app.request('/auth/connections/fake/callback?error=access_denied');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/settings?error=consent_denied');
    expect(await store.get(userId, 'fake')).toBeNull();
  });

  test('list returns the caller’s connections and never leaks tokens', async () => {
    const { token } = await createSession('a@example.com');
    const state = await startFlow(token);
    await app.request(`/auth/connections/fake/callback?state=${encodeURIComponent(state)}&code=c1`);

    const res = await app.request('/auth/connections', authed(token));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"fake"');
    expect(body).toContain('provider-user-42');
    expect(body).not.toContain('access-for-c1');
    expect(body).not.toContain('refresh-for-c1');

    const anonymous = await app.request('/auth/connections');
    expect(anonymous.status).toBe(401);
  });

  test('unlink deletes the connection; a second unlink 404s', async () => {
    const { token } = await createSession('a@example.com');
    const state = await startFlow(token);
    await app.request(`/auth/connections/fake/callback?state=${encodeURIComponent(state)}&code=c1`);

    const del = await app.request('/auth/connections/fake', {
      method: 'DELETE',
      ...authed(token),
    });
    expect(del.status).toBe(200);

    const again = await app.request('/auth/connections/fake', {
      method: 'DELETE',
      ...authed(token),
    });
    expect(again.status).toBe(404);
  });
});
