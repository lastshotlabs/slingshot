import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  applyPostgresAuthSchema,
  connectPostgres,
  createPostgresAdapter,
} from '@lastshotlabs/slingshot-postgres';

const POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';

describe('PostgreSQL externally managed auth schema', () => {
  const schema = `auth_readiness_${randomUUID().replaceAll('-', '_')}`;
  const admin = new Pool({ connectionString: POSTGRES_URL });
  let connection: Awaited<ReturnType<typeof connectPostgres>>;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(POSTGRES_URL);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    connection = await connectPostgres(scoped.toString(), { migrations: 'assume-ready' });
  });

  afterAll(async () => {
    await connection.pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  test('readiness fails before explicit migration and passes afterwards', async () => {
    await createPostgresAdapter({ pool: connection.pool });

    const missing = await connection.healthCheck();
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('auth schema is not ready');

    await applyPostgresAuthSchema(connection.pool);

    const ready = await connection.healthCheck();
    expect(ready.ok).toBe(true);
    const version = await connection.pool.query<{ version: number }>(
      'SELECT version FROM _slingshot_auth_schema_version',
    );
    expect(Number(version.rows[0]?.version)).toBeGreaterThan(0);
  });
});
