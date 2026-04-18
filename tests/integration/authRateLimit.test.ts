import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

const json = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('auth route rate limiting', () => {
  test('register returns 429 when the bucket reaches the configured max', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          rateLimit: { register: { max: 2, windowMs: 60000 } },
        },
      },
    );

    // First registration should succeed
    const res1 = await app.request(
      '/auth/register',
      json({ email: 'a@b.com', password: 'Password1' }),
    );
    expect(res1.status).toBe(201);

    // Second request reaches the configured ceiling and is rate limited.
    const res2 = await app.request(
      '/auth/register',
      json({ email: 'b@c.com', password: 'Password1' }),
    );
    expect(res2.status).toBe(429);
  });

  test('login returns 429 after exceeding isLimited check', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          rateLimit: { login: { max: 1, windowMs: 60000 } },
        },
      },
    );

    // Register first
    await app.request('/auth/register', json({ email: 'test@test.com', password: 'Password1' }));

    // First login attempt with wrong password (increments counter)
    await app.request('/auth/login', json({ email: 'test@test.com', password: 'wrong1' }));

    // Second login attempt should be rate limited (isLimited returns true)
    const res = await app.request(
      '/auth/login',
      json({ email: 'test@test.com', password: 'wrong2' }),
    );
    expect(res.status).toBe(429);
  });
});
