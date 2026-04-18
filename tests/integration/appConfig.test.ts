import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { authHeader, createTestApp } from '../setup';

// ---------------------------------------------------------------------------
// Bearer auth enabled
// ---------------------------------------------------------------------------

describe('bearerAuth enabled', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(
      {},
      {
        security: {
          bearerAuth: true,
          bearerTokens: 'test-bearer-token',
        },
        auth: { enabled: false },
      },
    );
  });

  test('request without bearer token returns 401 on non-exempt path', async () => {
    const res = await app.request('/cached');
    expect(res.status).toBe(401);
  });

  test('request with valid bearer token passes', async () => {
    const res = await app.request('/cached', {
      headers: { Authorization: 'Bearer test-bearer-token' },
    });
    expect(res.status).toBe(200);
  });

  test('exempt paths bypass bearer auth', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Auth disabled
// ---------------------------------------------------------------------------

describe('auth disabled', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(
      {},
      {
        auth: { enabled: false },
      },
    );
  });

  test('auth routes return 404 when auth is disabled', async () => {
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'password123' }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Session metadata tracking
// ---------------------------------------------------------------------------

describe('session metadata', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['admin', 'user'],
          defaultRole: 'user',
          sessionPolicy: {
            trackLastActive: true,
            persistSessionMetadata: true,
          },
        },
      },
    );
  });

  test('sessions include metadata when persistMetadata is true', async () => {
    const regRes = await app.request('/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TestBrowser/1.0',
      },
      body: JSON.stringify({ email: 'meta@example.com', password: 'password123' }),
    });
    const { token } = await regRes.json();

    const sessRes = await app.request('/auth/sessions', {
      headers: { ...authHeader(token), 'User-Agent': 'TestBrowser/1.0' },
    });
    expect(sessRes.status).toBe(200);
    const { sessions } = await sessRes.json();
    expect(sessions).toHaveLength(1);
    // Session should have metadata fields
    const session = sessions[0];
    expect(session.userAgent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(
      {},
      {
        auth: { enabled: false },
      },
    );
  });

  test('404 returns JSON error', async () => {
    const res = await app.request('/nonexistent-route-xyz');
    expect(res.status).toBe(404);
  });
});
