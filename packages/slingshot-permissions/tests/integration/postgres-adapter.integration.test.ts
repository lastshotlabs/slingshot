/**
 * Postgres integration tests — run against a real PostgreSQL instance.
 *
 * Set POSTGRES_URL to enable, e.g.:
 *   POSTGRES_URL=postgres://user:pass@localhost:5432/testdb bun test
 *
 * These tests verify that the SQL queries, JSONB handling, and migration
 * system work correctly against a real Postgres database — something the
 * mock-based tests cannot guarantee.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PermissionGrant } from '@lastshotlabs/slingshot-core';
import { createPermissionsPostgresAdapter } from '../../src/adapters/postgres';
import type { PgRow, PoolLike } from '../../src/adapters/postgres';

const POSTGRES_URL = process.env.POSTGRES_URL;

// ---------------------------------------------------------------------------
// pg.Pool → PoolLike bridge
//
// pg.Pool.query<T>() returns QueryResult<T>, which has rows: T[] and
// rowCount: number | null — structurally compatible with PoolLike.
// ---------------------------------------------------------------------------

async function createPool(url: string): Promise<{ pool: PoolLike; end(): Promise<void> }> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url });
  return {
    pool: { query: (sql, params) => pool.query<PgRow>(sql, params) },
    end: () => pool.end(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!POSTGRES_URL)('Postgres permissions adapter — integration', () => {
  let poolHandle: Awaited<ReturnType<typeof createPool>>;
  let adapter: Awaited<ReturnType<typeof createPermissionsPostgresAdapter>>;

  type GrantInput = Omit<PermissionGrant, 'id' | 'grantedAt'>;

  function baseGrant(overrides: Partial<GrantInput> = {}): GrantInput {
    return {
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['admin'],
      effect: 'allow',
      grantedBy: 'system',
      ...overrides,
    };
  }

  beforeAll(async () => {
    poolHandle = await createPool(POSTGRES_URL!);
    adapter = await createPermissionsPostgresAdapter(poolHandle.pool);
  });

  afterAll(async () => {
    await poolHandle.end();
  });

  beforeEach(async () => {
    await adapter.clear();
  });

  // --- createGrant ---

  test('creates a grant and returns a UUID', async () => {
    const id = await adapter.createGrant(baseGrant());
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('created grant is retrievable and roles are a parsed array (JSONB)', async () => {
    const id = await adapter.createGrant(baseGrant({ roles: ['editor', 'viewer'] }));
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(1);
    expect(grants[0].id).toBe(id);
    expect(Array.isArray(grants[0].roles)).toBe(true);
    expect(grants[0].roles).toEqual(['editor', 'viewer']);
    expect(grants[0].grantedAt).toBeInstanceOf(Date);
  });

  test('validation rejects empty roles', async () => {
    await expect(adapter.createGrant(baseGrant({ roles: [] }))).rejects.toThrow(
      'at least one role',
    );
  });

  // --- revokeGrant ---

  test('revokes a grant and it is no longer returned', async () => {
    const id = await adapter.createGrant(baseGrant());
    expect(await adapter.revokeGrant(id, 'admin-1')).toBe(true);

    // Option A: revoked grants are filtered at the query level
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants.find(g => g.id === id)).toBeUndefined();
  });

  test('returns false for already-revoked grant', async () => {
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin-1');
    expect(await adapter.revokeGrant(id, 'admin-2')).toBe(false);
  });

  test('tenantScope restricts revocation', async () => {
    const id = await adapter.createGrant(baseGrant({ tenantId: 'tenant-a' }));
    expect(await adapter.revokeGrant(id, 'admin', 'tenant-b')).toBe(false);
    expect(await adapter.revokeGrant(id, 'admin', 'tenant-a')).toBe(true);
  });

  // --- getGrantsForSubject ---

  test('filters by subjectType', async () => {
    await adapter.createGrant(baseGrant({ subjectType: 'user' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'group' }));
    const grants = await adapter.getGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(1);
    expect(grants[0].subjectType).toBe('user');
  });

  test('filters by scope tenantId', async () => {
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-a' }));
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-b' }));
    const grants = await adapter.getGrantsForSubject('user-1', undefined, { tenantId: 'tenant-a' });
    expect(grants).toHaveLength(1);
    expect(grants[0].tenantId).toBe('tenant-a');
  });

  // --- listGrantsOnResource ---

  test('null tenantId uses IS NULL (F1)', async () => {
    await adapter.createGrant(
      baseGrant({ resourceType: 'post', resourceId: 'p1', tenantId: null }),
    );
    await adapter.createGrant(
      baseGrant({ subjectId: 'u2', resourceType: 'post', resourceId: 'p1', tenantId: 'tenant-a' }),
    );
    const grants = await adapter.listGrantsOnResource('post', 'p1', null);
    expect(grants).toHaveLength(1);
    expect(grants[0].tenantId).toBeNull();
  });

  // --- getEffectiveGrantsForSubject ---

  test('returns only applicable cascade levels for given scope', async () => {
    await adapter.createGrant(baseGrant({ tenantId: null, roles: ['global'] }));
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-a', roles: ['tenant'] }));
    await adapter.createGrant(
      baseGrant({
        tenantId: 'tenant-a',
        resourceType: 'post',
        resourceId: null,
        roles: ['type-wide'],
      }),
    );
    await adapter.createGrant(
      baseGrant({
        tenantId: 'tenant-a',
        resourceType: 'post',
        resourceId: 'post-1',
        roles: ['specific'],
      }),
    );
    await adapter.createGrant(
      baseGrant({ subjectId: 'user-2', tenantId: 'tenant-b', roles: ['other-tenant'] }),
    );

    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user', {
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-1',
    });
    // Should return all four cascade levels for user-1
    expect(grants).toHaveLength(4);
    const roles = new Set(grants.flatMap(g => g.roles));
    expect(roles.has('global')).toBe(true);
    expect(roles.has('tenant')).toBe(true);
    expect(roles.has('type-wide')).toBe(true);
    expect(roles.has('specific')).toBe(true);
    expect(roles.has('other-tenant')).toBe(false);
  });

  test('cascade level 1: specific resource grant does not cover other resources', async () => {
    await adapter.createGrant(
      baseGrant({
        tenantId: 'tenant-a',
        resourceType: 'post',
        resourceId: 'post-1',
        roles: ['owner'],
      }),
    );
    const hit = await adapter.getEffectiveGrantsForSubject('user-1', 'user', {
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-1',
    });
    expect(hit).toHaveLength(1);

    const miss = await adapter.getEffectiveGrantsForSubject('user-1', 'user', {
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-99',
    });
    expect(miss).toHaveLength(0);
  });

  test('revoked grants are excluded from getEffectiveGrantsForSubject', async () => {
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin');
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(0);
  });

  // --- expiry filtering ---

  test('expired grants are not returned by getGrantsForSubject', async () => {
    // Insert a non-expired grant normally
    await adapter.createGrant(baseGrant({ roles: ['active'] }));
    // Insert expired grant directly via SQL (createGrant rejects past dates)
    await poolHandle.pool.query(
      `INSERT INTO permission_grants
       (id, subject_id, subject_type, tenant_id, resource_type, resource_id, roles, effect, granted_by, granted_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)`,
      [
        'exp-id',
        'user-1',
        'user',
        null,
        null,
        null,
        '["expired"]',
        'allow',
        'system',
        new Date(Date.now() - 10_000),
      ],
    );
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants.every(g => g.roles[0] !== 'expired')).toBe(true);
  });

  // --- listGrantHistory ---

  test('includes revoked grants', async () => {
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin-1');
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history.find(g => g.id === id)?.revokedBy).toBe('admin-1');
  });

  test('includes expired grants', async () => {
    await poolHandle.pool.query(
      `INSERT INTO permission_grants
       (id, subject_id, subject_type, tenant_id, resource_type, resource_id, roles, effect, granted_by, granted_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)`,
      [
        'hist-exp',
        'user-1',
        'user',
        null,
        null,
        null,
        '["viewer"]',
        'allow',
        'system',
        new Date(Date.now() - 10_000),
      ],
    );
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history.find(g => g.id === 'hist-exp')?.roles).toEqual(['viewer']);
  });

  test('scopes to subjectId + subjectType', async () => {
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'user' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-2', subjectType: 'user' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'group' }));
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history.every(g => g.subjectId === 'user-1' && g.subjectType === 'user')).toBe(true);
    expect(history).toHaveLength(1);
  });

  // --- deleteAllGrantsForSubject ---

  test('hard-deletes all grants for a subject', async () => {
    await adapter.createGrant(baseGrant());
    await adapter.createGrant(baseGrant({ subjectId: 'user-2' }));
    await adapter.deleteAllGrantsForSubject({ subjectId: 'user-1', subjectType: 'user' });
    expect(await adapter.getGrantsForSubject('user-1')).toHaveLength(0);
    expect(await adapter.getGrantsForSubject('user-2')).toHaveLength(1);
  });

  // --- clear ---

  test('clear removes all grants', async () => {
    await adapter.createGrant(baseGrant());
    await adapter.createGrant(baseGrant({ subjectId: 'user-2' }));
    await adapter.clear();
    expect(await adapter.getGrantsForSubject('user-1')).toHaveLength(0);
    expect(await adapter.getGrantsForSubject('user-2')).toHaveLength(0);
  });

  // --- migrations (idempotency) ---

  test('calling createPermissionsPostgresAdapter again is idempotent (migrations skip)', async () => {
    // Should not throw even though schema already exists
    const adapter2 = await createPermissionsPostgresAdapter(poolHandle.pool);
    expect(await adapter2.getGrantsForSubject('nobody')).toEqual([]);
  });
});
