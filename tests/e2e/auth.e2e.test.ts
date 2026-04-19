import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type E2EServerHandle, createCookieJar, createTestHttpServer } from '../setup-e2e';

let handle: E2EServerHandle;

beforeAll(async () => {
  handle = await createTestHttpServer();
});

afterAll(() => handle.stop());
const post = (url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

describe('POST /auth/register — E2E', () => {
  test('creates a new user and returns token + userId', async () => {
    const jar = createCookieJar();

    const res = await post(`${handle.baseUrl}/auth/register`, {
      email: 'e2e-register@example.com',
      password: 'Password123!',
    });
    jar.absorb(res);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.userId).toBeString();
    expect(body.email).toBe('e2e-register@example.com');
  });

  test('rejects duplicate email with 409', async () => {
    await post(`${handle.baseUrl}/auth/register`, {
      email: 'dupe@example.com',
      password: 'Password123!',
    });

    const res = await post(`${handle.baseUrl}/auth/register`, {
      email: 'dupe@example.com',
      password: 'Password123!',
    });
    expect(res.status).toBe(409);
  });

  test('rejects missing password with 400', async () => {
    const res = await post(`${handle.baseUrl}/auth/register`, {
      email: 'nopw@example.com',
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe('POST /auth/login — E2E', () => {
  test('returns token for valid credentials', async () => {
    await post(`${handle.baseUrl}/auth/register`, {
      email: 'login@example.com',
      password: 'Password123!',
    });

    const res = await post(`${handle.baseUrl}/auth/login`, {
      email: 'login@example.com',
      password: 'Password123!',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.userId).toBeString();
  });

  test('rejects invalid password with 401', async () => {
    await post(`${handle.baseUrl}/auth/register`, {
      email: 'badpw@example.com',
      password: 'Password123!',
    });

    const res = await post(`${handle.baseUrl}/auth/login`, {
      email: 'badpw@example.com',
      password: 'WrongPassword!',
    });
    expect(res.status).toBe(401);
  });

  test('rejects non-existent user with 401', async () => {
    const res = await post(`${handle.baseUrl}/auth/login`, {
      email: 'nobody@example.com',
      password: 'Password123!',
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------

describe('GET /auth/me — E2E', () => {
  test('register → login → GET /auth/me round-trip', async () => {
    const jar = createCookieJar();

    const regRes = await post(`${handle.baseUrl}/auth/register`, {
      email: 'me@example.com',
      password: 'Password123!',
    });
    jar.absorb(regRes);
    expect(regRes.status).toBe(201);
    const { token, userId } = await regRes.json();

    const meRes = await fetch(`${handle.baseUrl}/auth/me`, {
      headers: { 'x-user-token': token, ...jar.header() },
    });
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me.userId).toBe(userId);
    expect(me.email).toBe('me@example.com');
  });

  test('returns 401 without token', async () => {
    const res = await fetch(`${handle.baseUrl}/auth/me`);
    expect(res.status).toBe(401);
  });

  test('returns 401 with invalid token', async () => {
    const res = await fetch(`${handle.baseUrl}/auth/me`, {
      headers: { 'x-user-token': 'not-a-real-token' },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

describe('POST /auth/logout — E2E', () => {
  test('logout invalidates session — subsequent /auth/me returns 401', async () => {
    const regRes = await post(`${handle.baseUrl}/auth/register`, {
      email: 'logout@example.com',
      password: 'Password123!',
    });
    const { token } = await regRes.json();

    const logoutRes = await post(
      `${handle.baseUrl}/auth/logout`,
      {},
      {
        'x-user-token': token,
      },
    );
    expect(logoutRes.status).toBe(200);

    const meRes = await fetch(`${handle.baseUrl}/auth/me`, {
      headers: { 'x-user-token': token },
    });
    expect(meRes.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Refresh token rotation
// ---------------------------------------------------------------------------

describe('POST /auth/refresh — E2E', () => {
  test('login → get refreshToken → POST /auth/refresh → new token works', async () => {
    // Create app with refresh tokens enabled
    const rtHandle = await createTestHttpServer(
      {},
      {
        auth: {
          refreshTokens: {
            accessTokenExpiry: 900,
            refreshTokenExpiry: 86400,
          },
        },
      },
    );

    try {
      const regRes = await post(`${rtHandle.baseUrl}/auth/register`, {
        email: 'refresh@example.com',
        password: 'Password123!',
      });
      expect(regRes.status).toBe(201);
      const { refreshToken } = await regRes.json();
      expect(refreshToken).toBeString();

      const refreshRes = await post(`${rtHandle.baseUrl}/auth/refresh`, {
        refreshToken,
      });
      expect(refreshRes.status).toBe(200);
      const refreshBody = await refreshRes.json();
      expect(refreshBody.token).toBeString();
      expect(refreshBody.refreshToken).toBeString();
      expect(refreshBody.refreshToken).not.toBe(refreshToken);

      // New access token should work
      const meRes = await fetch(`${rtHandle.baseUrl}/auth/me`, {
        headers: { 'x-user-token': refreshBody.token },
      });
      expect(meRes.status).toBe(200);
    } finally {
      rtHandle.stop();
    }
  });

  test('invalid refresh token returns 401', async () => {
    const rtHandle = await createTestHttpServer(
      {},
      {
        auth: {
          refreshTokens: {
            accessTokenExpiry: 900,
            refreshTokenExpiry: 86400,
          },
        },
      },
    );

    try {
      const res = await post(`${rtHandle.baseUrl}/auth/refresh`, {
        refreshToken: 'not-a-real-refresh-token',
      });
      expect(res.status).toBe(401);
    } finally {
      rtHandle.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Cookie jar round-trip
// ---------------------------------------------------------------------------

describe('cookie jar — E2E', () => {
  test('absorbs Set-Cookie from register response and re-sends on subsequent calls', async () => {
    const jar = createCookieJar();

    const regRes = await post(`${handle.baseUrl}/auth/register`, {
      email: 'cookies@example.com',
      password: 'Password123!',
    });
    jar.absorb(regRes);
    const { token } = await regRes.json();

    // Cookies are re-sent on the next request
    const meRes = await fetch(`${handle.baseUrl}/auth/me`, {
      headers: { 'x-user-token': token, ...jar.header() },
    });
    expect(meRes.status).toBe(200);

    // Clear cookies and verify header() returns empty
    jar.clear();
    expect(jar.header()).toEqual({});
  });
});
