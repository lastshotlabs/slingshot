// Requires a running Postgres instance.
// Run with: bun test tests/docker/permissions-postgres-adapter.test.ts
// Default connection: postgresql://postgres:postgres@localhost:5433/slingshot_test
// Override: TEST_POSTGRES_URL=<url> bun test tests/docker/permissions-postgres-adapter.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createPermissionsPostgresAdapter } from '../../packages/slingshot-permissions/src/adapters/postgres';
import type { PermissionsPostgresAdapter } from '../../packages/slingshot-permissions/src/adapters/postgres';

const CONNECTION =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';

describe('Permissions Postgres adapter (docker)', () => {
  let pool: Pool;
  let adapter: PermissionsPostgresAdapter;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    adapter = await createPermissionsPostgresAdapter(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await adapter.clear();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function makeGrant(overrides: Partial<Parameters<typeof adapter.createGrant>[0]> = {}) {
    return {
      subjectId: 'user-1',
      subjectType: 'user' as const,
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['admin'],
      effect: 'allow' as const,
      grantedBy: 'system',
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // createGrant
  // ---------------------------------------------------------------------------

  describe('createGrant', () => {
    test('creates a grant and returns its id', async () => {
      const id = await adapter.createGrant(makeGrant());
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });

    test('created grant is retrievable via getGrantsForSubject', async () => {
      const id = await adapter.createGrant(makeGrant({ roles: ['editor'] }));
      const grants = await adapter.getGrantsForSubject('user-1');
      expect(grants.length).toBe(1);
      expect(grants[0].id).toBe(id);
      expect(grants[0].roles).toEqual(['editor']);
      expect(grants[0].effect).toBe('allow');
      expect(grants[0].grantedAt).toBeInstanceOf(Date);
    });

    test('validation rejects grant without roles', async () => {
      await expect(adapter.createGrant(makeGrant({ roles: [] }))).rejects.toThrow(
        'at least one role',
      );
    });

    test('validation rejects resourceId without resourceType', async () => {
      await expect(
        adapter.createGrant(makeGrant({ resourceType: null, resourceId: 'res-1' })),
      ).rejects.toThrow('resourceId requires resourceType');
    });

    test('validation rejects invalid effect', async () => {
      await expect(adapter.createGrant(makeGrant({ effect: 'maybe' as any }))).rejects.toThrow(
        "effect must be 'allow' or 'deny'",
      );
    });

    test('stores optional reason', async () => {
      await adapter.createGrant(makeGrant({ reason: 'Promoted to admin' }));
      const grants = await adapter.getGrantsForSubject('user-1');
      expect(grants[0].reason).toBe('Promoted to admin');
    });

    test('stores expiresAt', async () => {
      const future = new Date(Date.now() + 86_400_000);
      await adapter.createGrant(makeGrant({ expiresAt: future }));
      const grants = await adapter.getGrantsForSubject('user-1');
      expect(grants[0].expiresAt).toBeInstanceOf(Date);
      expect(grants[0].expiresAt!.getTime()).toBe(future.getTime());
    });
  });

  // ---------------------------------------------------------------------------
  // revokeGrant
  // ---------------------------------------------------------------------------

  describe('revokeGrant', () => {
    test('revokes an existing grant', async () => {
      const id = await adapter.createGrant(makeGrant());
      const result = await adapter.revokeGrant(id, 'admin-1');
      expect(result).toBe(true);

      // Active grants should no longer include the revoked one
      const active = await adapter.getGrantsForSubject('user-1');
      expect(active.length).toBe(0);

      // History includes the revoked grant with revocation metadata
      const history = await adapter.listGrantHistory('user-1', 'user');
      expect(history[0].revokedBy).toBe('admin-1');
      expect(history[0].revokedAt).toBeInstanceOf(Date);
    });

    test('returns false for already-revoked grant', async () => {
      const id = await adapter.createGrant(makeGrant());
      await adapter.revokeGrant(id, 'admin-1');
      const result = await adapter.revokeGrant(id, 'admin-2');
      expect(result).toBe(false);
    });

    test('returns false for nonexistent grant', async () => {
      const result = await adapter.revokeGrant('nonexistent', 'admin-1');
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getGrantsForSubject
  // ---------------------------------------------------------------------------

  describe('getGrantsForSubject', () => {
    test('returns all grants for a subject', async () => {
      await adapter.createGrant(makeGrant({ roles: ['admin'] }));
      await adapter.createGrant(makeGrant({ roles: ['editor'] }));
      const grants = await adapter.getGrantsForSubject('user-1');
      expect(grants.length).toBe(2);
    });

    test('filters by subjectType', async () => {
      await adapter.createGrant(makeGrant({ subjectType: 'user' }));
      await adapter.createGrant(makeGrant({ subjectId: 'user-1', subjectType: 'group' }));
      const userGrants = await adapter.getGrantsForSubject('user-1', 'user');
      expect(userGrants.length).toBe(1);
      expect(userGrants[0].subjectType).toBe('user');
    });

    test('filters by scope tenantId', async () => {
      await adapter.createGrant(makeGrant({ tenantId: 'tenant-a' }));
      await adapter.createGrant(makeGrant({ tenantId: 'tenant-b' }));
      const grants = await adapter.getGrantsForSubject('user-1', undefined, {
        tenantId: 'tenant-a',
      });
      expect(grants.length).toBe(1);
      expect(grants[0].tenantId).toBe('tenant-a');
    });

    test('filters by scope resourceType and resourceId', async () => {
      await adapter.createGrant(makeGrant({ resourceType: 'document', resourceId: 'doc-1' }));
      await adapter.createGrant(makeGrant({ resourceType: 'document', resourceId: 'doc-2' }));
      await adapter.createGrant(makeGrant({ resourceType: 'project', resourceId: 'proj-1' }));
      const grants = await adapter.getGrantsForSubject('user-1', undefined, {
        resourceType: 'document',
        resourceId: 'doc-1',
      });
      expect(grants.length).toBe(1);
      expect(grants[0].resourceId).toBe('doc-1');
    });

    test('returns empty array for unknown subject', async () => {
      const grants = await adapter.getGrantsForSubject('nonexistent');
      expect(grants).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // listGrantsOnResource
  // ---------------------------------------------------------------------------

  describe('listGrantsOnResource', () => {
    test('returns grants targeting a specific resource', async () => {
      await adapter.createGrant(makeGrant({ resourceType: 'document', resourceId: 'doc-1' }));
      await adapter.createGrant(
        makeGrant({ subjectId: 'user-2', resourceType: 'document', resourceId: 'doc-1' }),
      );
      await adapter.createGrant(makeGrant({ resourceType: 'document', resourceId: 'doc-2' }));
      const grants = await adapter.listGrantsOnResource('document', 'doc-1');
      expect(grants.length).toBe(2);
      grants.forEach(g => {
        expect(g.resourceType).toBe('document');
        expect(g.resourceId).toBe('doc-1');
      });
    });

    test('scopes by tenantId', async () => {
      await adapter.createGrant(
        makeGrant({ tenantId: 'tenant-a', resourceType: 'document', resourceId: 'doc-1' }),
      );
      await adapter.createGrant(
        makeGrant({
          tenantId: 'tenant-b',
          resourceType: 'document',
          resourceId: 'doc-1',
          subjectId: 'user-2',
        }),
      );
      const grants = await adapter.listGrantsOnResource('document', 'doc-1', 'tenant-a');
      expect(grants.length).toBe(1);
      expect(grants[0].tenantId).toBe('tenant-a');
    });

    test('returns empty for resource with no grants', async () => {
      const grants = await adapter.listGrantsOnResource('document', 'nonexistent');
      expect(grants).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Wildcard grants (null resourceType / resourceId)
  // ---------------------------------------------------------------------------

  describe('wildcard grants', () => {
    test('grant with null resourceType applies to all resource types', async () => {
      const id = await adapter.createGrant(makeGrant({ resourceType: null, resourceId: null }));
      const grants = await adapter.getGrantsForSubject('user-1');
      expect(grants.length).toBe(1);
      expect(grants[0].id).toBe(id);
      expect(grants[0].resourceType).toBeNull();
      expect(grants[0].resourceId).toBeNull();
    });

    test('grant with resourceType but null resourceId applies to all instances', async () => {
      await adapter.createGrant(makeGrant({ resourceType: 'document', resourceId: null }));
      const grants = await adapter.getGrantsForSubject('user-1');
      expect(grants[0].resourceType).toBe('document');
      expect(grants[0].resourceId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant-scoped grants
  // ---------------------------------------------------------------------------

  describe('tenant-scoped grants', () => {
    test('grants are isolated per tenant', async () => {
      await adapter.createGrant(makeGrant({ tenantId: 'tenant-a', roles: ['admin'] }));
      await adapter.createGrant(makeGrant({ tenantId: 'tenant-b', roles: ['viewer'] }));

      const tenantA = await adapter.getGrantsForSubject('user-1', undefined, {
        tenantId: 'tenant-a',
      });
      const tenantB = await adapter.getGrantsForSubject('user-1', undefined, {
        tenantId: 'tenant-b',
      });
      expect(tenantA.length).toBe(1);
      expect(tenantA[0].roles).toEqual(['admin']);
      expect(tenantB.length).toBe(1);
      expect(tenantB[0].roles).toEqual(['viewer']);
    });

    test('global grants (null tenantId) are separate from tenant-scoped', async () => {
      await adapter.createGrant(makeGrant({ tenantId: null }));
      await adapter.createGrant(makeGrant({ tenantId: 'tenant-a' }));
      const all = await adapter.getGrantsForSubject('user-1');
      expect(all.length).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteAllGrantsForSubject
  // ---------------------------------------------------------------------------

  describe('deleteAllGrantsForSubject', () => {
    test('deletes all grants for a subject', async () => {
      await adapter.createGrant(makeGrant());
      await adapter.createGrant(makeGrant({ roles: ['editor'] }));
      await adapter.createGrant(makeGrant({ subjectId: 'user-2' }));

      await adapter.deleteAllGrantsForSubject({ subjectId: 'user-1', subjectType: 'user' });
      const user1Grants = await adapter.getGrantsForSubject('user-1');
      expect(user1Grants.length).toBe(0);

      const user2Grants = await adapter.getGrantsForSubject('user-2');
      expect(user2Grants.length).toBe(1);
    });

    test('scopes by subjectType', async () => {
      await adapter.createGrant(makeGrant({ subjectType: 'user' }));
      await adapter.createGrant(makeGrant({ subjectId: 'user-1', subjectType: 'group' }));

      await adapter.deleteAllGrantsForSubject({ subjectId: 'user-1', subjectType: 'user' });
      const remaining = await adapter.getGrantsForSubject('user-1');
      expect(remaining.length).toBe(1);
      expect(remaining[0].subjectType).toBe('group');
    });
  });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  describe('clear', () => {
    test('removes all grants', async () => {
      await adapter.createGrant(makeGrant());
      await adapter.createGrant(makeGrant({ subjectId: 'user-2' }));
      await adapter.clear();
      const grants1 = await adapter.getGrantsForSubject('user-1');
      const grants2 = await adapter.getGrantsForSubject('user-2');
      expect(grants1.length).toBe(0);
      expect(grants2.length).toBe(0);
    });
  });
});
