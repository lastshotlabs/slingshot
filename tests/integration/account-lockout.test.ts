import { describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

const json = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('account lockout integration', () => {
  test('returns 423 after maxAttempts failed logins', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          lockout: { maxAttempts: 3, lockoutDuration: 60 },
        },
      },
    );

    // Register an account
    await app.request('/auth/register', json({ email: 'victim@test.com', password: 'Password1!' }));

    // Fail login 3 times
    for (let i = 0; i < 3; i++) {
      const res = await app.request(
        '/auth/login',
        json({ email: 'victim@test.com', password: 'wrong' }),
      );
      expect(res.status).toBe(401);
    }

    // 4th attempt should be locked
    const locked = await app.request(
      '/auth/login',
      json({ email: 'victim@test.com', password: 'wrong' }),
    );
    // M5 security fix: lockout returns 401 (concealed) instead of 423
    expect(locked.status).toBe(401);
  });

  test('correct password also returns 423 when account is locked', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          lockout: { maxAttempts: 2, lockoutDuration: 60 },
        },
      },
    );

    await app.request(
      '/auth/register',
      json({ email: 'victim2@test.com', password: 'Password1!' }),
    );

    // Fail 2 times to trigger lockout
    for (let i = 0; i < 2; i++) {
      await app.request('/auth/login', json({ email: 'victim2@test.com', password: 'wrong' }));
    }

    // Even with correct password, locked account is rejected (concealed as 401)
    const res = await app.request(
      '/auth/login',
      json({ email: 'victim2@test.com', password: 'Password1!' }),
    );
    expect(res.status).toBe(401);
  });

  test('resetOnSuccess clears the failure counter on successful login', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          lockout: { maxAttempts: 3, lockoutDuration: 60, resetOnSuccess: true },
        },
      },
    );

    await app.request(
      '/auth/register',
      json({ email: 'victim4@test.com', password: 'Password1!' }),
    );

    // Fail 2 times (one below maxAttempts)
    for (let i = 0; i < 2; i++) {
      await app.request('/auth/login', json({ email: 'victim4@test.com', password: 'wrong' }));
    }

    // Successful login resets counter
    const okRes = await app.request(
      '/auth/login',
      json({ email: 'victim4@test.com', password: 'Password1!' }),
    );
    expect(okRes.status).toBe(200);

    // Now fail 2 more times — should NOT be locked (counter was reset, maxAttempts=3)
    for (let i = 0; i < 2; i++) {
      const r = await app.request(
        '/auth/login',
        json({ email: 'victim4@test.com', password: 'wrong' }),
      );
      expect(r.status).toBe(401);
    }

    // 3rd failure now triggers lockout
    const r3 = await app.request(
      '/auth/login',
      json({ email: 'victim4@test.com', password: 'wrong' }),
    );
    expect(r3.status).toBe(401); // 3rd failure — just hits maxAttempts, next attempt is 423

    const locked = await app.request(
      '/auth/login',
      json({ email: 'victim4@test.com', password: 'wrong' }),
    );
    expect(locked.status).toBe(401);
  });

  test('lockout does not trigger for unknown email (no user enumeration)', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          lockout: { maxAttempts: 2, lockoutDuration: 60 },
        },
      },
    );

    // Login attempts for a non-existent email — should always return 401, never 423
    for (let i = 0; i < 5; i++) {
      const res = await app.request(
        '/auth/login',
        json({ email: 'ghost@test.com', password: 'anypassword' }),
      );
      expect(res.status).toBe(401);
    }
  });

  test('no lockout when auth.lockout is not configured', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          // no lockout config
        },
      },
    );

    await app.request('/auth/register', json({ email: 'nolock@test.com', password: 'Password1!' }));

    // Fail many times — should never get 423
    for (let i = 0; i < 10; i++) {
      const res = await app.request(
        '/auth/login',
        json({ email: 'nolock@test.com', password: 'wrong' }),
      );
      expect(res.status).toBe(401);
    }
  });
});
