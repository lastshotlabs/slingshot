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
// Concurrent refresh token rotation
// ---------------------------------------------------------------------------

describe('concurrent refresh token rotation', () => {
  test('two concurrent refreshes from the same token — at least one succeeds', async () => {
    // Register a user and get a refresh token
    const regRes = await app.request(
      '/auth/register',
      json({
        email: 'concurrent-rt@example.com',
        password: 'password123',
      }),
    );
    expect(regRes.status).toBe(201);
    const { refreshToken: rt1, token } = await regRes.json();
    expect(rt1).toBeString();

    // Fire two concurrent refresh requests with the same token
    const [res1, res2] = await Promise.all([
      app.request('/auth/refresh', json({ refreshToken: rt1 })),
      app.request('/auth/refresh', json({ refreshToken: rt1 })),
    ]);

    const status1 = res1.status;
    const status2 = res2.status;

    // At least one must succeed
    expect(status1 === 200 || status2 === 200).toBe(true);

    // Collect successful responses
    const successes: Array<{ token: string; refreshToken: string; userId: string }> = [];
    if (status1 === 200) successes.push(await res1.json());
    if (status2 === 200) successes.push(await res2.json());

    // Each successful response returns a new, distinct refresh token
    for (const s of successes) {
      expect(s.refreshToken).toBeString();
      expect(s.refreshToken).not.toBe(rt1);
      expect(s.token).toBeString();
      expect(s.userId).toBeString();
    }

    // If both succeeded (grace window), the tokens should differ
    if (successes.length === 2) {
      // Both rotations produce distinct refresh tokens
      expect(successes[0].refreshToken).not.toBe(successes[1].refreshToken);
    }
  });

  test('old refresh token is rejected after grace window expires', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({
        email: 'invalidate-rt@example.com',
        password: 'password123',
      }),
    );
    const { refreshToken: rt1 } = await regRes.json();

    // Rotate once
    const refreshRes = await app.request('/auth/refresh', json({ refreshToken: rt1 }));
    expect(refreshRes.status).toBe(200);

    // Wait beyond grace window (grace is 2s, wait 3s)
    await Bun.sleep(3000);

    // Old token should now be fully invalidated (past grace window → theft detection).
    // Theft detection invalidates the entire session — this is correct security behavior.
    const oldRes = await app.request('/auth/refresh', json({ refreshToken: rt1 }));
    expect(oldRes.status).toBe(401);
  });

  test('old refresh token works within grace window', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({
        email: 'grace-rt@example.com',
        password: 'password123',
      }),
    );
    const { refreshToken: rt1 } = await regRes.json();

    // Rotate once
    const refreshRes = await app.request('/auth/refresh', json({ refreshToken: rt1 }));
    expect(refreshRes.status).toBe(200);

    // Immediately use old token (within 2s grace window) — should succeed
    const graceRes = await app.request('/auth/refresh', json({ refreshToken: rt1 }));
    expect(graceRes.status).toBe(200);
  });

  test('no duplicate sessions are created by concurrent refreshes', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({
        email: 'no-dup-sessions@example.com',
        password: 'password123',
      }),
    );
    const { refreshToken: rt1, token } = await regRes.json();

    // Count sessions before
    const beforeRes = await app.request('/auth/sessions', { headers: authHeader(token) });
    const { sessions: beforeSessions } = await beforeRes.json();
    const sessionCountBefore = beforeSessions.length;

    // Fire concurrent refreshes
    const results = await Promise.all([
      app.request('/auth/refresh', json({ refreshToken: rt1 })),
      app.request('/auth/refresh', json({ refreshToken: rt1 })),
    ]);

    // Get a valid token from the successful response(s)
    let validToken: string | null = null;
    for (const r of results) {
      if (r.status === 200) {
        const body = await r.json();
        validToken = body.token;
      }
    }
    expect(validToken).not.toBeNull();

    // Check session count — should not have increased (refresh rotates, does not create)
    const afterRes = await app.request('/auth/sessions', { headers: authHeader(validToken!) });
    const { sessions: afterSessions } = await afterRes.json();
    expect(afterSessions.length).toBe(sessionCountBefore);
  });

  test('concurrent refreshes from different sessions succeed independently', async () => {
    // Register and login to create two separate sessions with their own refresh tokens
    const regRes = await app.request(
      '/auth/register',
      json({
        email: 'multi-device@example.com',
        password: 'password123',
      }),
    );
    const { refreshToken: rt1 } = await regRes.json();

    const loginRes = await app.request(
      '/auth/login',
      json({
        email: 'multi-device@example.com',
        password: 'password123',
      }),
    );
    const { refreshToken: rt2 } = await loginRes.json();

    // Both tokens are distinct (different sessions)
    expect(rt1).not.toBe(rt2);

    // Refresh both concurrently
    const [res1, res2] = await Promise.all([
      app.request('/auth/refresh', json({ refreshToken: rt1 })),
      app.request('/auth/refresh', json({ refreshToken: rt2 })),
    ]);

    // Both should succeed — they are independent sessions
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const body1 = await res1.json();
    const body2 = await res2.json();

    expect(body1.refreshToken).toBeString();
    expect(body2.refreshToken).toBeString();
    expect(body1.refreshToken).not.toBe(body2.refreshToken);
  });
});
