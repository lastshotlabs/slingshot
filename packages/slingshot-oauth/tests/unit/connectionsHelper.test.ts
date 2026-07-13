import { OAuth2Tokens } from 'arctic';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createMemoryProviderConnectionStore } from '@lastshotlabs/slingshot-auth';
import {
  createConnectionsRouter,
  getConnectionAccessToken,
  getProviderConnection,
} from '../../src/connections';
import type { ConnectionOAuthClient } from '../../src/connections';
import { makeTestRuntime } from '../helpers/runtime';

function makeTokens(data: Record<string, unknown>) {
  return new OAuth2Tokens(data);
}

function makeFakeClient(overrides: Partial<ConnectionOAuthClient> = {}): ConnectionOAuthClient {
  return {
    usesPkce: false,
    createAuthorizationURL: state => new URL(`https://provider.example/authorize?state=${state}`),
    validateAuthorizationCode: async () =>
      makeTokens({ access_token: 'fresh', expires_in: 3600, refresh_token: 'r1' }),
    refreshAccessToken: async () => makeTokens({ access_token: 'refreshed', expires_in: 3600 }),
    ...overrides,
  };
}

describe('getConnectionAccessToken', () => {
  let app: object;
  let store: ReturnType<typeof createMemoryProviderConnectionStore>;
  let refreshCalls: string[];

  function setup(client: ConnectionOAuthClient) {
    app = {};
    store = createMemoryProviderConnectionStore();
    const runtime = makeTestRuntime();
    (runtime.oauth as { connectionStore?: unknown }).connectionStore = store;
    // Registering the router installs the WeakMap runtime for the helpers.
    createConnectionsRouter(
      app,
      {
        providers: {
          fake: {
            clientId: 'id',
            clientSecret: 'secret',
            redirectUri: 'http://localhost/cb',
            scopes: ['a'],
            createClient: () => client,
          },
        },
      },
      runtime,
      '/',
    );
  }

  beforeEach(() => {
    refreshCalls = [];
  });

  test('returns the stored token untouched when comfortably unexpired', async () => {
    setup(
      makeFakeClient({
        refreshAccessToken: async token => {
          refreshCalls.push(token);
          return makeTokens({ access_token: 'refreshed', expires_in: 3600 });
        },
      }),
    );
    const expiresAt = Date.now() + 30 * 60_000;
    await store.upsert({
      userId: 'u1',
      provider: 'fake',
      providerUserId: null,
      scopes: ['a'],
      accessToken: 'stored',
      refreshToken: 'r0',
      accessTokenExpiresAt: expiresAt,
    });

    const token = await getConnectionAccessToken(app, 'u1', 'fake');
    expect(token).toEqual({ accessToken: 'stored', expiresAt });
    expect(refreshCalls).toHaveLength(0);
  });

  test('refreshes an expired token and keeps the old refresh token when none is rotated', async () => {
    setup(
      makeFakeClient({
        refreshAccessToken: async token => {
          refreshCalls.push(token);
          return makeTokens({ access_token: 'refreshed', expires_in: 3600 });
        },
      }),
    );
    await store.upsert({
      userId: 'u1',
      provider: 'fake',
      providerUserId: null,
      scopes: ['a'],
      accessToken: 'stale',
      refreshToken: 'r0',
      accessTokenExpiresAt: Date.now() - 1000,
    });

    const token = await getConnectionAccessToken(app, 'u1', 'fake');
    expect(token?.accessToken).toBe('refreshed');
    expect(refreshCalls).toEqual(['r0']);
    const row = await store.get('u1', 'fake');
    expect(row?.accessToken).toBe('refreshed');
    expect(row?.refreshToken).toBe('r0'); // not rotated → preserved
    expect(row?.accessTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  test('persists a rotated refresh token when the provider returns one', async () => {
    setup(
      makeFakeClient({
        refreshAccessToken: async () =>
          makeTokens({ access_token: 'refreshed', expires_in: 3600, refresh_token: 'r-next' }),
      }),
    );
    await store.upsert({
      userId: 'u1',
      provider: 'fake',
      providerUserId: null,
      scopes: ['a'],
      accessToken: 'stale',
      refreshToken: 'r0',
      accessTokenExpiresAt: Date.now() - 1000,
    });

    await getConnectionAccessToken(app, 'u1', 'fake');
    expect((await store.get('u1', 'fake'))?.refreshToken).toBe('r-next');
  });

  test('refreshes inside the 60s expiry window, not only after expiry', async () => {
    setup(makeFakeClient());
    await store.upsert({
      userId: 'u1',
      provider: 'fake',
      providerUserId: null,
      scopes: ['a'],
      accessToken: 'nearly-stale',
      refreshToken: 'r0',
      accessTokenExpiresAt: Date.now() + 10_000, // inside the 60s window
    });
    const token = await getConnectionAccessToken(app, 'u1', 'fake');
    expect(token?.accessToken).toBe('refreshed');
  });

  test('returns null when refresh fails (revoked consent) and keeps the row for reconnect UX', async () => {
    setup(
      makeFakeClient({
        refreshAccessToken: async () => {
          throw new Error('invalid_grant');
        },
      }),
    );
    await store.upsert({
      userId: 'u1',
      provider: 'fake',
      providerUserId: null,
      scopes: ['a'],
      accessToken: 'stale',
      refreshToken: 'r0',
      accessTokenExpiresAt: Date.now() - 1000,
    });

    expect(await getConnectionAccessToken(app, 'u1', 'fake')).toBeNull();
    expect(await store.get('u1', 'fake')).not.toBeNull();
  });

  test('returns null for a missing connection, an unknown provider, and a missing refresh token', async () => {
    setup(makeFakeClient());
    expect(await getConnectionAccessToken(app, 'u1', 'fake')).toBeNull();
    expect(await getConnectionAccessToken(app, 'u1', 'not-configured')).toBeNull();
    await store.upsert({
      userId: 'u1',
      provider: 'fake',
      providerUserId: null,
      scopes: ['a'],
      accessToken: 'stale',
      refreshToken: null,
      accessTokenExpiresAt: Date.now() - 1000,
    });
    expect(await getConnectionAccessToken(app, 'u1', 'fake')).toBeNull();
  });

  test('getProviderConnection returns a sanitized summary without token fields', async () => {
    setup(makeFakeClient());
    await store.upsert({
      userId: 'u1',
      provider: 'fake',
      providerUserId: 'pid',
      scopes: ['a'],
      accessToken: 'secret-token',
      refreshToken: 'secret-refresh',
      accessTokenExpiresAt: Date.now() + 1000,
    });
    const summary = await getProviderConnection(app, 'u1', 'fake');
    expect(summary?.provider).toBe('fake');
    expect(summary?.providerUserId).toBe('pid');
    expect(JSON.stringify(summary)).not.toContain('secret-token');
    expect(JSON.stringify(summary)).not.toContain('secret-refresh');
  });

  test('helpers throw a clear error for an app without connections configured', async () => {
    expect(getConnectionAccessToken({}, 'u1', 'fake')).rejects.toThrow(/not configured/);
  });
});
