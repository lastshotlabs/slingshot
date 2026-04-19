import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PermissionGrant } from '@lastshotlabs/slingshot-core';
import { createMongoPermissionsAdapter } from '../../src/adapters/mongo';
import type {
  CascadeLevel,
  GrantDoc,
  GrantFilter,
  GrantQuery,
  GrantsModel,
  MongoConnectionLike,
} from '../../src/adapters/mongo';

// ---------------------------------------------------------------------------
// Mock mongoose before importing the adapter.
// The adapter calls `new Schema(...)` at module scope, so the mock must be in
// place before the import is resolved. Bun hoists mock.module calls.
// ---------------------------------------------------------------------------

mock.module('mongoose', () => {
  class MockSchema {
    index() {
      return this;
    }
  }
  return { Schema: MockSchema };
});

// ---------------------------------------------------------------------------
// In-memory model mock
// ---------------------------------------------------------------------------

function matchesFilter(doc: GrantDoc, filter: GrantQuery): boolean {
  if (filter._id !== undefined && doc._id !== filter._id) return false;
  if (filter.subjectId !== undefined && doc.subjectId !== filter.subjectId) return false;
  if (filter.subjectType !== undefined && doc.subjectType !== filter.subjectType) return false;
  if (filter.tenantId !== undefined) {
    if (filter.tenantId === null) {
      if (doc.tenantId !== null) return false;
    } else {
      if (doc.tenantId !== filter.tenantId) return false;
    }
  }
  if (filter.resourceType !== undefined && doc.resourceType !== filter.resourceType) return false;
  if (filter.resourceId !== undefined && doc.resourceId !== filter.resourceId) return false;
  if (filter.revokedAt !== undefined && doc.revokedAt !== null) return false;
  if (filter.$or !== undefined) {
    const satisfies = filter.$or.some(cond => {
      if (cond.expiresAt === null) return doc.expiresAt === null;
      return doc.expiresAt !== null && doc.expiresAt > cond.expiresAt.$gt;
    });
    if (!satisfies) return false;
  }
  if (filter.$and !== undefined) {
    for (const clause of filter.$and) {
      const satisfies = clause.$or.some(
        (level: CascadeLevel) =>
          doc.tenantId === level.tenantId &&
          doc.resourceType === level.resourceType &&
          doc.resourceId === level.resourceId,
      );
      if (!satisfies) return false;
    }
  }
  return true;
}

