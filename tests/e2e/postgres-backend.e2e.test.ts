import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type E2EServerHandle, createTestHttpServer } from '../setup-e2e';
import { resolveTestDbConfig } from './helpers/backend-factory';

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
    handle = await createTestHttpServer({ metrics: { enabled: true } }, undefined, {
      resetBackend: true,
    });
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
    handle = await createTestHttpServer({ metrics: { enabled: true } }, undefined, {
      resetBackend: false,
    });

    const meRes = await fetch(`${handle.baseUrl}/auth/me`, {
      headers: { 'x-user-token': token },
    });
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me.email).toBe('postgres-restart@example.com');

    const sessionsRes = await fetch(`${handle.baseUrl}/auth/sessions`, {
      headers: { 'x-user-token': token },
    });
    expect(sessionsRes.status).toBe(200);
    const { sessions } = await sessionsRes.json();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  test('/health/ready reports postgres readiness', async () => {
    const res = await fetch(`${handle.baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.postgres.ok).toBe(true);
    expect(body.checks.postgres.pool.total).toBeGreaterThanOrEqual(0);
    expect(body.checks.postgres.queries.total).toBeGreaterThan(0);
  });

  test('/metrics exposes postgres operational metrics', async () => {
    await fetch(`${handle.baseUrl}/health/ready`);

    const res = await fetch(`${handle.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('slingshot_postgres_pool_clients');
    expect(body).toContain('slingshot_postgres_query_count');
    expect(body).toContain('slingshot_postgres_query_latency_ms');
    expect(body).toContain('slingshot_postgres_migration_mode');
  });
});
