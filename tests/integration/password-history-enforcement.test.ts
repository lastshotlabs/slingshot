/**
 * Integration tests for password history enforcement at the route level.
 *
 * `passwordPolicy.preventReuse` causes POST /auth/set-password to reject
 * passwords that match recent history entries. History is recorded by
 * set-password (and reset-password) calls; the initial registration password
 * is NOT recorded in history.
 *
 * This is a pre-existing gap: the unit tests in tests/unit/password-history.test.ts
 * cover the library functions, but no integration test verified the route behaviour.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { authHeader, createTestApp } from '../setup';

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function buildApp() {
  return createTestApp(
    {},
    {
      auth: {
        enabled: true,
        roles: ['user'],
        defaultRole: 'user',
        passwordPolicy: { preventReuse: 3 },
      },
    },
  );
}

async function registerUser(app: OpenAPIHono<any>, email = 'hist@example.com') {
  const res = await app.request('/auth/register', json({ email, password: 'Password1!' }));
  return res.json() as Promise<{ token: string; userId: string }>;
}

async function setPassword(app: OpenAPIHono<any>, token: string, current: string, next: string) {
  return app.request('/auth/set-password', {
    method: 'POST',
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: next, currentPassword: current }),
  });
}

async function loginUser(app: OpenAPIHono<any>, email: string, password: string) {
  const res = await app.request('/auth/login', json({ email, password }));
  const body = (await res.json()) as { token?: string };
  return body.token ?? null;
}

describe('password history enforcement — set-password route', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await buildApp();
  });

  test('new password accepted when history is empty', async () => {
    const { token } = await registerUser(app, 'empty-hist@example.com');
    // Initial password not in history — changing to a new password is fine
    const res = await setPassword(app, token, 'Password1!', 'Password2!');
    expect(res.status).toBe(200);
  });

  test('password already in history is rejected with PASSWORD_PREVIOUSLY_USED', async () => {
    const { token: t1 } = await registerUser(app, 'in-hist@example.com');

    // Change P1→P2. P2 is now recorded in history.
    await setPassword(app, t1, 'Password1!', 'Password2!');

    const t2 = await loginUser(app, 'in-hist@example.com', 'Password2!');
    expect(t2).not.toBeNull();

    // Attempt P2→P2 (same password): P2 is in history → should fail
    const res = await setPassword(app, t2!, 'Password2!', 'Password2!');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('PASSWORD_PREVIOUSLY_USED');
  });

  test('password in history (not current) is rejected', async () => {
    const { token: t1 } = await registerUser(app, 'prev-hist@example.com');

    // P1→P2 (P2 recorded), P2→P3 (P3 recorded). Now history = [P2, P3].
    await setPassword(app, t1, 'Password1!', 'Password2!');
    const t2 = await loginUser(app, 'prev-hist@example.com', 'Password2!');
    await setPassword(app, t2!, 'Password2!', 'Password3!');
    const t3 = await loginUser(app, 'prev-hist@example.com', 'Password3!');

    // Try to reuse P2 — it's in the history window → should fail
    const res = await setPassword(app, t3!, 'Password3!', 'Password2!');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('PASSWORD_PREVIOUSLY_USED');
  });

  test('password outside history window (>3 changes ago) is accepted', async () => {
    const { token: t1 } = await registerUser(app, 'overflow-hist@example.com');

    // P1→P2 (history=[P2]), P2→P3 (history=[P2,P3]), P3→P4 (history=[P2,P3,P4]).
    await setPassword(app, t1, 'Password1!', 'Password2!');
    const t2 = await loginUser(app, 'overflow-hist@example.com', 'Password2!');
    await setPassword(app, t2!, 'Password2!', 'Password3!');
    const t3 = await loginUser(app, 'overflow-hist@example.com', 'Password3!');
    await setPassword(app, t3!, 'Password3!', 'Password4!');
    const t4 = await loginUser(app, 'overflow-hist@example.com', 'Password4!');

    // Now try P4→P5. P5 is not in history = [P2,P3,P4] at all → should succeed.
    const res = await setPassword(app, t4!, 'Password4!', 'Password5!');
    expect(res.status).toBe(200);
  });
});