function createMockConnection(): { conn: MongoConnectionLike; store: Map<string, GrantDoc> } {
  const store = new Map<string, GrantDoc>();

  const Grant: GrantsModel = {
    async create(doc: GrantDoc): Promise<{ _id: string }> {
      store.set(doc._id, { ...doc });
      return { _id: doc._id };
    },

    async findOneAndUpdate(
      filter: GrantFilter,
      update: { $set: Partial<GrantDoc> },
      opts: { new: boolean },
    ): Promise<GrantDoc | null> {
      for (const [, doc] of store) {
        if (matchesFilter(doc, filter)) {
          const original: GrantDoc = { ...doc };
          if (update.$set) Object.assign(doc, update.$set);
          return opts.new === false ? original : doc;
        }
      }
      return null;
    },

    find(filter: GrantQuery) {
      return {
        async lean(): Promise<GrantDoc[]> {
          return Array.from(store.values()).filter(doc => matchesFilter(doc, filter));
        },
      };
    },

    async deleteMany(filter: GrantQuery): Promise<{ deletedCount: number }> {
      const toDelete: string[] = [];
      for (const [id, doc] of store) {
        if (matchesFilter(doc, filter)) toDelete.push(id);
      }
      for (const id of toDelete) store.delete(id);
      return { deletedCount: toDelete.length };
    },
  };

  const conn: MongoConnectionLike = {
    model: () => Grant,
  };

  return { conn, store };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Mongo permissions adapter — createGrant', () => {
  let conn: MongoConnectionLike;
  let store: Map<string, GrantDoc>;
  let adapter: ReturnType<typeof createMongoPermissionsAdapter>;

  beforeEach(() => {
    ({ conn, store } = createMockConnection());
    adapter = createMongoPermissionsAdapter(conn);
  });

  test('returns a UUID (not an ObjectId hex string)', async () => {
    const id = await adapter.createGrant(baseGrant());
    // UUID format: 8-4-4-4-12 hex chars
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('stored _id matches returned id', async () => {
    const id = await adapter.createGrant(baseGrant());
    expect(store.has(id)).toBe(true);
    expect(store.get(id)!._id).toBe(id);
  });

  test('validation rejects empty roles', async () => {
    await expect(adapter.createGrant(baseGrant({ roles: [] }))).rejects.toThrow(
      'at least one role',
    );
  });

  test('validation rejects resourceId without resourceType', async () => {
    await expect(
      adapter.createGrant(baseGrant({ resourceId: 'res-1', resourceType: null })),
    ).rejects.toThrow('resourceId requires resourceType');
  });
});

describe('Mongo permissions adapter — revokeGrant', () => {
  let conn: MongoConnectionLike;
  let adapter: ReturnType<typeof createMongoPermissionsAdapter>;

  beforeEach(() => {
    ({ conn } = createMockConnection());
    adapter = createMongoPermissionsAdapter(conn);
  });

  test('returns true and revoked grant is no longer returned', async () => {
    const id = await adapter.createGrant(baseGrant());
    const result = await adapter.revokeGrant(id, 'admin-user');
    expect(result).toBe(true);

    // Option A: revoked grants are filtered at the query level
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(0);
  });

  test('returns false for non-existent grant', async () => {
    const result = await adapter.revokeGrant('nonexistent-uuid', 'admin');
    expect(result).toBe(false);
  });

  test('returns false for already-revoked grant', async () => {
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin-1');
    const result = await adapter.revokeGrant(id, 'admin-2');
    expect(result).toBe(false);
  });

  test('tenantScope restricts revocation to matching tenant', async () => {
    const id = await adapter.createGrant(baseGrant({ tenantId: 'tenant-a' }));
    const wrongTenant = await adapter.revokeGrant(id, 'admin', 'tenant-b');
    expect(wrongTenant).toBe(false);
    const rightTenant = await adapter.revokeGrant(id, 'admin', 'tenant-a');
    expect(rightTenant).toBe(true);
  });
});

describe('Mongo permissions adapter — getGrantsForSubject', () => {
  let conn: MongoConnectionLike;
  let adapter: ReturnType<typeof createMongoPermissionsAdapter>;

  beforeEach(() => {
    ({ conn } = createMockConnection());
    adapter = createMongoPermissionsAdapter(conn);
  });

  test('filters by subjectId', async () => {
    await adapter.createGrant(baseGrant({ subjectId: 'user-1' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-2' }));
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(1);
    expect(grants[0].subjectId).toBe('user-1');
  });

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

  test('returns empty array for unknown subject', async () => {
    const grants = await adapter.getGrantsForSubject('nobody');
    expect(grants).toEqual([]);
  });
});

describe('Mongo permissions adapter — listGrantsOnResource', () => {
  let conn: MongoConnectionLike;
  let adapter: ReturnType<typeof createMongoPermissionsAdapter>;

  beforeEach(() => {
    ({ conn } = createMockConnection());
    adapter = createMongoPermissionsAdapter(conn);
  });

  test('returns grants for a specific resource', async () => {
    await adapter.createGrant(baseGrant({ resourceType: 'post', resourceId: 'post-1' }));
    await adapter.createGrant(
      baseGrant({ subjectId: 'user-2', resourceType: 'post', resourceId: 'post-1' }),
    );
    await adapter.createGrant(baseGrant({ resourceType: 'post', resourceId: 'post-2' }));
    const grants = await adapter.listGrantsOnResource('post', 'post-1');
    expect(grants).toHaveLength(2);
    expect(grants.every(g => g.resourceId === 'post-1')).toBe(true);
  });

  test('null tenantId filters to global grants only', async () => {
    await adapter.createGrant(
      baseGrant({ resourceType: 'post', resourceId: 'post-1', tenantId: null }),
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

  test('string tenantId scopes to that tenant', async () => {
    await adapter.createGrant(
      baseGrant({ resourceType: 'post', resourceId: 'post-1', tenantId: 'tenant-a' }),
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
});

describe('Mongo permissions adapter — expiry filtering', () => {
  test('getGrantsForSubject excludes expired grants', async () => {
    const { conn, store } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);

    await adapter.createGrant(
      baseGrant({ roles: ['active'], expiresAt: new Date(Date.now() + 86_400_000) }),
    );
    // Directly insert an expired doc into the store, bypassing createGrant validation
    const expiredId = 'expired-id';
    store.set(expiredId, {
      _id: expiredId,
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['expired-role'],
      effect: 'allow',
      grantedBy: 'system',
      grantedAt: new Date(),
      reason: null,
      expiresAt: new Date(Date.now() - 10_000),
      revokedBy: null,
      revokedAt: null,
    });

    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(1);
    expect(grants[0].roles).toEqual(['active']);
  });

  test('non-expiring grants are always returned', async () => {
    const { conn } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);
    await adapter.createGrant(baseGrant()); // no expiresAt
    const grants = await adapter.getGrantsForSubject('user-1');
    expect(grants).toHaveLength(1);
  });
});

describe('Mongo permissions adapter — deleteAllGrantsForSubject', () => {
  test('hard-deletes all grants for a subject by subjectType', async () => {
    const { conn } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);

    await adapter.createGrant(baseGrant({ subjectType: 'user' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'group' }));

    await adapter.deleteAllGrantsForSubject({ subjectId: 'user-1', subjectType: 'user' });
    const remaining = await adapter.getGrantsForSubject('user-1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].subjectType).toBe('group');
  });
});

describe('Mongo permissions adapter — clear', () => {
  test('removes all grants', async () => {
    const { conn } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);

    await adapter.createGrant(baseGrant());
    await adapter.createGrant(baseGrant({ subjectId: 'user-2' }));
    await adapter.clear();

    expect(await adapter.getGrantsForSubject('user-1')).toHaveLength(0);
    expect(await adapter.getGrantsForSubject('user-2')).toHaveLength(0);
  });
});

describe('Mongo permissions adapter — listGrantHistory', () => {
  test('includes revoked grants', async () => {
    const { conn } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin-1');
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history).toHaveLength(1);
    expect(history[0].revokedBy).toBe('admin-1');
    expect(history[0].revokedAt).toBeInstanceOf(Date);
  });

  test('includes expired grants', async () => {
    const { conn, store } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);
    const expiredId = 'expired-hist';
    store.set(expiredId, {
      _id: expiredId,
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['viewer'],
      effect: 'allow',
      grantedBy: 'system',
      grantedAt: new Date(),
      reason: null,
      expiresAt: new Date(Date.now() - 10_000),
      revokedBy: null,
      revokedAt: null,
    });
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history).toHaveLength(1);
    expect(history[0].roles).toEqual(['viewer']);
  });

  test('scopes to the given subjectId + subjectType', async () => {
    const { conn } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'user' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-2', subjectType: 'user' }));
    await adapter.createGrant(baseGrant({ subjectId: 'user-1', subjectType: 'group' }));
    const history = await adapter.listGrantHistory('user-1', 'user');
    expect(history).toHaveLength(1);
    expect(history[0].subjectId).toBe('user-1');
    expect(history[0].subjectType).toBe('user');
  });
});

describe('Mongo permissions adapter — getEffectiveGrantsForSubject', () => {
  test('returns global grant with no scope', async () => {
    const { conn } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);
    await adapter.createGrant(baseGrant({ tenantId: null, resourceType: null, resourceId: null }));
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(1);
  });

  test('excludes tenant-scoped grant when no scope provided', async () => {
    const { conn } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);
    await adapter.createGrant(baseGrant({ tenantId: 'tenant-a' }));
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(0);
  });

  test('returns global + tenant-wide grants for tenant scope', async () => {
    const { conn } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);
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

  test('cascade level 2: resource-type-wide grant applies when evaluating specific resource', async () => {
    const { conn } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);
    await adapter.createGrant(
      baseGrant({
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
    const { conn } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);
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

  test('revoked grants are excluded', async () => {
    const { conn } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);
    const id = await adapter.createGrant(baseGrant());
    await adapter.revokeGrant(id, 'admin');
    const grants = await adapter.getEffectiveGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(0);
  });
});

describe('Mongo permissions adapter — grant ID format', () => {
  test('grant IDs are UUID strings consistent with other adapters', async () => {
    const { conn } = createMockConnection();
    const adapter = createMongoPermissionsAdapter(conn);

    const id1 = await adapter.createGrant(baseGrant());
    const id2 = await adapter.createGrant(baseGrant({ subjectId: 'user-2' }));

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(id1).toMatch(uuidPattern);
    expect(id2).toMatch(uuidPattern);
    expect(id1).not.toBe(id2);
  });
});
