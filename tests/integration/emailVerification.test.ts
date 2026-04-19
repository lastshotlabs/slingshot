import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { getContext } from '@lastshotlabs/slingshot-core';
import { createTestApp } from '../setup';

let app: OpenAPIHono<any>;
const getBus = (targetApp: object) => getContext(targetApp).bus;

beforeEach(async () => {
  // Create the required app so the global config has required: true
  app = await createTestApp(
    {},
    {
      auth: {
        enabled: true,
        roles: ['admin', 'user'],
        defaultRole: 'user',
        emailVerification: { required: true },
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
// Email Verification (required: true)
// ---------------------------------------------------------------------------

describe('email verification (required)', () => {
  test('register triggers email_verification delivery event with token', async () => {
    let captured: string | undefined;
    const handler = (payload: { token: string }) => {
      captured = payload.token;
    };
    getBus(app).on('auth:delivery.email_verification', handler);
    await app.request(
      '/auth/register',
      json({ email: 'verify@example.com', password: 'password123' }),
    );
    getBus(app).off('auth:delivery.email_verification', handler);
    expect(captured).toBeString();
  });

  test('register does not issue a live session before verification', async () => {
    const res = await app.request(
      '/auth/register',
      json({ email: 'no-session@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBe('');
    expect(body.emailVerified).toBe(false);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('login blocked when email not verified', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'blocked@example.com', password: 'password123' }),
    );

    const res = await app.request(
      '/auth/login',
      json({ email: 'blocked@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(403);
  });

  test('verify-email succeeds with valid token', async () => {
    let token: string | undefined;
    const handler = (payload: { token: string }) => {
      token = payload.token;
    };
    getBus(app).on('auth:delivery.email_verification', handler);
    await app.request(
      '/auth/register',
      json({ email: 'tok@example.com', password: 'password123' }),
    );
    getBus(app).off('auth:delivery.email_verification', handler);

    const res = await app.request('/auth/verify-email', json({ token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('login succeeds after verification', async () => {
    let token: string | undefined;
    const handler = (payload: { token: string }) => {
      token = payload.token;
    };
    getBus(app).on('auth:delivery.email_verification', handler);
    await app.request(
      '/auth/register',
      json({ email: 'success@example.com', password: 'password123' }),
    );
    getBus(app).off('auth:delivery.email_verification', handler);
    await app.request('/auth/verify-email', json({ token }));

    const res = await app.request(
      '/auth/login',
      json({ email: 'success@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
  });

  test('resend-verification sends new token', async () => {
    let firstToken: string | undefined;
    let secondToken: string | undefined;
    const handler1 = (payload: { token: string }) => {
      firstToken = payload.token;
    };
    getBus(app).on('auth:delivery.email_verification', handler1);
    await app.request(
      '/auth/register',
      json({ email: 'resend@example.com', password: 'password123' }),
    );
    getBus(app).off('auth:delivery.email_verification', handler1);

    const handler2 = (payload: { token: string }) => {
      secondToken = payload.token;
    };
    getBus(app).on('auth:delivery.email_verification', handler2);
    const res = await app.request(
      '/auth/resend-verification',
      json({ email: 'resend@example.com', password: 'password123' }),
    );
    getBus(app).off('auth:delivery.email_verification', handler2);
    expect(res.status).toBe(200);
    expect(secondToken).toBeString();
    expect(secondToken).not.toBe(firstToken);
  });

  test('resend returns 200 when already verified (indistinguishable by design)', async () => {
    let token: string | undefined;
    const handler = (payload: { token: string }) => {
      token = payload.token;
    };
    getBus(app).on('auth:delivery.email_verification', handler);
    await app.request(
      '/auth/register',
      json({ email: 'already@example.com', password: 'password123' }),
    );
    getBus(app).off('auth:delivery.email_verification', handler);
    await app.request('/auth/verify-email', json({ token }));

    const res = await app.request(
      '/auth/resend-verification',
      json({ email: 'already@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Email Verification (required: false — soft gate)
// ---------------------------------------------------------------------------

describe('email verification (soft gate)', () => {
  test('login succeeds but returns emailVerified false', async () => {
    // Create a separate app with required: false for the soft gate test
    // beforeEach already cleared stores, so we just create the app with different config
    const softApp = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['admin', 'user'],
          defaultRole: 'user',
          emailVerification: { required: false },
        },
      },
    );

    await softApp.request(
      '/auth/register',
      json({ email: 'soft@example.com', password: 'password123' }),
    );

    const res = await softApp.request(
      '/auth/login',
      json({ email: 'soft@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.emailVerified).toBe(false);
  });
});
