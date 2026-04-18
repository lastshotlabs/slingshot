import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

let app: OpenAPIHono<any>;

beforeEach(async () => {
  app = await createTestApp(
    {},
    {
      security: {
        csrf: { enabled: true },
      },
      auth: { enabled: true },
    },
  );
});

function getCsrfCookie(res: Response): string | null {
  const cookies = res.headers.getSetCookie();
  for (const cookie of cookies) {
    if (cookie.startsWith('csrf_token=')) {
      return cookie.split(';')[0].split('=').slice(1).join('=');
    }
  }
  return null;
}

function getAuthCookie(res: Response): string | null {
  const cookies = res.headers.getSetCookie();
  for (const cookie of cookies) {
    if (cookie.startsWith('token=')) {
      return cookie.split(';')[0].split('=').slice(1).join('=');
    }
  }
  return null;
}

describe('CSRF middleware', () => {
  test('GET request sets CSRF cookie', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const csrfToken = getCsrfCookie(res);
    expect(csrfToken).toBeTruthy();
    // Token should be in format: hex.hex (token.signature)
    expect(csrfToken).toMatch(/^[a-f0-9]+\.[a-f0-9]+$/);
  });

  test('GET request passes through without CSRF header', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  test('POST without auth cookie passes (no CSRF vulnerability)', async () => {
    const res = await app.request('/public/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  test('public session-establishing auth routes require CSRF even without an auth cookie', async () => {
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'csrf-public@test.com', password: 'Password123' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('CSRF token');
  });

  test('POST with auth cookie but no CSRF header returns 403', async () => {
    const getRes = await app.request('/health');
    const csrfToken = getCsrfCookie(getRes);
    expect(csrfToken).toBeTruthy();

    // Register to get an auth cookie
    const regRes = await app.request('/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `csrf_token=${csrfToken}`,
        'x-csrf-token': csrfToken!,
      },
      body: JSON.stringify({ email: 'csrf@test.com', password: 'Password123' }),
    });
    expect(regRes.status).toBe(201);
    const authToken = getAuthCookie(regRes);
    expect(authToken).toBeTruthy();

    // POST with auth cookie but no CSRF token
    const res = await app.request('/protected/action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `token=${authToken}`,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('CSRF token');
  });

  test('POST with auth cookie + valid CSRF header+cookie passes', async () => {
    // Get CSRF token via GET
    const getRes = await app.request('/health');
    const csrfToken = getCsrfCookie(getRes);
    expect(csrfToken).toBeTruthy();

    // Register to get an auth cookie
    const regRes = await app.request('/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `csrf_token=${csrfToken}`,
        'x-csrf-token': csrfToken!,
      },
      body: JSON.stringify({ email: 'csrf2@test.com', password: 'Password123' }),
    });
    expect(regRes.status).toBe(201);
    const authToken = getAuthCookie(regRes);
    // Login refreshes the CSRF token
    const newCsrfToken = getCsrfCookie(regRes);
    expect(newCsrfToken).toBeTruthy();
    expect(newCsrfToken).not.toBe(csrfToken); // refreshed

    // POST with both auth cookie and valid CSRF
    const res = await app.request('/protected/action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `token=${authToken}; csrf_token=${newCsrfToken}`,
        'x-csrf-token': newCsrfToken!,
      },
    });
    expect(res.status).toBe(200);
  });

  test('POST with mismatched CSRF header and cookie returns 403', async () => {
    // Get CSRF token
    const getRes = await app.request('/health');
    const csrfToken = getCsrfCookie(getRes);

    // Register
    const regRes = await app.request('/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `csrf_token=${csrfToken}`,
        'x-csrf-token': csrfToken!,
      },
      body: JSON.stringify({ email: 'csrf3@test.com', password: 'Password123' }),
    });
    const authToken = getAuthCookie(regRes);
    const newCsrfToken = getCsrfCookie(regRes);

    // POST with wrong CSRF header
    const res = await app.request('/protected/action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `token=${authToken}; csrf_token=${newCsrfToken}`,
        'x-csrf-token': 'wrong-value',
      },
    });
    expect(res.status).toBe(403);
  });

  test('POST with tampered CSRF cookie signature returns 403', async () => {
    // Register
    const getRes = await app.request('/health');
    const csrfToken = getCsrfCookie(getRes);

    const regRes = await app.request('/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `csrf_token=${csrfToken}`,
        'x-csrf-token': csrfToken!,
      },
      body: JSON.stringify({ email: 'csrf4@test.com', password: 'Password123' }),
    });
    const authToken = getAuthCookie(regRes);

    // Tamper with the cookie signature
    const tampered = 'aaaa'.repeat(16) + '.bbbbb';
    const res = await app.request('/protected/action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `token=${authToken}; csrf_token=${tampered}`,
        'x-csrf-token': tampered,
      },
    });
    expect(res.status).toBe(403);
  });

  test('login refreshes the CSRF cookie', async () => {
    // Get initial CSRF token
    const getRes = await app.request('/health');
    const initialCsrf = getCsrfCookie(getRes);

    // Register
    const regRes = await app.request('/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `csrf_token=${initialCsrf}`,
        'x-csrf-token': initialCsrf!,
      },
      body: JSON.stringify({ email: 'csrf5@test.com', password: 'Password123' }),
    });
    expect(regRes.status).toBe(201);
    const registerCsrf = getCsrfCookie(regRes);
    expect(registerCsrf).toBeTruthy();
    expect(registerCsrf).not.toBe(initialCsrf);

    // Login
    const loginRes = await app.request('/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `csrf_token=${registerCsrf}`,
        'x-csrf-token': registerCsrf!,
      },
      body: JSON.stringify({ email: 'csrf5@test.com', password: 'Password123' }),
    });
    expect(loginRes.status).toBe(200);
    const loginCsrf = getCsrfCookie(loginRes);
    expect(loginCsrf).toBeTruthy();
    expect(loginCsrf).not.toBe(registerCsrf);
  });

  test('logout clears the CSRF cookie', async () => {
    // Get CSRF and register
    const getRes = await app.request('/health');
    const csrfToken = getCsrfCookie(getRes);

    const regRes = await app.request('/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `csrf_token=${csrfToken}`,
        'x-csrf-token': csrfToken!,
      },
      body: JSON.stringify({ email: 'csrf6@test.com', password: 'Password123' }),
    });
    const authToken = getAuthCookie(regRes);
    const newCsrf = getCsrfCookie(regRes);

    // Logout
    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `token=${authToken}; csrf_token=${newCsrf}`,
        'x-csrf-token': newCsrf!,
      },
    });
    expect(logoutRes.status).toBe(200);
    // Check that csrf_token cookie is cleared (set to empty or with max-age=0)
    const cookies = logoutRes.headers.getSetCookie();
    const csrfClearCookie = cookies.find(c => c.startsWith('csrf_token='));
    expect(csrfClearCookie).toBeTruthy();
  });

  test('PUT and DELETE methods also require CSRF', async () => {
    // Register
    const getRes = await app.request('/health');
    const csrfToken = getCsrfCookie(getRes);

    const regRes = await app.request('/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `csrf_token=${csrfToken}`,
        'x-csrf-token': csrfToken!,
      },
      body: JSON.stringify({ email: 'csrf7@test.com', password: 'Password123' }),
    });
    const authToken = getAuthCookie(regRes);

    // DELETE without CSRF
    const delRes = await app.request('/auth/sessions/fake-id', {
      method: 'DELETE',
      headers: {
        Cookie: `token=${authToken}`,
      },
    });
    expect(delRes.status).toBe(403);
  });
});

describe('CSRF disabled', () => {
  let nocsrfApp: OpenAPIHono<any>;

  beforeEach(async () => {
    nocsrfApp = await createTestApp(
      {},
      {
        auth: { enabled: true },
      },
    );
  });

  test('POST passes without CSRF when disabled', async () => {
    const res = await nocsrfApp.request('/public/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    // No CSRF cookie set
    const csrfToken = getCsrfCookie(res);
    expect(csrfToken).toBeNull();
  });
});
