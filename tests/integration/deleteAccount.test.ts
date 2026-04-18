import { beforeEach, describe, expect, test } from 'bun:test';
import { authHeader, createTestApp } from '../setup';

const json = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('DELETE /auth/me — additional branches', () => {
  test('returns 429 when delete account rate limit exceeded', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          accountDeletion: { enabled: true },
          rateLimit: { deleteAccount: { max: 1, windowMs: 60000 } },
        },
      },
    );

    const reg = await app.request(
      '/auth/register',
      json({ email: 'ratelimit@test.com', password: 'Password1' }),
    );
    const { token } = (await reg.json()) as { token: string };

    // First attempt
    await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrongpassword' }),
    });

    // Second attempt should be rate limited
    const res = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Password1' }),
    });
    expect(res.status).toBe(429);
  });

  test('calls onBeforeDelete and onAfterDelete hooks', async () => {
    const hookCalls: string[] = [];
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          accountDeletion: {
            enabled: true,
            onBeforeDelete: async (userId: string) => {
              hookCalls.push(`before:${userId}`);
            },
            onAfterDelete: async (userId: string) => {
              hookCalls.push(`after:${userId}`);
            },
          },
        },
      },
    );

    const reg = await app.request(
      '/auth/register',
      json({ email: 'hooks@test.com', password: 'Password1' }),
    );
    const { token, userId } = (await reg.json()) as { token: string; userId: string };

    const res = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'Password1' }),
    });
    expect(res.status).toBe(200);
    expect(hookCalls).toContain(`before:${userId}`);
    expect(hookCalls).toContain(`after:${userId}`);
  });
});
