import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolveTestDbConfig } from './helpers/backend-factory';
import { type E2EServerHandle, createTestHttpServer } from '../setup-e2e';

const isPostgresE2e =
  resolveTestDbConfig().auth === 'postgres' && resolveTestDbConfig().sessions === 'postgres';

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe.skipIf(!isPostgresE2e)('Postgres backend E2E', () => {
  let handle: E2EServerHandle;

  beforeAll(async () => {
    handle = await createTestHttpServer(undefined, undefined, { resetBackend: true });
  });

  afterAll(async () => {
    await handle.stop();
  });

  test('session and auth state survive a server restart', async () => {
    const registerRes = await fetch(
      `${handle.baseUrl}/auth/register`,
      json({
        email: 'postgres-restart@example.com',
        password: 'Password123!',
      }),
    );
    expect(registerRes.status).toBe(201);
    const { token } = await registerRes.json();
    expect(token).toBeString();

    await handle.stop();

    const restarted = await createTestHttpServer(undefined, undefined, { resetBackend: false });
    try {
      const meRes = await fetch(`${restarted.baseUrl}/auth/me`, {
        headers: { 'x-user-token': token },
      });
      expect(meRes.status).toBe(200);
      const me = await meRes.json();
      expect(me.email).toBe('postgres-restart@example.com');

      const sessionsRes = await fetch(`${restarted.baseUrl}/auth/sessions`, {
        headers: { 'x-user-token': token },
      });
      expect(sessionsRes.status).toBe(200);
      const { sessions } = await sessionsRes.json();
      expect(sessions.length).toBeGreaterThanOrEqual(1);
    } finally {
      await restarted.stop();
    }
  });
});
