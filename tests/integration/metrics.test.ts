import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { authHeader, createTestApp } from '../setup';

function getRuntime(app: any): AuthRuntimeContext {
  return (app as any).ctx.pluginState.get(AUTH_RUNTIME_KEY) as AuthRuntimeContext;
}

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ── With metrics enabled ─────────────────────────────────────────────────────

describe('metrics endpoint (enabled)', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp({ metrics: { enabled: true } });
  });

  test('serves /metrics with 200 and correct content type', async () => {
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  test('contains metric lines after requests', async () => {
    // Make some requests first
    await app.request('/health');
    await app.request('/');

    const res = await app.request('/metrics');
    const body = await res.text();
    // Root request should be collected (health is excluded)
    expect(body).toContain('http_requests_total');
    expect(body).toContain('path="/"');
  });

  test('/metrics itself is not counted (self-exclusion)', async () => {
    await app.request('/metrics');
    await app.request('/metrics');

    const res = await app.request('/metrics');
    const body = await res.text();
    expect(body).not.toContain('path="/metrics"');
  });
});

// ── Without metrics config ───────────────────────────────────────────────────

describe('metrics endpoint (disabled)', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(); // no metrics config
  });

  test('returns 404 when metrics not configured', async () => {
    const res = await app.request('/metrics');
    expect(res.status).toBe(404);
  });
});

describe('metrics endpoint account-state hardening', () => {
  test('blocks stale suspended user-auth sessions', async () => {
    const app = await createTestApp(
      { metrics: { enabled: true, auth: 'userAuth' } },
      { auth: { checkSuspensionOnIdentify: false } },
    );
    const registerRes = await app.request(
      '/auth/register',
      json({ email: 'metrics-suspended@example.com', password: 'password123' }),
    );
    const { token, userId } = (await registerRes.json()) as { token: string; userId: string };
    const runtime = getRuntime(app);
    await runtime.adapter.setSuspended?.(userId, true, 'security hold');

    const res = await app.request('/metrics', {
      headers: authHeader(token),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Account suspended' });
  });

  test('blocks stale unverified user-auth sessions', async () => {
    const app = await createTestApp(
      { metrics: { enabled: true, auth: 'userAuth' } },
      {
        auth: {
          checkSuspensionOnIdentify: false,
          emailVerification: { required: true, tokenExpiry: 3600 },
        },
      },
    );
    const registerRes = await app.request(
      '/auth/register',
      json({ email: 'metrics-verify@example.com', password: 'password123' }),
    );
    const { userId } = (await registerRes.json()) as { userId: string };
    const runtime = getRuntime(app);
    await runtime.adapter.setEmailVerified?.(userId, true);

    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'metrics-verify@example.com', password: 'password123' }),
    );
    const { token } = (await loginRes.json()) as { token: string };
    await runtime.adapter.setEmailVerified?.(userId, false);

    const res = await app.request('/metrics', {
      headers: authHeader(token),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Email not verified' });
  });
});
