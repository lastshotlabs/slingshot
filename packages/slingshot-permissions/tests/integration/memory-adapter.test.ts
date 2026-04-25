import { beforeEach, describe, expect, test } from 'bun:test';
import type { PermissionGrant } from '@lastshotlabs/slingshot-core';
import { createMemoryPermissionsAdapter } from '../../src/adapters/memory';

function baseGrant(
  overrides?: Partial<Omit<PermissionGrant, 'id' | 'grantedAt'>>,
): Omit<PermissionGrant, 'id' | 'grantedAt'> {
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

describe('MemoryPermissionsAdapter', () => {
  let adapter: ReturnType<typeof createMemoryPermissionsAdapter>;

  beforeEach(() => {
    adapter = createMemoryPermissionsAdapter();
  });

  test('createGrant returns a UUID', async () => {
    const id = await adapter.createGrant(baseGrant());
    expect(id).toBeString();
    expect(id.length).toBeGreaterThan(0);
  });

  test('revokeGrant returns true and revoked grant is no longer returned', async () => {
    const id = await adapter.createGrant(baseGrant());
    const result = await adapter.revokeGrant(id, 'admin-user');
    expect(result).toBe(true);

    // Option A: revoked grants are filtered out
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(0);
  });

  test('getGrantsForSubject filters by subjectId', async () => {
    await adapter.createGrant(baseGrant({ subjectId: 'user-1' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-2' }));
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(1);
    expect(grants[0].subjectId).toBe('user-1');
  });

  test('getGrantsForSubject filters by subjectType', async () => {
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'user' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'group' }));
    const grants = await adapter.getGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(1);
    expect(grants[0].subjectType).toBe('user');
  });

  test('getGrantsForSubject scope filtering by tenantId', async () => {
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-a' }));
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-b' }));
    const grants = await adapter.getGrantsForSubject('user-1', undefined, { tenantId: 'tenant-a' });
    expect(grants).toHaveLength(1);
    expect(grants[0].tenantId).toBe('tenant-a');
  });

  test('getGrantsForSubject scope filtering by resourceType', async () => {
    await adapter.createGrant(baseGrant({ resourceType: 'post', resourceId: 'post-1' }));
    await adapter.createGrant(baseGrant({ resourceType: 'comment', resourceId: 'comment-1' }));
    const grants = await adapter.getGrantsForSubject('user-1', undefined, { resourceType: 'post' });
    expect(grants).toHaveLength(1);
    expect(grants[0].resourceType).toBe('post');
  });

  test('deleteAllGrantsForSubject hard-deletes all matching entries', async () => {
    await adapter.createGrant(baseGrant({ subjectId: 'user-1' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-1' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-2' }));
    await adapter.deleteAllGrantsForSubject({ subjectId: 'user-1', subjectType: 'user' });
    const remaining = await adapter.getGrantsForSubject('user-1');
    expect(remaining).toHaveLength(0);
    const user2Grants = await adapter.getGrantsForSubject('user-2');
    expect(user2Grants).toHaveLength(1);
  });

  test('listGrantsOnResource filters by resourceType + resourceId', async () => {
    await adapter.createGrant(
      baseGrant({ subjectId: 'user-1', resourceType: 'post', resourceId: 'post-1' }),
    );
    await adapter.createGrant(
      baseGrant({ subjectId: 'user-2', resourceType: 'post', resourceId: 'post-1' }),
    );
    await adapter.createGrant(
      baseGrant({ subjectId: 'user-3', resourceType: 'post', resourceId: 'post-2' }),
    );
    const grants = await adapter.listGrantsOnResource('post', 'post-1');
    expect(grants).toHaveLength(2);
    expect(grants.every(g => g.resourceId === 'post-1')).toBe(true);
  });

  test('listGrantsOnResource filters by optional tenantId', async () => {
    await adapter.createGrant(
      baseGrant({
        subjectId: 'user-1',
        resourceType: 'post',
        resourceId: 'post-1',
        tenantId: 'tenant-a',
      }),
    );
    await adapter.createGrant(
      baseGrant({
        subjectId: 'user-2',
        resourceType: 'post',
        resourceId: 'post-1',
        tenantId: 'tenant-b',
      }),
    );
    const grants = await adapter.listGrantsOnResource('post', 'post-1', 'tenant-a');
    expect(grants).toHaveLength(1);
    expect(grants[0].tenantId).toBe('tenant-a');
  });

  test('revokeGrant returns true when grant exists and was not previously revoked', async () => {
    const id = await adapter.createGrant(baseGrant());
    const result = await adapter.revokeGrant(id, 'admin-user');
    expect(result).toBe(true);
  });

  test('revokeGrant returns false for non-existent grantId', async () => {
    const result = await adapter.revokeGrant('nonexistent-id', 'admin-user');
    expect(result).toBe(false);
  });

  test('re-revoking already-revoked grant is no-op and returns false', async () => {
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin-1');
    const result = await adapter.revokeGrant(id, 'admin-2');
    expect(result).toBe(false);
  });

  test('listGrantHistory includes revoked grants', async () => {
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin-1');
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history).toHaveLength(1);
    expect(history[0].revokedBy).toBe('admin-1');
    expect(history[0].revokedAt).toBeInstanceOf(Date);
  });

  test('listGrantHistory scopes to subjectId + subjectType', async () => {
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'user' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-2', subjectType: 'user' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'group' }));
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history).toHaveLength(1);
    expect(history[0].subjectId).toBe('user-1');
    expect(history[0].subjectType).toBe('user');
  });

  test('getEffectiveGrantsForSubject returns global grant with no scope', async () => {
    await adapter.createGrant(baseGrant({ tenantId: null, resourceType: null, resourceId: null }));
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(1);
  });

  test('getEffectiveGrantsForSubject excludes tenant-scoped grant when no scope provided', async () => {
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-a' }));
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(0);
  });

  test('getEffectiveGrantsForSubject returns global + tenant-wide grants for tenant scope', async () => {
    await adapter.createGrant(baseGrant({ tenantId: null, roles: ['global'] }));
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-a', roles: ['tenant'] }));
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-b', roles: ['other'] }));
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user', {
      tenantId: 'tenant-a',
    });
    expect(grants).toHaveLength(2);
    const roleSet = new Set(grants.flatMap(g => g.roles));
    expect(roleSet.has('global')).toBe(true);
    expect(roleSet.has('tenant')).toBe(true);
    expect(roleSet.has('other')).toBe(false);
  });

  test('getEffectiveGrantsForSubject cascade level 1: specific resource grant does not cover other resources', async () => {
    await adapter.createGrant(
      baseGrant({
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

  test('clear removes all grants', async () => {
    await adapter.createGrant(baseGrant({ subjectId: 'user-1' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-2' }));
    await adapter.clear();
    const user1 = await adapter.getGrantsForSubject('user-1');
    const user2 = await adapter.getGrantsForSubject('user-2');
    expect(user1).toHaveLength(0);
    expect(user2).toHaveLength(0);
  });

  test('deleteAllGrantsOnResource removes all grants on the specified resource', async () => {
    await adapter.createGrant(
      baseGrant({ subjectId: 'user-1', resourceType: 'doc', resourceId: 'doc-1' }),
    );
    await adapter.createGrant(
      baseGrant({ subjectId: 'user-2', resourceType: 'doc', resourceId: 'doc-1' }),
    );
    await adapter.createGrant(
      baseGrant({ subjectId: 'user-3', resourceType: 'doc', resourceId: 'doc-2' }),
    );
    await adapter.deleteAllGrantsOnResource('doc', 'doc-1');
    const doc1 = await adapter.listGrantsOnResource('doc', 'doc-1');
    expect(doc1).toHaveLength(0);
    const doc2 = await adapter.listGrantsOnResource('doc', 'doc-2');
    expect(doc2).toHaveLength(1);
  });

  test('deleteAllGrantsOnResource with tenantId scopes removal to matching tenant', async () => {
    await adapter.createGrant(
      baseGrant({ resourceType: 'doc', resourceId: 'doc-1', tenantId: 'tenant-a' }),
    );
    await adapter.createGrant(
      baseGrant({ resourceType: 'doc', resourceId: 'doc-1', tenantId: 'tenant-b' }),
    );
    await adapter.deleteAllGrantsOnResource('doc', 'doc-1', 'tenant-a');
    const remaining = await adapter.listGrantsOnResource('doc', 'doc-1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tenantId).toBe('tenant-b');
  });

  test('deleteAllGrantsOnResource with tenantId=null removes only global grants on that resource', async () => {
    await adapter.createGrant(
      baseGrant({ resourceType: 'doc', resourceId: 'doc-1', tenantId: null }),
    );
    await adapter.createGrant(
      baseGrant({ resourceType: 'doc', resourceId: 'doc-1', tenantId: 'tenant-a' }),
    );
    await adapter.deleteAllGrantsOnResource('doc', 'doc-1', null);
    const remaining = await adapter.listGrantsOnResource('doc', 'doc-1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tenantId).toBe('tenant-a');
  });

  test('listGrantsOnResource respects limit and offset', async () => {
    for (let i = 1; i <= 5; i++) {
      await adapter.createGrant(
        baseGrant({ subjectId: `user-${i}`, resourceType: 'post', resourceId: 'post-1' }),
      );
    }
    const page1 = await adapter.listGrantsOnResource('post', 'post-1', undefined, 2, 0);
    expect(page1).toHaveLength(2);
    const page2 = await adapter.listGrantsOnResource('post', 'post-1', undefined, 2, 2);
    expect(page2).toHaveLength(2);
    const page3 = await adapter.listGrantsOnResource('post', 'post-1', undefined, 2, 4);
    expect(page3).toHaveLength(1);
    const allIds = [...page1, ...page2, ...page3].map(g => g.subjectId);
    expect(new Set(allIds).size).toBe(5);
  });

  test('revokeGrant stores revokedReason and it is returned in grant history', async () => {
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin-1', undefined, 'violated ToS');
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history[0].revokedReason).toBe('violated ToS');
  });

  test('createGrants creates all grants atomically and returns IDs in order', async () => {
    const inputs = [
      baseGrant({ subjectId: 'user-a', roles: ['admin'] }),
      baseGrant({ subjectId: 'user-b', roles: ['reader'] }),
      baseGrant({ subjectId: 'user-c', roles: ['editor'] }),
    ];
    const ids = await adapter.createGrants(inputs);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    const grantsA = await adapter.getGrantsForSubject('user-a');
    expect(grantsA).toHaveLength(1);
    expect(grantsA[0].roles).toEqual(['admin']);
    const grantsC = await adapter.getGrantsForSubject('user-c');
    expect(grantsC[0].roles).toEqual(['editor']);
  });

  test('createGrants validates all grants before writing — rejects on first invalid grant', async () => {
    const inputs = [
      baseGrant({ subjectId: 'user-a' }),
      { ...baseGrant({ subjectId: 'user-b' }), roles: [] }, // invalid: empty roles
    ];
    await expect(adapter.createGrants(inputs)).rejects.toThrow();
    // No grants should have been written
    const grantsA = await adapter.getGrantsForSubject('user-a');
    expect(grantsA).toHaveLength(0);
  });

  test('listGrantsOnResource with tenantId=null returns only global grants', async () => {
    await adapter.createGrant(
      baseGrant({
        subjectId: 'user-1',
        resourceType: 'post',
        resourceId: 'post-1',
        tenantId: null,
      }),
    );
    await adapter.createGrant(
      baseGrant({
        subjectId: 'user-2',
        resourceType: 'post',
        resourceId: 'post-1',
        tenantId: 'tenant-a',
      }),
    );
    const grants = await adapter.listGrantsOnResource('post', 'post-1', null);
    expect(grants).toHaveLength(1);
    expect(grants[0].tenantId).toBeNull();
  });
});
