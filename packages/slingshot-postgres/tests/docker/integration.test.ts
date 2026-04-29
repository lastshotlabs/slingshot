/**
 * Docker-based integration test for slingshot-postgres.
 *
 * Tests `createPostgresAdapter`, `connectPostgres`, and `parseMigrationVersion`
 * against a real Postgres instance. Schema migrations run automatically on first
 * connection — no manual setup required.
 *
 * Requires a running Postgres instance (Docker Compose from the repo root or
 * `TEST_POSTGRES_URL` env var).
 *
 * Usage:
 *   TEST_POSTGRES_URL=postgresql://postgres:postgres@localhost:5433/slingshot_test \
 *     bun test packages/slingshot-postgres/tests/docker/
 *
 * The test is skipped when no Postgres connection is available.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';

// ============================================================================
// Connection bootstrap
// ============================================================================

const CONNECTION =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';

/** Drop all auth-related tables so `createPostgresAdapter` runs fresh migrations. */
async function resetAuthSchema(targetPool: Pool): Promise<void> {
  await targetPool.query('DROP TABLE IF EXISTS slingshot_group_memberships CASCADE');
  await targetPool.query('DROP TABLE IF EXISTS slingshot_groups CASCADE');
  await targetPool.query('DROP TABLE IF EXISTS slingshot_webauthn_credentials CASCADE');
  await targetPool.query('DROP TABLE IF EXISTS slingshot_recovery_codes CASCADE');
  await targetPool.query('DROP TABLE IF EXISTS slingshot_tenant_roles CASCADE');
  await targetPool.query('DROP TABLE IF EXISTS slingshot_user_roles CASCADE');
  await targetPool.query('DROP TABLE IF EXISTS slingshot_oauth_accounts CASCADE');
  await targetPool.query('DROP TABLE IF EXISTS slingshot_users CASCADE');
  await targetPool.query('DROP TABLE IF EXISTS _slingshot_auth_schema_version');
}

let dockerAvailable = false;
let adminPool: Pool;

beforeAll(async () => {
  try {
    adminPool = new Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 3000 });
    await adminPool.query('SELECT 1');
    dockerAvailable = true;
    await resetAuthSchema(adminPool);
  } catch {
    dockerAvailable = false;
  }
});

afterAll(async () => {
  if (adminPool) {
    await adminPool.end().catch(() => undefined);
  }
});

// ============================================================================
// Tests
// ============================================================================

describe('parseMigrationVersion (exported)', () => {
  // Skip if no docker, but also test in process if available.
  const testFn = dockerAvailable ? test : test.skip;

  testFn('parseMigrationVersion is exported from the package', async () => {
    // Dynamic import so we can test the re-export path even when the
    // package has already been partially loaded by the host Bun instance.
    const { parseMigrationVersion } = await import('../../src/index.js');
    expect(typeof parseMigrationVersion).toBe('function');
  });

  testFn('accepts valid version numbers', async () => {
    const { parseMigrationVersion } = await import('../../src/index.js');
    expect(parseMigrationVersion(0, 10)).toBe(0);
    expect(parseMigrationVersion(5, 10)).toBe(5);
    expect(parseMigrationVersion(10, 10)).toBe(10);
  });

  testFn('throws when version exceeds max', async () => {
    const { parseMigrationVersion } = await import('../../src/index.js');
    expect(() => parseMigrationVersion(6, 5)).toThrow(
      '[slingshot-postgres] Database schema version 6 is newer than this binary supports (5)',
    );
  });

  testFn('throws on invalid input', async () => {
    const { parseMigrationVersion } = await import('../../src/index.js');
    expect(() => parseMigrationVersion(-1, 5)).toThrow('Invalid value');
    expect(() => parseMigrationVersion('abc', 5)).toThrow('Invalid value');
    expect(() => parseMigrationVersion(3.5, 5)).toThrow('Invalid value');
    expect(() => parseMigrationVersion(null, 5)).toThrow('Invalid value');
  });
});

