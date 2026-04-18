/**
 * Tests for the identify middleware suspension check (pre-existing gap).
 *
 * `checkSuspensionOnIdentify` causes the identify middleware to query the adapter
 * for suspension status on every authenticated request — not just at login time.
 * This means a user suspended after logging in is immediately locked out on their
 * next request without needing to log in again.
 */
import { setSuspended } from '@auth/lib/suspension';
import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { authHeader, createTestApp } from '../setup';

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function getRuntime(app: any): AuthRuntimeContext {
  return (app as any).ctx.pluginState.get(AUTH_RUNTIME_KEY) as AuthRuntimeContext;
}

async function registerUser(app: OpenAPIHono<any>, email = 'sus-test@example.com') {
  const res = await app.request('/auth/register', json({ email, password: 'password123' }));
  return res.json() as Promise<{ token: string; userId: string }>;
}

describe('identify middleware — suspension check on every request by default', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
        },
      },
    );
  });

  test('active user is authenticated normally', async () => {
    const { token } = await registerUser(app);
    const res = await app.request('/auth/me', { headers: authHeader(token) });
    expect(res.status).toBe(200);
  });

  test('user suspended after login is rejected on subsequent request', async () => {
    const { token, userId } = await registerUser(app, 'suspend-after@example.com');

    // Confirm user can access /auth/me before suspension
    const before = await app.request('/auth/me', { headers: authHeader(token) });
    expect(before.status).toBe(200);

    // Suspend the user through the adapter directly
    const runtime = getRuntime(app);
    await setSuspended(runtime.adapter, userId, true, 'Test suspension');

    // Now the same token should be rejected by the identify middleware
    const after = await app.request('/auth/me', { headers: authHeader(token) });
    expect(after.status).toBe(401);
  });
});

describe('identify middleware — explicit opt-out disables suspension checks', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          checkSuspensionOnIdentify: false,
        },
      },
    );
  });

  test('suspended user with valid session is still authenticated when check is disabled', async () => {
    const { token, userId } = await registerUser(app, 'suspend-skipped@example.com');

    // Suspend the user
    const runtime = getRuntime(app);
    await setSuspended(runtime.adapter, userId, true, 'Admin suspended');

    // With the explicit opt-out, the middleware does not query suspension status
    // and the valid JWT+session still authenticates.
    const res = await app.request('/auth/me', { headers: authHeader(token) });
    expect(res.status).toBe(200);
  });
});
