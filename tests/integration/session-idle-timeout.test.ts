/**
 * Tests for session idle timeout and absolute timeout enforcement (pre-existing gap).
 *
 * Idle timeout:  session is invalidated after a period of inactivity.
 * Absolute timeout: session can't outlive the absoluteTimeout even if active.
 */
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

function getSessionRepo(app: any) {
  const runtime = (app as any).ctx.pluginState.get(AUTH_RUNTIME_KEY) as AuthRuntimeContext;
  return runtime.repos.session;
}

async function registerUser(app: OpenAPIHono<any>, email = 'timeout@example.com') {
  const res = await app.request('/auth/register', json({ email, password: 'password123' }));
  return res.json() as Promise<{ token: string; userId: string }>;
}

// ---------------------------------------------------------------------------
// Idle timeout
// ---------------------------------------------------------------------------

describe('session idle timeout', () => {
  test('session is active before idle timeout expires', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          sessionPolicy: { idleTimeout: 3600 }, // 1 hour
        },
      },
    );

    const { token } = await registerUser(app);
    const res = await app.request('/auth/me', { headers: authHeader(token) });
    expect(res.status).toBe(200);
  });

  test('session is rejected after idle timeout passes', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          sessionPolicy: { idleTimeout: 1 }, // 1 second
        },
      },
    );

    const { token, userId } = await registerUser(app, 'idle-expired@example.com');
    const repo = getSessionRepo(app);

    // Manually backdate lastActiveAt so the session is considered idle-expired
    const sessions = await repo.getUserSessions(userId);
    const sessionId = sessions[0].sessionId;
    // Simulate time passing by directly calling updateSessionLastActive with a stale time
    // We achieve this by manipulating the in-memory store via a private helper:
    // Instead, create a fresh session with a backdated lastActiveAt by using the raw store.
    // Since we can't easily manipulate time, we wait >1s.
    await Bun.sleep(1100);

    // After 1s+ idle, session should be gone
    const res = await app.request('/auth/me', { headers: authHeader(token) });
    expect(res.status).toBe(401);
  }, 10000);

  test('idle timeout does not trigger when requests come within the window', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          sessionPolicy: { idleTimeout: 3600, trackLastActive: true },
        },
      },
    );

    const { token } = await registerUser(app, 'idle-active@example.com');

    // Make a request to refresh lastActiveAt
    const res1 = await app.request('/auth/me', { headers: authHeader(token) });
    expect(res1.status).toBe(200);

    // Immediately make another — should still work
    const res2 = await app.request('/auth/me', { headers: authHeader(token) });
    expect(res2.status).toBe(200);
  });

  test('idleTimeout config enables lastActiveAt tracking implicitly', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          sessionPolicy: { idleTimeout: 3600 },
        },
      },
    );

    const { token, userId } = await registerUser(app, 'idle-track@example.com');
    const repo = getSessionRepo(app);

    const before = await repo.getUserSessions(userId);
    const lastActiveBefore = before[0]?.lastActiveAt ?? 0;

    await Bun.sleep(20);
    await app.request('/auth/me', { headers: authHeader(token) });
    await Bun.sleep(30);

    const after = await repo.getUserSessions(userId);
    const lastActiveAfter = after[0]?.lastActiveAt ?? 0;

    expect(lastActiveAfter).toBeGreaterThan(lastActiveBefore);
  });
});

// ---------------------------------------------------------------------------
// Absolute timeout — used as JWT expiry when refresh tokens are disabled (F2)
// ---------------------------------------------------------------------------

describe('session absolute timeout (F2)', () => {
  test('absoluteTimeout drives JWT expiry when refresh tokens are disabled', async () => {
    const absoluteTimeout = 7200; // 2 hours

    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          sessionPolicy: { absoluteTimeout },
          // No refreshTokens configured — JWT is the sole credential
        },
      },
    );

    const { token } = await registerUser(app, 'abs-timeout@example.com');

    // Decode the JWT header.payload (no signature check needed here — just inspect)
    const parts = token.split('.');
    const payloadJson = Buffer.from(parts[1], 'base64url').toString();
    const payload = JSON.parse(payloadJson);

    const now = Math.floor(Date.now() / 1000);
    const exp = payload.exp as number;

    // exp should be ~now + absoluteTimeout (±10s)
    expect(exp).toBeGreaterThanOrEqual(now + absoluteTimeout - 10);
    expect(exp).toBeLessThanOrEqual(now + absoluteTimeout + 10);
  });

  test('default absoluteTimeout is 7 days (604800s) when not configured', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          // No sessionPolicy — use defaults
        },
      },
    );

    const { token } = await registerUser(app, 'default-abs@example.com');
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

    const now = Math.floor(Date.now() / 1000);
    const exp = payload.exp as number;
    const sevenDays = 7 * 24 * 3600;

    expect(exp).toBeGreaterThanOrEqual(now + sevenDays - 30);
    expect(exp).toBeLessThanOrEqual(now + sevenDays + 30);
  });
});
