import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createSqlitePermissionsAdapter } from '../../src/adapters/sqlite';
import type { PermissionsSqliteAdapter } from '../../src/adapters/sqlite';

describe('Permissions SQLite adapter', () => {
  let db: Database;
  let adapter: PermissionsSqliteAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = createSqlitePermissionsAdapter(db);
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function makeGrant(
    overrides: Partial<Parameters<typeof adapter.createGrant>[0]> = {},
  ): Parameters<typeof adapter.createGrant>[0] {
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
      // @ts-expect-error — intentionally passing invalid effect to test runtime validation
      await expect(adapter.createGrant(makeGrant({ effect: 'maybe' }))).rejects.toThrow(
        "effect must be 'allow' or 'deny'",
      );
    });

    test('stores optional reason', async () => {
      await adapter.createGrant(makeGrant({ reason: 'Promoted to admin' }));
      const grants = await adapter.getGrantsForSubject('user-1');
      expect(grants[0].reason).toBe('Promoted to admin');
    });

    test('stores expiresAt', async () => {
      const future = new Date(Date.now() + 86_400_000); // +1 day
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
    test('revokes an existing grant and it is no longer returned', async () => {
      const id = await adapter.createGrant(makeGrant());
      const result = await adapter.revokeGrant(id, 'admin-1');
      expect(result).toBe(true);

      // Option A: revoked grants are filtered at the query level
      const grants = await adapter.getGrantsForSubject('user-1');
      expect(grants).toHaveLength(0);
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

    test('null tenantId returns only global (tenantId IS NULL) grants', async () => {
      await adapter.createGrant(
        makeGrant({ resourceType: 'document', resourceId: 'doc-1', tenantId: null }),
      );
      await adapter.createGrant(
        makeGrant({
          subjectId: 'user-2',
          resourceType: 'document',
          resourceId: 'doc-1',
          tenantId: 'tenant-a',
        }),
      );
      const grants = await adapter.listGrantsOnResource('document', 'doc-1', null);
      expect(grants.length).toBe(1);
      expect(grants[0].tenantId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getEffectiveGrantsForSubject
  // ---------------------------------------------------------------------------

  describe('getEffectiveGrantsForSubject', () => {
    test('returns global grant with no scope', async () => {
      await adapter.createGrant(
        makeGrant({ tenantId: null, resourceType: null, resourceId: null }),
      );
      const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
      expect(grants).toHaveLength(1);
    });

    test('excludes tenant-scoped grant when no scope provided', async () => {
      await adapter.createGrant(makeGrant({ tenantId: 'tenant-a' }));
      const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
      expect(grants).toHaveLength(0);
    });

    test('returns global + tenant-wide grants for tenant scope', async () => {
      await adapter.createGrant(makeGrant({ tenantId: null, roles: ['global'] }));
      await adapter.createGrant(makeGrant({ tenantId: 'tenant-a', roles: ['tenant'] }));
      await adapter.createGrant(makeGrant({ tenantId: 'tenant-b', roles: ['other'] }));
      const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user', {
        tenantId: 'tenant-a',
      });
      expect(grants).toHaveLength(2);
      const roleSet = new Set(grants.flatMap(g => g.roles));
      expect(roleSet.has('global')).toBe(true);
      expect(roleSet.has('tenant')).toBe(true);
      expect(roleSet.has('other')).toBe(false);
    });

    test('cascade level 2: resource-type-wide grant applies when evaluating specific resource', async () => {
      await adapter.createGrant(
        makeGrant({
          tenantId: 'tenant-a',
          resourceType: 'post',
          resourceId: null,
          roles: ['editor'],
        }),
      );
      const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user', {
        tenantId: 'tenant-a',
        resourceType: 'post',
        resourceId: 'post-42',
      });
      expect(grants).toHaveLength(1);
      expect(grants[0].roles).toEqual(['editor']);
    });

    test('cascade level 1: specific resource grant does not cover other resources', async () => {
      await adapter.createGrant(
        makeGrant({
          tenantId: 'tenant-a',
          resourceType: 'post',
          resourceId: 'post-42',
          roles: ['owner'],
        }),
      );
      const hit = await adapter.getEffectiveGrantsForSubject('user-1', 'user', {
        tenantId: 'tenant-a',
        resourceType: 'post',
        resourceId: 'post-42',
      });
      expect(hit).toHaveLength(1);

      const miss = await adapter.getEffectiveGrantsForSubject('user-1', 'user', {
        tenantId: 'tenant-a',
        resourceType: 'post',
        resourceId: 'post-99',
      });
      expect(miss).toHaveLength(0);
    });

    test('revoked grants are excluded', async () => {
      const id = await adapter.createGrant(makeGrant());
      await adapter.revokeGrant(id, 'admin');
      const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
      expect(grants).toHaveLength(0);
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
      // Without scope filter, both show
      const all = await adapter.getGrantsForSubject('user-1');
      expect(all.length).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Expiry filtering
  // ---------------------------------------------------------------------------

  describe('expiry filtering', () => {
    test('getGrantsForSubject excludes expired grants', async () => {
      const past = new Date(Date.now() - 10_000);
      const future = new Date(Date.now() + 86_400_000);
      // SQLite stores expiresAt as ms; bypass createGrant validation by inserting raw
      // We use the adapter's createGrant with a future date, then read to confirm active ones work
      await adapter.createGrant(makeGrant({ roles: ['active'], expiresAt: future }));
      // Insert an expired row directly via raw SQL (createGrant rejects past dates)
      db.run(
        `INSERT INTO permission_grants
         (id, subject_id, subject_type, tenant_id, resource_type, resource_id, roles, effect, granted_by, granted_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'expired-id',
          'user-1',
          'user',
          null,
          null,
          null,
          '["expired-role"]',
          'allow',
          'system',
          Date.now(),
          past.getTime(),
        ],
      );
      const grants = await adapter.getGrantsForSubject('user-1');
      expect(grants).toHaveLength(1);
      expect(grants[0].roles).toEqual(['active']);
    });

    test('listGrantsOnResource excludes expired grants', async () => {
      const past = new Date(Date.now() - 10_000);
      await adapter.createGrant(
        makeGrant({
          resourceType: 'post',
          resourceId: 'post-1',
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      );
      db.run(
        `INSERT INTO permission_grants
         (id, subject_id, subject_type, tenant_id, resource_type, resource_id, roles, effect, granted_by, granted_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'expired-res',
          'user-2',
          'user',
          null,
          'post',
          'post-1',
          '["viewer"]',
          'allow',
          'system',
          Date.now(),
          past.getTime(),
        ],
      );
      const grants = await adapter.listGrantsOnResource('post', 'post-1');
      expect(grants).toHaveLength(1);
      expect(grants[0].subjectId).toBe('user-1');
    });

    test('non-expiring grants (null expiresAt) are always returned', async () => {
      await adapter.createGrant(makeGrant({ roles: ['admin'] })); // no expiresAt
      const grants = await adapter.getGrantsForSubject('user-1');
      expect(grants).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // listGrantHistory
  // ---------------------------------------------------------------------------

  describe('listGrantHistory', () => {
    test('returns active grants', async () => {
      await adapter.createGrant(makeGrant({ roles: ['admin'] }));
      const history = await adapter.listGrantHistory('user-1', 'user');
      expect(history).toHaveLength(1);
    });

    test('includes revoked grants', async () => {
      const id = await adapter.createGrant(makeGrant());
      await adapter.revokeGrant(id, 'admin-1');
      const history = await adapter.listGrantHistory('user-1', 'user');
      expect(history).toHaveLength(1);
      expect(history[0].revokedBy).toBe('admin-1');
      expect(history[0].revokedAt).toBeInstanceOf(Date);
    });

    test('includes expired grants', async () => {
      const past = new Date(Date.now() - 10_000);
      db.run(
        `INSERT INTO permission_grants
         (id, subject_id, subject_type, tenant_id, resource_type, resource_id, roles, effect, granted_by, granted_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'exp-hist',
          'user-1',
          'user',
          null,
          null,
          null,
          '["viewer"]',
          'allow',
          'system',
          Date.now(),
          past.getTime(),
        ],
      );
      const history = await adapter.listGrantHistory('user-1', 'user');
      expect(history).toHaveLength(1);
      expect(history[0].roles).toEqual(['viewer']);
    });

    test('scopes to the given subjectId + subjectType', async () => {
      await adapter.createGrant(makeGrant({ subjectId: 'user-1', subjectType: 'user' }));
      await adapter.createGrant(makeGrant({ subjectId: 'user-2', subjectType: 'user' }));
      await adapter.createGrant(makeGrant({ subjectId: 'user-1', subjectType: 'group' }));
      const history = await adapter.listGrantHistory('user-1', 'user');
      expect(history).toHaveLength(1);
      expect(history[0].subjectId).toBe('user-1');
      expect(history[0].subjectType).toBe('user');
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

      // user-2 grants unaffected
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
  // deleteAllGrantsOnResource
  // ---------------------------------------------------------------------------

  describe('deleteAllGrantsOnResource', () => {
    test('removes all grants on the specified resource across tenants', async () => {
      await adapter.createGrant(
        makeGrant({ subjectId: 'u1', resourceType: 'doc', resourceId: 'doc-1', tenantId: 'ta' }),
      );
      await adapter.createGrant(
        makeGrant({ subjectId: 'u2', resourceType: 'doc', resourceId: 'doc-1', tenantId: 'tb' }),
      );
      await adapter.createGrant(
        makeGrant({ subjectId: 'u3', resourceType: 'doc', resourceId: 'doc-2', tenantId: 'ta' }),
      );
      await adapter.deleteAllGrantsOnResource('doc', 'doc-1');
      const doc1 = await adapter.listGrantsOnResource('doc', 'doc-1');
      expect(doc1.length).toBe(0);
      const doc2 = await adapter.listGrantsOnResource('doc', 'doc-2');
      expect(doc2.length).toBe(1);
    });

    test('scopes removal to matching tenantId', async () => {
      await adapter.createGrant(
        makeGrant({ resourceType: 'doc', resourceId: 'doc-1', tenantId: 'ta' }),
      );
      await adapter.createGrant(
        makeGrant({ resourceType: 'doc', resourceId: 'doc-1', tenantId: 'tb' }),
      );
      await adapter.deleteAllGrantsOnResource('doc', 'doc-1', 'ta');
      const remaining = await adapter.listGrantsOnResource('doc', 'doc-1');
      expect(remaining.length).toBe(1);
      expect(remaining[0].tenantId).toBe('tb');
    });

    test('tenantId=null removes only global grants on that resource', async () => {
      await adapter.createGrant(
        makeGrant({ resourceType: 'doc', resourceId: 'doc-1', tenantId: null }),
      );
      await adapter.createGrant(
        makeGrant({ resourceType: 'doc', resourceId: 'doc-1', tenantId: 'ta' }),
      );
      await adapter.deleteAllGrantsOnResource('doc', 'doc-1', null);
      const remaining = await adapter.listGrantsOnResource('doc', 'doc-1');
      expect(remaining.length).toBe(1);
      expect(remaining[0].tenantId).toBe('ta');
    });
  });

  // ---------------------------------------------------------------------------
  // createGrants (batch)
  // ---------------------------------------------------------------------------

  describe('createGrants', () => {
    test('creates all grants and returns IDs in order', async () => {
      const ids = await adapter.createGrants([
        makeGrant({ subjectId: 'u-a', roles: ['admin'] }),
        makeGrant({ subjectId: 'u-b', roles: ['reader'] }),
      ]);
      expect(ids.length).toBe(2);
      expect(new Set(ids).size).toBe(2);
      const gA = await adapter.getGrantsForSubject('u-a');
      expect(gA[0].roles).toEqual(['admin']);
      const gB = await adapter.getGrantsForSubject('u-b');
      expect(gB[0].roles).toEqual(['reader']);
    });

    test('empty input returns empty array without inserting anything', async () => {
      const ids = await adapter.createGrants([]);
      expect(ids).toEqual([]);
    });

    test('validates all grants atomically — invalid grant rolls back all inserts', async () => {
      await expect(
        adapter.createGrants([
          makeGrant({ subjectId: 'u-good' }),
          { ...makeGrant({ subjectId: 'u-bad' }), roles: [] }, // invalid: empty roles
        ]),
      ).rejects.toThrow();
      // Nothing should have been written
      expect(await adapter.getGrantsForSubject('u-good')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // listGrantsOnResource pagination
  // ---------------------------------------------------------------------------

  describe('listGrantsOnResource — pagination', () => {
    test('limit restricts the number of results', async () => {
      for (let i = 1; i <= 5; i++) {
        await adapter.createGrant(
          makeGrant({ subjectId: `user-${i}`, resourceType: 'post', resourceId: 'p1' }),
        );
      }
      const page = await adapter.listGrantsOnResource('post', 'p1', undefined, 2);
      expect(page.length).toBe(2);
    });

    test('offset skips the first N results', async () => {
      for (let i = 1; i <= 5; i++) {
        await adapter.createGrant(
          makeGrant({ subjectId: `user-${i}`, resourceType: 'post', resourceId: 'p1' }),
        );
      }
      const all = await adapter.listGrantsOnResource('post', 'p1');
      const paged = await adapter.listGrantsOnResource('post', 'p1', undefined, undefined, 2);
      expect(paged.length).toBe(3);
      expect(paged[0].subjectId).toBe(all[2].subjectId);
    });

    test('limit + offset return a page window', async () => {
      for (let i = 1; i <= 5; i++) {
        await adapter.createGrant(
          makeGrant({ subjectId: `user-${i}`, resourceType: 'post', resourceId: 'p1' }),
        );
      }
      const page1 = await adapter.listGrantsOnResource('post', 'p1', undefined, 2, 0);
      const page2 = await adapter.listGrantsOnResource('post', 'p1', undefined, 2, 2);
      const page3 = await adapter.listGrantsOnResource('post', 'p1', undefined, 2, 4);
      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
      expect(page3.length).toBe(1);
      const ids = [...page1, ...page2, ...page3].map(g => g.subjectId);
      expect(new Set(ids).size).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // revokeGrant with revokedReason
  // ---------------------------------------------------------------------------

  describe('revokeGrant — revokedReason', () => {
    test('stores revokedReason and returns it in listGrantHistory', async () => {
      const id = await adapter.createGrant(makeGrant());
      await adapter.revokeGrant(id, 'admin-1', undefined, 'account suspended');
      const history = await adapter.listGrantHistory('user-1', 'user');
      expect(history[0].revokedReason).toBe('account suspended');
      expect(history[0].revokedBy).toBe('admin-1');
    });

    test('revokedReason is undefined when not provided', async () => {
      const id = await adapter.createGrant(makeGrant());
      await adapter.revokeGrant(id, 'admin-1');
      const history = await adapter.listGrantHistory('user-1', 'user');
      expect(history[0].revokedReason).toBeUndefined();
    });

    test('throws when revokedReason exceeds 1024 characters', async () => {
      const id = await adapter.createGrant(makeGrant());
      await expect(adapter.revokeGrant(id, 'admin-1', undefined, 'x'.repeat(1025))).rejects.toThrow(
        'revokedReason exceeds maximum length of 1024',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // parseRoles error branches
  // ---------------------------------------------------------------------------

  describe('parseRoles validation', () => {
    test('throws when roles column is not a JSON array', async () => {
      await adapter.createGrant(makeGrant());
      // Corrupt the roles column directly in SQLite
      db.run('UPDATE permission_grants SET roles = ?', ['"not-an-array"']);
      await expect(adapter.getGrantsForSubject('user-1')).rejects.toThrow(
        'roles must be a JSON-encoded string array',
      );
    });

    test('throws when roles array contains non-string elements', async () => {
      await adapter.createGrant(makeGrant());
      // Corrupt the roles column with an array of numbers
      db.run('UPDATE permission_grants SET roles = ?', ['[1, 2, 3]']);
      await expect(adapter.getGrantsForSubject('user-1')).rejects.toThrow(
        'roles must be a JSON-encoded string array',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  describe('clear', () => {
    test('removes all grants', async () => {
      await adapter.createGrant(makeGrant());
      await adapter.createGrant(makeGrant({ subjectId: 'user-2' }));
      adapter.clear();
      const grants1 = await adapter.getGrantsForSubject('user-1');
      const grants2 = await adapter.getGrantsForSubject('user-2');
      expect(grants1.length).toBe(0);
      expect(grants2.length).toBe(0);
    });
  });
});