describe('createPostgresAdapter (docker)', () => {
  let pool: Pool;
  let adapter: Awaited<ReturnType<typeof import('../../src/index.js')['createPostgresAdapter']>>;

  const itOrSkip = dockerAvailable ? test : test.skip;

  beforeAll(async () => {
    if (!dockerAvailable) return;
    pool = new Pool({ connectionString: CONNECTION });
    const { createPostgresAdapter } = await import('../../src/index.js');
    await resetAuthSchema(pool);
    adapter = await createPostgresAdapter({ pool });
  });

  afterAll(async () => {
    if (pool) await pool.end().catch(() => undefined);
  });

  itOrSkip('migrates schema on first connection', async () => {
    // Verify that the version table exists and holds exactly one row.
    const result = await pool.query('SELECT version FROM _slingshot_auth_schema_version');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].version).toBeNumber();
  });

  itOrSkip('creates a user and finds by email', async () => {
    const hash = await Bun.password.hash('test-password');
    const { id } = await adapter.create('docker-test@example.com', hash);
    expect(id).toBeString();

    const found = await adapter.findByEmail('docker-test@example.com');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(id);
    expect(found!.passwordHash).toBe(hash);
  });

  itOrSkip('returns null for unknown email', async () => {
    const result = await adapter.findByEmail('unknown@example.com');
    expect(result).toBeNull();
  });

  itOrSkip('rejects duplicate email with 409', async () => {
    const hash = await Bun.password.hash('pw');
    await adapter.create('dupe@example.com', hash);

    const err = await adapter.create('dupe@example.com', hash).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { status?: number }).status).toBe(409);
  });

  itOrSkip('verifies password', async () => {
    const hash = await Bun.password.hash('correct-horse');
    const { id } = await adapter.create('password-test@example.com', hash);

    expect(await adapter.verifyPassword(id, 'correct-horse')).toBe(true);
    expect(await adapter.verifyPassword(id, 'wrong')).toBe(false);
  });

  itOrSkip('deletes user and cascades', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('delete-me@example.com', hash);

    expect(await adapter.findByEmail('delete-me@example.com')).not.toBeNull();
    // deleteUser is optional on AuthAdapter — assert via unknown cast.
    await (adapter as unknown as { deleteUser: (id: string) => Promise<void> }).deleteUser(id);
    expect(await adapter.findByEmail('delete-me@example.com')).toBeNull();
  });

  itOrSkip('sets and gets email verified', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('verified@example.com', hash);

    expect(await adapter.getEmailVerified!(id)).toBe(false);
    await adapter.setEmailVerified!(id, true);
    expect(await adapter.getEmailVerified!(id)).toBe(true);
  });

  itOrSkip('provides user profile via getUser', async () => {
    const hash = await Bun.password.hash('pw');
    const { id } = await adapter.create('profile@example.com', hash);
    const user = await adapter.getUser!(id);

    expect(user).not.toBeNull();
    expect(user!.email).toBe('profile@example.com');
  });
});

describe('connectPostgres (docker)', () => {
  const itOrSkip = dockerAvailable ? test : test.skip;

  itOrSkip('connects and verifies with SELECT 1', async () => {
    const { connectPostgres } = await import('../../src/index.js');
    const db = await connectPostgres(CONNECTION, { pool: { max: 2 } });

    try {
      // The pool is eagerly verified — if we got here, it's connected.
      const result = await db.pool.query('SELECT 1 AS ok');
      expect(result.rows[0]?.ok).toBe(1);

      // healthCheck must return ok
      const health = await db.healthCheck();
      expect(health.ok).toBe(true);
    } finally {
      await db.pool.end();
    }
  });

  itOrSkip('connectPostgres fails fast with bad connection string', async () => {
    const { connectPostgres } = await import('../../src/index.js');
    // Use a connection string that will fail quickly (localhost with no PG).
    await expect(
      connectPostgres('postgresql://nobody@localhost:19999/bogus', {
        pool: { connectionTimeoutMs: 1000 },
      }),
    ).rejects.toThrow();
  });
});

describe('migrations (docker)', () => {
  const itOrSkip = dockerAvailable ? test : test.skip;

  itOrSkip('run migrations and produce correct version', async () => {
    const { createPostgresAdapter } = await import('../../src/index.js');
    const freshPool = new Pool({ connectionString: CONNECTION, max: 2 });

    try {
      await resetAuthSchema(freshPool);
      await createPostgresAdapter({ pool: freshPool });
      const result = await freshPool.query(
        'SELECT version FROM _slingshot_auth_schema_version',
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].version).toBeGreaterThanOrEqual(2);
    } finally {
      await freshPool.end();
    }
  });

  itOrSkip('are idempotent on re-connection', async () => {
    const { createPostgresAdapter } = await import('../../src/index.js');
    // First call — full migration.
    const pool1 = new Pool({ connectionString: CONNECTION, max: 2 });
    try {
      await resetAuthSchema(pool1);
      await createPostgresAdapter({ pool: pool1 });
      const result1 = await pool1.query(
        'SELECT version FROM _slingshot_auth_schema_version',
      );
      expect(result1.rows[0].version).toBeGreaterThanOrEqual(2);
    } finally {
      await pool1.end();
    }

    // Second call — should be a no-op but succeed.
    const pool2 = new Pool({ connectionString: CONNECTION, max: 2 });
    try {
      await createPostgresAdapter({ pool: pool2 });
      const result2 = await pool2.query(
        'SELECT version FROM _slingshot_auth_schema_version',
      );
      expect(result2.rows[0].version).toBeGreaterThanOrEqual(2);
    } finally {
      await pool2.end();
    }
  });
});
