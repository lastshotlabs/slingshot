/**
 * Integration tests for POST /auth/refresh — token refresh and rotation.
 *
 * Covers:
 *   - Happy path: login → refresh → new tokens
 *   - Token rotation: new access and refresh tokens differ from originals
 *   - Invalid / missing refresh token → 401
 *   - Expired / revoked session → 401
 *   - Grace window: old token still works immediately after rotation
 *   - Response shape validation
 *   - UserId consistency across refresh
 *   - Rate limiting (429 after 30 rapid attempts)
 *   - Refresh token via cookie and x-refresh-token header
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { COOKIE_CSRF_TOKEN, HttpError } from '@lastshotlabs/slingshot-core';
import { createLoginRouter } from '../../src/routes/login';
import { createRefreshRouter } from '../../src/routes/refresh';
import { makeEventBus, makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';
import type { MutableTestRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REFRESH_CONFIG = {
  accessTokenExpiry: 900,
  refreshTokenExpiry: 2_592_000,
  rotationGraceSeconds: 10,
} as const;

const jsonPost = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function buildApp(runtime: MutableTestRuntime) {
  const app = wrapWithRuntime(runtime);
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.route(
    '/',
    createLoginRouter({ primaryField: 'email', refreshTokens: REFRESH_CONFIG }, runtime),
  );
  app.route('/', createRefreshRouter({ refreshTokens: REFRESH_CONFIG }, runtime));
  return app;
}

async function registerAndLogin(
  runtime: MutableTestRuntime,
  app: ReturnType<typeof buildApp>,
  email = 'user@example.com',
  password = 'StrongP@ss1!',
): Promise<{ token: string; refreshToken: string; userId: string }> {
  const hash = await Bun.password.hash(password);
  await runtime.adapter.create(email, hash);
  const res = await app.request('/auth/login', jsonPost({ email, password }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.refreshToken).toBeDefined();
  return body as { token: string; refreshToken: string; userId: string };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /auth/refresh', () => {
  let runtime: MutableTestRuntime;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    runtime = makeTestRuntime({
      concealRegistration: null,
      refreshToken: REFRESH_CONFIG,
    });
    runtime.eventBus = makeEventBus();
    app = buildApp(runtime);
  });

  // 1. Happy path
  test('returns 200 with new tokens on valid refresh', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request('/auth/refresh', jsonPost({ refreshToken: login.refreshToken }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(typeof body.userId).toBe('string');
  });

  // 2. New access token is a valid JWT string
  test('returns a valid JWT access token on refresh', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request('/auth/refresh', jsonPost({ refreshToken: login.refreshToken }));
    const body = await res.json();
    // The token is a JWT (three dot-separated Base64 segments)
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  // 3. Token rotation — new refresh token differs from old
  test('rotates the refresh token (new differs from old)', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request('/auth/refresh', jsonPost({ refreshToken: login.refreshToken }));
    const body = await res.json();
    expect(body.refreshToken).not.toBe(login.refreshToken);
  });

  // 4. Invalid refresh token
  test('returns 401 for an invalid refresh token', async () => {
    await registerAndLogin(runtime, app);
    const res = await app.request(
      '/auth/refresh',
      jsonPost({ refreshToken: 'totally-bogus-token' }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  // 5. Missing refresh token
  test('returns 401 when refresh token is missing from body', async () => {
    await registerAndLogin(runtime, app);
    const res = await app.request('/auth/refresh', jsonPost({}));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/[Rr]efresh token/);
  });

  // 6. Expired / revoked session
  test('returns 401 when the session has been deleted', async () => {
    const login = await registerAndLogin(runtime, app);

    // Grab the session and delete it directly via the repo
    const sessionRepo = runtime.repos.session;
    const result = await sessionRepo.getSessionByRefreshToken(login.refreshToken, runtime.config);
    expect(result).not.toBeNull();
    await sessionRepo.deleteSession(result!.sessionId, runtime.config);

    const res = await app.request('/auth/refresh', jsonPost({ refreshToken: login.refreshToken }));
    expect(res.status).toBe(401);
  });

  test('returns 403 when the user is suspended before refresh', async () => {
    const login = await registerAndLogin(runtime, app, 'suspended-refresh@example.com');
    await runtime.adapter.setSuspended?.(login.userId, true, 'admin lock');

    const res = await app.request('/auth/refresh', jsonPost({ refreshToken: login.refreshToken }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('suspended');
  });

  test('returns 403 when email verification becomes required before refresh', async () => {
    runtime.config = {
      ...runtime.config,
      primaryField: 'email',
      emailVerification: { required: true, tokenExpiry: 86400 },
    };
    app = buildApp(runtime);

    const hash = await Bun.password.hash('StrongP@ss1!');
    const user = await runtime.adapter.create('refresh-verify@example.com', hash);
    await runtime.adapter.setEmailVerified?.(user.id, true);
    const res = await app.request(
      '/auth/login',
      jsonPost({ email: 'refresh-verify@example.com', password: 'StrongP@ss1!' }),
    );
    expect(res.status).toBe(200);
    const login = (await res.json()) as { refreshToken: string; userId: string };
    await runtime.adapter.setEmailVerified?.(login.userId, false);

    const refreshRes = await app.request(
      '/auth/refresh',
      jsonPost({ refreshToken: login.refreshToken }),
    );
    expect(refreshRes.status).toBe(403);
    const body = await refreshRes.json();
    expect(body.error).toContain('Email not verified');
  });

  // 7. Token rotation grace window — old token still works immediately after rotation
  test('old refresh token still works within the grace window after rotation', async () => {
    const login = await registerAndLogin(runtime, app);
    const oldRefreshToken = login.refreshToken;

    // First refresh — rotates the token
    const res1 = await app.request('/auth/refresh', jsonPost({ refreshToken: oldRefreshToken }));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.refreshToken).not.toBe(oldRefreshToken);

    // Second refresh — use the OLD token within the grace window (10s)
    const res2 = await app.request('/auth/refresh', jsonPost({ refreshToken: oldRefreshToken }));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(typeof body2.token).toBe('string');
    expect(typeof body2.refreshToken).toBe('string');
  });

  // 8. Completely bogus token always fails (no grace window applies)
  test('bogus token fails regardless of grace window', async () => {
    await registerAndLogin(runtime, app);
    const res = await app.request('/auth/refresh', jsonPost({ refreshToken: crypto.randomUUID() }));
    expect(res.status).toBe(401);
  });

  // 9. Response shape
  test('response contains token, userId, and refreshToken', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request('/auth/refresh', jsonPost({ refreshToken: login.refreshToken }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('token');
    expect(body).toHaveProperty('userId');
    expect(body).toHaveProperty('refreshToken');
    // Ensure no unexpected null/undefined values
    expect(body.token).toBeTruthy();
    expect(body.userId).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  // 10. UserId matches original login
  test('userId in refresh response matches the original login userId', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request('/auth/refresh', jsonPost({ refreshToken: login.refreshToken }));
    const body = await res.json();
    expect(body.userId).toBe(login.userId);
  });

  // 11. Rate limiting — 31 rapid requests should trigger 429
  test('returns 429 after exceeding the refresh rate limit (30 per 60s)', async () => {
    const login = await registerAndLogin(runtime, app);

    // Fire 30 requests — all should succeed or use valid tokens.
    // After rotation, we need fresh tokens each time. Use a sequential chain.
    let currentRefreshToken = login.refreshToken;
    for (let i = 0; i < 30; i++) {
      const res = await app.request(
        '/auth/refresh',
        jsonPost({ refreshToken: currentRefreshToken }),
      );
      // Some may 401 due to rotation, but rate limit counter still increments.
      if (res.status === 200) {
        const body = await res.json();
        currentRefreshToken = body.refreshToken;
      }
    }

    // 31st request should be rate-limited
    const res = await app.request('/auth/refresh', jsonPost({ refreshToken: currentRefreshToken }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/[Tt]oo many/);
  });

  // 12a. Refresh token via cookie
  test('accepts refresh token from the refresh_token cookie', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `refresh_token=${login.refreshToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    expect(body.userId).toBe(login.userId);
  });

  // 12b. Refresh token via x-refresh-token header
  test('accepts refresh token from the x-refresh-token header', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-refresh-token': login.refreshToken,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    expect(body.userId).toBe(login.userId);
  });

  // 13. Response sets cookies for both access and refresh tokens
  test('sets slingshot_token and refresh_token cookies in the response', async () => {
    const login = await registerAndLogin(runtime, app);
    const res = await app.request('/auth/refresh', jsonPost({ refreshToken: login.refreshToken }));
    expect(res.status).toBe(200);
    const setCookieHeaders = res.headers.getSetCookie();
    const cookieNames = setCookieHeaders.map(h => h.split('=')[0]);
    expect(cookieNames).toContain('token');
    expect(cookieNames).toContain('refresh_token');
  });

  test('rotates CSRF cookie when CSRF is enabled', async () => {
    runtime = makeTestRuntime({
      concealRegistration: null,
      refreshToken: REFRESH_CONFIG,
      csrfEnabled: true,
    });
    runtime.eventBus = makeEventBus();
    app = buildApp(runtime);

    const login = await registerAndLogin(runtime, app);
    const res = await app.request('/auth/refresh', jsonPost({ refreshToken: login.refreshToken }));
    expect(res.status).toBe(200);

    const setCookieHeaders = res.headers.getSetCookie();
    const cookieNames = setCookieHeaders.map(h => h.split('=')[0]);
    expect(cookieNames).toContain(COOKIE_CSRF_TOKEN);
  });

  test('uses __Host- cookie names in production-safe configurations', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      runtime = makeTestRuntime({
        concealRegistration: null,
        refreshToken: REFRESH_CONFIG,
      });
      runtime.eventBus = makeEventBus();
      app = buildApp(runtime);

      const login = await registerAndLogin(runtime, app);
      const res = await app.request(
        '/auth/refresh',
        jsonPost({ refreshToken: login.refreshToken }),
      );
      expect(res.status).toBe(200);

      const setCookieHeaders = res.headers.getSetCookie();
      const cookieNames = setCookieHeaders.map(h => h.split('=')[0]);
      expect(cookieNames).toContain('__Host-token');
      expect(cookieNames).toContain('__Host-refresh_token');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  // 14. Chained refreshes work (refresh → refresh → refresh)
  test('supports multiple sequential refreshes with rotated tokens', async () => {
    const login = await registerAndLogin(runtime, app);
    let currentToken = login.refreshToken;

    for (let i = 0; i < 3; i++) {
      const res = await app.request('/auth/refresh', jsonPost({ refreshToken: currentToken }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.refreshToken).not.toBe(currentToken);
      currentToken = body.refreshToken;
    }
  });

  // 15. Body refresh token takes priority over cookie
  test('body refreshToken takes precedence over cookie', async () => {
    const login = await registerAndLogin(runtime, app);
    // Send a valid token in body but bogus in cookie — should use the body token
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'refresh_token=bogus-cookie-token',
      },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    });
    expect(res.status).toBe(200);
  });
});
