import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { authHeader, createTestApp } from '../setup';

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Concurrent session creation at maxSessions limit
// ---------------------------------------------------------------------------

describe('concurrent session creation at maxSessions limit', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['admin', 'user'],
          defaultRole: 'user',
          sessionPolicy: { maxSessions: 3 },
        },
      },
    );
  });

  test('total sessions never exceed maxSessions after concurrent logins', async () => {
    // Register user (creates session 1)
    const regRes = await app.request(
      '/auth/register',
      json({
        email: 'concurrent-sess@example.com',
        password: 'password123',
      }),
    );
    expect(regRes.status).toBe(201);
    await regRes.json();

    // Login to create session 2
    const login1 = await app.request(
      '/auth/login',
      json({
        email: 'concurrent-sess@example.com',
        password: 'password123',
      }),
    );
    expect(login1.status).toBe(200);

    // Now we have 2 sessions, maxSessions is 3.
    // Fire two concurrent logins — both try to create session 3 and 4.
    // The atomic session creation should ensure total never exceeds 3.
    const [res1, res2] = await Promise.all([
      app.request(
        '/auth/login',
        json({
          email: 'concurrent-sess@example.com',
          password: 'password123',
        }),
      ),
      app.request(
        '/auth/login',
        json({
          email: 'concurrent-sess@example.com',
          password: 'password123',
        }),
      ),
    ]);

    // Both logins should succeed (the system evicts oldest to make room)
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Get a valid token from one of the responses
    const { token: validToken } = await res1.json();

    // Check total sessions — must not exceed maxSessions (3)
    const sessionsRes = await app.request('/auth/sessions', {
      headers: authHeader(validToken),
    });
    expect(sessionsRes.status).toBe(200);
    const { sessions } = await sessionsRes.json();
    const activeSessions = sessions.filter((s: any) => s.isActive);
    expect(activeSessions.length).toBeLessThanOrEqual(3);
    expect(activeSessions.length).toBeGreaterThanOrEqual(1);
  });

  test('evicts oldest sessions correctly under concurrent pressure', async () => {
    // Register creates session 1
    await app.request(
      '/auth/register',
      json({
        email: 'evict-concurrent@example.com',
        password: 'password123',
      }),
    );

    // Fill to maxSessions (3)
    await app.request(
      '/auth/login',
      json({
        email: 'evict-concurrent@example.com',
        password: 'password123',
      }),
    );
    await app.request(
      '/auth/login',
      json({
        email: 'evict-concurrent@example.com',
        password: 'password123',
      }),
    );

    // Now at 3 sessions. Two more concurrent logins should evict the oldest.
    const [res1, res2] = await Promise.all([
      app.request(
        '/auth/login',
        json({
          email: 'evict-concurrent@example.com',
          password: 'password123',
        }),
      ),
      app.request(
        '/auth/login',
        json({
          email: 'evict-concurrent@example.com',
          password: 'password123',
        }),
      ),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const { token } = await res2.json();

    // Verify session count is bounded
    const sessionsRes = await app.request('/auth/sessions', {
      headers: authHeader(token),
    });
    const { sessions } = await sessionsRes.json();
    const active = sessions.filter((s: any) => s.isActive);
    expect(active.length).toBeLessThanOrEqual(3);
  });

  test('concurrent logins for different users do not interfere', async () => {
    // Register two different users
    await app.request(
      '/auth/register',
      json({
        email: 'user-a@example.com',
        password: 'password123',
      }),
    );
    await app.request(
      '/auth/register',
      json({
        email: 'user-b@example.com',
        password: 'password123',
      }),
    );

    // Concurrent logins for both users
    const [resA, resB] = await Promise.all([
      app.request(
        '/auth/login',
        json({
          email: 'user-a@example.com',
          password: 'password123',
        }),
      ),
      app.request(
        '/auth/login',
        json({
          email: 'user-b@example.com',
          password: 'password123',
        }),
      ),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const { token: tokenA } = await resA.json();
    const { token: tokenB } = await resB.json();

    // Each user should have their own sessions (2 each: register + login)
    const sessA = await app.request('/auth/sessions', { headers: authHeader(tokenA) });
    const sessB = await app.request('/auth/sessions', { headers: authHeader(tokenB) });

    const { sessions: sessionsA } = await sessA.json();
    const { sessions: sessionsB } = await sessB.json();

    expect(sessionsA.length).toBe(2);
    expect(sessionsB.length).toBe(2);
  });

  test('maxSessions=1 with concurrent logins results in exactly 1 active session', async () => {
    // Separate app with maxSessions=1
    const strictApp = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['admin', 'user'],
          defaultRole: 'user',
          sessionPolicy: { maxSessions: 1 },
        },
      },
    );

    await strictApp.request(
      '/auth/register',
      json({
        email: 'strict-max@example.com',
        password: 'password123',
      }),
    );

    // Three concurrent logins
    const results = await Promise.all([
      strictApp.request(
        '/auth/login',
        json({
          email: 'strict-max@example.com',
          password: 'password123',
        }),
      ),
      strictApp.request(
        '/auth/login',
        json({
          email: 'strict-max@example.com',
          password: 'password123',
        }),
      ),
      strictApp.request(
        '/auth/login',
        json({
          email: 'strict-max@example.com',
          password: 'password123',
        }),
      ),
    ]);

    // All logins should succeed
    for (const r of results) {
      expect(r.status).toBe(200);
    }

    // Try each token to find one whose session is still active.
    // With maxSessions=1, earlier sessions get evicted by later logins,
    // so only the last-to-execute login's token is still valid.
    let validToken: string | null = null;
    const bodies = await Promise.all(results.map(r => r.json()));
    for (const body of bodies) {
      const sessionsRes = await strictApp.request('/auth/sessions', {
        headers: authHeader(body.token),
      });
      if (sessionsRes.status === 200) {
        const { sessions } = await sessionsRes.json();
        const active = sessions.filter((s: any) => s.isActive);
        // The key invariant: never more than maxSessions
        expect(active.length).toBeLessThanOrEqual(1);
        if (active.length > 0) validToken = body.token;
      }
    }

    // At least one session must survive
    expect(validToken).not.toBeNull();
  });
});
