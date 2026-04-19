import { storeOAuthCode } from '@auth/lib/oauthCode';
import type { OAuthCodeRepository } from '@auth/lib/oauthCode';
import { getAuthRuntimeContext } from '@auth/runtime';
import { beforeEach, describe, expect, it } from 'bun:test';
import { getContext } from '@lastshotlabs/slingshot-core';
import { authHeader, createTestApp } from '../setup';

let app: any;
let oauthCodeRepo: OAuthCodeRepository;

function getCsrfCookie(res: Response): string | null {
  const cookies = res.headers.getSetCookie();
  for (const cookie of cookies) {
    if (cookie.startsWith('csrf_token=')) {
      return cookie.split(';')[0].split('=').slice(1).join('=');
    }
  }
  return null;
}

// Helper to create a JSON POST request
const json = (path: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('OAuth exchange endpoint', () => {
  beforeEach(async () => {
    app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          // At least one provider must be configured to mount the OAuth router
          // (including the /auth/oauth/exchange endpoint tested here).
          oauth: {
            providers: {
              google: {
                clientId: 'test-client-id',
                clientSecret: 'test-client-secret',
                redirectUri: 'http://localhost/auth/oauth/callback/google',
              },
            },
          },
        },
      },
    );
    const ctx = getContext(app);
    const runtime = getAuthRuntimeContext(ctx.pluginState);
    oauthCodeRepo = runtime.repos.oauthCode;
  });

  it('exchanges a valid code for session token', async () => {
    // Pre-store a code in the memory store
    const code = await storeOAuthCode(
      oauthCodeRepo,
      {
        token: 'jwt-token-abc',
        userId: 'user-123',
        email: 'oauth@example.com',
      },
      [],
    );

    const res = await app.request(json('/auth/oauth/exchange', { code }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.token).toBe('jwt-token-abc');
    expect(data.userId).toBe('user-123');
    expect(data.email).toBe('oauth@example.com');
  });

  it('code is single-use', async () => {
    const code = await storeOAuthCode(
      oauthCodeRepo,
      {
        token: 'jwt-token',
        userId: 'user-1',
      },
      [],
    );

    const res1 = await app.request(json('/auth/oauth/exchange', { code }));
    expect(res1.status).toBe(200);

    const res2 = await app.request(json('/auth/oauth/exchange', { code }));
    expect(res2.status).toBe(401);
    const data = await res2.json();
    expect(data.error).toBe('Invalid or expired code');
  });

  it('returns 401 for invalid code', async () => {
    const res = await app.request(json('/auth/oauth/exchange', { code: 'totally-invalid' }));
    expect(res.status).toBe(401);
  });

  it('includes refreshToken when configured', async () => {
    const appWithRefresh = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          refreshTokens: {
            accessTokenExpiry: 900,
            refreshTokenExpiry: 86400,
            rotationGraceSeconds: 30,
          },
          oauth: {
            providers: {
              google: {
                clientId: 'test-client-id',
                clientSecret: 'test-client-secret',
                redirectUri: 'http://localhost/auth/oauth/callback/google',
              },
            },
          },
        },
      },
    );
    const refreshCtx = getContext(appWithRefresh);
    const refreshRuntime = getAuthRuntimeContext(refreshCtx.pluginState);

    const code = await storeOAuthCode(
      refreshRuntime.repos.oauthCode,
      {
        token: 'jwt-with-rt',
        userId: 'user-rt',
        refreshToken: 'refresh-token-xyz',
      },
      [],
    );

    const res = await appWithRefresh.request(json('/auth/oauth/exchange', { code }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.refreshToken).toBe('refresh-token-xyz');
  });

  it('sets session cookies in response', async () => {
    const code = await storeOAuthCode(
      oauthCodeRepo,
      {
        token: 'jwt-cookie',
        userId: 'user-cookie',
      },
      [],
    );

    const res = await app.request(json('/auth/oauth/exchange', { code }));
    expect(res.status).toBe(200);

    const cookies = res.headers.get('set-cookie');
    expect(cookies).toContain('token=');
  });

  it('rate limits exchange attempts per IP', async () => {
    // Make 20 attempts to exhaust the rate limit
    for (let i = 0; i < 20; i++) {
      await app.request(json('/auth/oauth/exchange', { code: `invalid-${i}` }));
    }

    const res = await app.request(json('/auth/oauth/exchange', { code: 'one-more' }));
    expect(res.status).toBe(429);
  });
});

describe('OAuth exchange endpoint CSRF protection', () => {
  it('requires CSRF for code exchange when CSRF is enabled', async () => {
    const csrfApp = await createTestApp(
      {},
      {
        security: {
          csrf: { enabled: true },
        },
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          oauth: {
            providers: {
              google: {
                clientId: 'test-client-id',
                clientSecret: 'test-client-secret',
                redirectUri: 'http://localhost/auth/oauth/callback/google',
              },
            },
          },
        },
      },
    );
    const runtime = getAuthRuntimeContext(getContext(csrfApp).pluginState);
    const code = await storeOAuthCode(
      runtime.repos.oauthCode,
      {
        token: 'jwt-token-csrf',
        userId: 'user-csrf',
      },
      [],
    );

    const missingCsrf = await csrfApp.request(json('/auth/oauth/exchange', { code }));
    expect(missingCsrf.status).toBe(403);

    const getRes = await csrfApp.request('/health');
    const csrfToken = getCsrfCookie(getRes);
    expect(csrfToken).toBeTruthy();

    const exchangeCode = await storeOAuthCode(
      runtime.repos.oauthCode,
      {
        token: 'jwt-token-csrf-ok',
        userId: 'user-csrf-ok',
      },
      [],
    );

    const okRes = await csrfApp.request(
      json(
        '/auth/oauth/exchange',
        { code: exchangeCode },
        {
          Cookie: `csrf_token=${csrfToken}`,
          'x-csrf-token': csrfToken!,
        },
      ),
    );
    expect(okRes.status).toBe(200);
  });
});
