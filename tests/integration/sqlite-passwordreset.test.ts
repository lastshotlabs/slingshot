import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { getContext } from '@lastshotlabs/slingshot-core';
import { createTestApp } from '../setup';

let app: OpenAPIHono<any>;
const captured: { email: string; token: string }[] = [];

beforeEach(async () => {
  captured.length = 0;
  app = await createTestApp(
    {
      db: {
        mongo: false,
        redis: false,
        sessions: 'sqlite',
        cache: 'sqlite',
        auth: 'sqlite',
        sqlite: ':memory:',
      },
    },
    {
      auth: {
        enabled: true,
        roles: ['admin', 'user'],
        defaultRole: 'user',
        passwordReset: {
          tokenExpiry: 300,
        },
      },
    },
  );
  getContext(app).bus.on('auth:delivery.password_reset', payload => {
    captured.push({ email: payload.email, token: payload.token });
  });
});

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function waitForCapture(timeout = 200): Promise<void> {
  const deadline = Date.now() + timeout;
  while (captured.length === 0 && Date.now() < deadline) {
    await Bun.sleep(10);
  }
}

describe('SQLite password reset', () => {
  test('forgot password sends reset email', async () => {
    await app.request('/auth/register', json({ email: 'pr@example.com', password: 'password123' }));
    const res = await app.request('/auth/forgot-password', json({ email: 'pr@example.com' }));
    expect(res.status).toBe(200);
    await waitForCapture();
    expect(captured).toHaveLength(1);
    expect(captured[0].email).toBe('pr@example.com');
  });

  test('reset password with valid token works', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'pr2@example.com', password: 'password123' }),
    );
    await app.request('/auth/forgot-password', json({ email: 'pr2@example.com' }));
    await waitForCapture();
    const token = captured[0].token;

    const res = await app.request(
      '/auth/reset-password',
      json({ token, password: 'newpassword456' }),
    );
    expect(res.status).toBe(200);
  });

  test('login with new password succeeds', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'pr3@example.com', password: 'password123' }),
    );
    await app.request('/auth/forgot-password', json({ email: 'pr3@example.com' }));
    await waitForCapture();
    await app.request(
      '/auth/reset-password',
      json({ token: captured[0].token, password: 'newpassword456' }),
    );

    const res = await app.request(
      '/auth/login',
      json({ email: 'pr3@example.com', password: 'newpassword456' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
  });

  test('reset with already-used token fails', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'pr4@example.com', password: 'password123' }),
    );
    await app.request('/auth/forgot-password', json({ email: 'pr4@example.com' }));
    await waitForCapture();
    const token = captured[0].token;

    await app.request('/auth/reset-password', json({ token, password: 'newpassword456' }));
    const res = await app.request(
      '/auth/reset-password',
      json({ token, password: 'anotherpassword' }),
    );
    expect(res.status).toBe(400);
  });
});
