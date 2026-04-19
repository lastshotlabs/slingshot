import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { authHeader, createTestApp } from '../setup';

let app: OpenAPIHono<any>;

beforeEach(async () => {
  app = await createTestApp(
    {},
    {
      auth: {
        enabled: true,
        roles: ['admin', 'user'],
        defaultRole: 'user',
        refreshTokens: {
          accessTokenExpiry: 900,
          refreshTokenExpiry: 86400,
          rotationGraceSeconds: 2,
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

// ---------------------------------------------------------------------------
// Refresh Token Basics
// ---------------------------------------------------------------------------

describe('refresh token basics', () => {
  test('register returns refreshToken', async () => {
    const res = await app.request(
      '/auth/register',
      json({ email: 'rt@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.refreshToken).toBeString();
  });

  test('login returns refreshToken', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'rtlogin@example.com', password: 'password123' }),
    );

    const res = await app.request(
      '/auth/login',
      json({ email: 'rtlogin@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshToken).toBeString();
  });
});

// ---------------------------------------------------------------------------
// Token Rotation
// ---------------------------------------------------------------------------

describe('refresh token rotation', () => {
  test('refresh returns new tokens', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'rot@example.com', password: 'password123' }),
    );
    const { refreshToken: rt1 } = await regRes.json();

    const refreshRes = await app.request('/auth/refresh', json({ refreshToken: rt1 }));
    expect(refreshRes.status).toBe(200);
    const body = await refreshRes.json();
    expect(body.token).toBeString();
    expect(body.refreshToken).toBeString();
    expect(body.refreshToken).not.toBe(rt1);
    expect(body.userId).toBeString();

    // New access token should work
    const meRes = await app.request('/auth/me', { headers: authHeader(body.token) });
    expect(meRes.status).toBe(200);
  });

  test('old token works within grace window', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'grace@example.com', password: 'password123' }),
    );
    const { refreshToken: rt1 } = await regRes.json();

    // Rotate once
    await app.request('/auth/refresh', json({ refreshToken: rt1 }));

    // Immediately use old token (within 2s grace window)
    const graceRes = await app.request('/auth/refresh', json({ refreshToken: rt1 }));
    expect(graceRes.status).toBe(200);
    const body = await graceRes.json();
    // Grace window: old token is accepted and a new token is issued (always rotates)
    expect(body.refreshToken).toBeString();
    expect(body.refreshToken).not.toBe(rt1);
    expect(body.token).toBeString();
  });
});

// ---------------------------------------------------------------------------
// Theft Detection
// ---------------------------------------------------------------------------

describe('theft detection', () => {
  test('old token rejected after grace window', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'theft@example.com', password: 'password123' }),
    );
    const { refreshToken: rt1 } = await regRes.json();

    // Rotate
    await app.request('/auth/refresh', json({ refreshToken: rt1 }));

    // Wait for grace window to expire
    await Bun.sleep(2100);

    // Old token should be rejected
    const res = await app.request('/auth/refresh', json({ refreshToken: rt1 }));
    expect(res.status).toBe(401);
  }, 10000);

  test('session destroyed after theft detection', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'destroy@example.com', password: 'password123' }),
    );
    const { refreshToken: rt1 } = await regRes.json();

    // Rotate to get new tokens
    const refreshRes = await app.request('/auth/refresh', json({ refreshToken: rt1 }));
    const { refreshToken: rt2 } = await refreshRes.json();

    // Wait for grace window to expire
    await Bun.sleep(2100);

    // Use old token — triggers theft detection, destroys session
    await app.request('/auth/refresh', json({ refreshToken: rt1 }));

    // New token should also be invalid now (session destroyed)
    const res = await app.request('/auth/refresh', json({ refreshToken: rt2 }));
    expect(res.status).toBe(401);
  }, 10000);
});
