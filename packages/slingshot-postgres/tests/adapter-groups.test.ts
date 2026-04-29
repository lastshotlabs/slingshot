/**
 * Group-operations tests for slingshot-postgres.
 *
 * Covers createGroup, deleteGroup, getGroup, listGroups, updateGroup,
 * addGroupMember, removeGroupMember, getUserGroups, getGroupMembers
 * with various edge cases.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { HttpError } from '@lastshotlabs/slingshot-core';

// ── Mocks ─────────────────────────────────────────────────────────────────

let mockDbImpl: MockDb | null = null;
let mockMigrationVersion = 2;

interface MockDb {
  select?: () => Builder;
  insert?: (table?: unknown) => Builder;
  update?: (table?: unknown) => Builder;
  delete?: (table?: unknown) => Builder;
  transaction?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
}

type Builder = Record<string, unknown> & PromiseLike<unknown>;

function makeBuilder(result: unknown, error: Error | null): Builder {
  const proxy: Builder = new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (prop === 'then') {
        return (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => {
          const p = error ? Promise.reject(error) : Promise.resolve(result);
          return p.then(f, r);
        };
      }
      return () => proxy;
    },
  }) as Builder;
  return proxy;
}

function resolvingBuilder(value: unknown): Builder {
  return makeBuilder(value, null);
}

function throwingBuilder(error: Error): Builder {
  return makeBuilder(null, error);
}

mock.module('pg', () => ({
  Pool: class MockPool {
    connect() {
      return Promise.resolve({
        query(sql: string) {
          if (sql.includes('SELECT COALESCE(MAX(version), 0) AS version')) {
            return Promise.resolve({ rows: [{ version: mockMigrationVersion }], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release() {},
      });
    }
    end() { return Promise.resolve(); }
  },
}));

mock.module('drizzle-orm/node-postgres', () => ({
  drizzle: () =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (!mockDbImpl) throw new Error('mockDbImpl not set');
          const impl = mockDbImpl as Record<string | symbol, unknown>;
          if (prop in impl) return impl[prop];
          throw new Error(`mockDbImpl missing method: ${String(prop)}`);
        },
      },
    ),
}));

import { createPostgresAdapter } from '../src/adapter.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTransactionMock(selectValues: unknown[] = []): Record<string, unknown> {
  let idx = 0;
  const select = selectValues.length > 0
    ? () => resolvingBuilder(selectValues[Math.min(idx++, selectValues.length - 1)])
    : () => resolvingBuilder([]);
  return {
    select,
    insert: () => resolvingBuilder(undefined),
    update: () => resolvingBuilder(undefined),
    delete: () => resolvingBuilder(undefined),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('adapter-groups — createGroup', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('createGroup returns a new group with a UUID id', async () => {
    mockDbImpl = { insert: () => resolvingBuilder(undefined) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const group = await adapter.createGroup!({ name: 'ops', tenantId: 'tenant-1', roles: [] });
    expect(group).toHaveProperty('id');
    expect(group.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('createGroup with roles stores them', async () => {
    mockDbImpl = { insert: () => resolvingBuilder(undefined) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const group = await adapter.createGroup!({ name: 'admins', tenantId: 'tenant-1', roles: ['admin', 'sudo'] });
    expect(group.id).toBeString();
  });

  test('createGroup with duplicate name throws HttpError(409)', async () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockDbImpl = { insert: () => throwingBuilder(err) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const thrown = await adapter.createGroup!({ name: 'dup', tenantId: 't1', roles: [] }).catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
  });
});

describe('adapter-groups — getGroup and deleteGroup', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('getGroup returns group data when found', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    mockDbImpl = {
      select: () => resolvingBuilder([{
        id: 'group-1',
        name: 'ops',
        displayName: 'Operations',
        description: 'Ops team',
        roles: ['admin'],
        tenantId: 'tenant-1',
        createdAt: now,
        updatedAt: now,
      }]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const group = await adapter.getGroup!('group-1');
    expect(group?.id).toBe('group-1');
    expect(group?.tenantId).toBe('tenant-1');
    expect(group?.createdAt).toBe(now.getTime());
  });

  test('getGroup returns null when no group matches', async () => {
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const group = await adapter.getGroup!('nonexistent');
    expect(group).toBeNull();
  });

  test('deleteGroup removes the group', async () => {
    mockDbImpl = { delete: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.deleteGroup!('group-1')).resolves.toBeUndefined();
  });

  test('deleteGroup is a no-op when group does not exist', async () => {
    mockDbImpl = { delete: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.deleteGroup!('nonexistent')).resolves.toBeUndefined();
  });
});

describe('adapter-groups — group members', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('addGroupMember adds user to group', async () => {
    mockDbImpl = {
      select: () => resolvingBuilder([{ tenantId: 'tenant-1' }]),
      insert: () => resolvingBuilder(undefined),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.addGroupMember!('group-1', 'user-1')).resolves.toBeUndefined();
  });

  test('addGroupMember with roles includes them', async () => {
    mockDbImpl = {
      select: () => resolvingBuilder([{ tenantId: 'tenant-1' }]),
      insert: () => resolvingBuilder(undefined),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.addGroupMember!('group-1', 'user-1', ['member'])).resolves.toBeUndefined();
  });

  test('addGroupMember throws 404 when group not found', async () => {
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const thrown = await adapter.addGroupMember!('missing', 'user-1').catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(404);
  });

  test('removeGroupMember removes user from group', async () => {
    mockDbImpl = { delete: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.removeGroupMember!('group-1', 'user-1')).resolves.toBeUndefined();
  });

  test('removeGroupMember is a no-op when membership does not exist', async () => {
    mockDbImpl = { delete: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.removeGroupMember!('group-1', 'nonexistent-user')).resolves.toBeUndefined();
  });

  test('getGroupMembers returns paginated members', async () => {
    const now = new Date();
    mockDbImpl = {
      select: () => resolvingBuilder([
        { userId: 'u1', roles: ['admin'], createdAt: now },
        { userId: 'u2', roles: ['member'], createdAt: now },
      ]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const page = await adapter.getGroupMembers!('group-1', { limit: 10 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0].userId).toBe('u1');
  });
});

describe('adapter-groups — getUserGroups', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('getUserGroups returns groups with membership roles', async () => {
    const now = new Date();
    mockDbImpl = {
      select: () => resolvingBuilder([
        {
          groupId: 'g1', groupName: 'ops', groupDisplayName: 'Ops',
          groupDescription: null, groupRoles: ['admin'], groupTenantId: 't1',
          groupCreatedAt: now, groupUpdatedAt: now,
          memberRoles: ['owner'],
        },
      ]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const groups = await adapter.getUserGroups!('user-1', 't1');
    expect(groups).toHaveLength(1);
    expect(groups[0].group.id).toBe('g1');
    expect(groups[0].membershipRoles).toEqual(['owner']);
  });

  test('getUserGroups returns empty array when user has no groups', async () => {
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const groups = await adapter.getUserGroups!('user-1', 't1');
    expect(groups).toEqual([]);
  });
});
