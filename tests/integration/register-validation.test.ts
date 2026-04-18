/**
 * Tests for F8 — register route split into two static branches.
 *
 * After F8, the register route is split into two independent `router.openapi()` calls
 * (concealed vs non-concealed) instead of a single call with a runtime ternary.
 * Each branch should properly validate request bodies and enforce rate limits.
 */
import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Non-concealed mode — input validation and status codes
// ---------------------------------------------------------------------------

describe('register route — non-concealed mode validation', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp();
  });

  test('valid registration returns 201 with token', async () => {
    const res = await app.request(
      '/auth/register',
      json({ email: 'reg-ok@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.userId).toBeString();
  });

  test('duplicate registration returns 409', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'dup@example.com', password: 'password123' }),
    );
    const res = await app.request(
      '/auth/register',
      json({ email: 'dup@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(409);
  });

  test('missing email returns 400', async () => {
    const res = await app.request('/auth/register', json({ password: 'password123' }));
    expect(res.status).toBe(400);
  });

  test('missing password returns 400', async () => {
    const res = await app.request('/auth/register', json({ email: 'nopwd@example.com' }));
    expect(res.status).toBe(400);
  });

  test('completely empty body returns 400', async () => {
    const res = await app.request('/auth/register', json({}));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Concealed mode — input validation and status codes
// ---------------------------------------------------------------------------

describe('register route — concealed mode validation', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(
      {},
      {
        auth: {
          emailVerification: {},
          concealRegistration: {},
        },
      },
    );
  });

  test('valid registration in concealed mode returns 200', async () => {
    const res = await app.request(
      '/auth/register',
      json({ email: 'conc-ok@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBeString();
    expect(body.token).toBeUndefined();
  });

  test('missing email in concealed mode returns 400', async () => {
    const res = await app.request('/auth/register', json({ password: 'password123' }));
    expect(res.status).toBe(400);
  });

  test('missing password in concealed mode returns 400', async () => {
    const res = await app.request('/auth/register', json({ email: 'conc-nopwd@example.com' }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting — POST /auth/register enforces the register rate limit
// ---------------------------------------------------------------------------

describe('register route — rate limit enforcement', () => {
  test('register returns 429 when the bucket reaches the configured max', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          rateLimit: { register: { windowMs: 60_000, max: 2 } },
        },
      },
    );

    // First registration should succeed
    const res1 = await app.request(
      '/auth/register',
      json({ email: 'rate-test-1@example.com', password: 'password123' }),
    );
    expect(res1.status).toBe(201);

    // Second request reaches the configured ceiling and is rate limited.
    const res2 = await app.request(
      '/auth/register',
      json({ email: 'rate-test-2@example.com', password: 'password123' }),
    );
    expect(res2.status).toBe(429);
  });
});
