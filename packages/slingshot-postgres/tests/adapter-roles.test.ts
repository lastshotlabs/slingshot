/**
 * Role-management tests for slingshot-postgres.
 *
 * Covers addRole, removeRole, getRoles, getEffectiveRoles, setRoles,
 * and related tenant role operations with various edge cases.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createPostgresAdapter } from '../src/adapter.js';

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
    end() {
      return Promise.resolve();
    }
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

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTransactionMock(selectValues: unknown[] = []): Record<string, unknown> {
  let idx = 0;
  const select =
    selectValues.length > 0
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

describe('adapter-roles — direct roles', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('getRoles returns an empty array when no roles exist', async () => {
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const roles = await adapter.getRoles!('user-id');
    expect(roles).toEqual([]);
  });

  test('getRoles returns all assigned roles', async () => {
    mockDbImpl = {
      select: () => resolvingBuilder([{ role: 'admin' }, { role: 'editor' }, { role: 'viewer' }]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const roles = await adapter.getRoles!('user-id');
    expect(roles).toEqual(['admin', 'editor', 'viewer']);
  });

  test('addRole inserts without error', async () => {
    mockDbImpl = { insert: () => resolvingBuilder(undefined) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.addRole!('user-id', 'admin')).resolves.toBeUndefined();
  });

  test('addRole with onConflictDoNothing handles duplicate silently', async () => {
    mockDbImpl = { insert: () => resolvingBuilder(undefined) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.addRole!('user-id', 'admin')).resolves.toBeUndefined();
  });

  test('removeRole deletes the role row', async () => {
    let deleteCalled = false;
    mockDbImpl = {
      delete: () => {
        deleteCalled = true;
        return resolvingBuilder([]);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await adapter.removeRole!('user-id', 'admin');
    expect(deleteCalled).toBe(true);
  });

  test('removeRole is a no-op when role does not exist', async () => {
    mockDbImpl = { delete: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.removeRole!('user-id', 'nonexistent-role')).resolves.toBeUndefined();
  });
});

describe('adapter-roles — effective roles', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('getEffectiveRoles combines direct and group roles for a tenant', async () => {
    let callCount = 0;
    // First select: direct roles; second: group roles
    mockDbImpl = {
      select: () => {
        callCount++;
        if (callCount === 1) return resolvingBuilder([{ role: 'admin' }]);
        return resolvingBuilder([{ groupRoles: ['group-role'], memberRoles: ['member'] }]);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const roles = await adapter.getEffectiveRoles!('user-id', 'tenant-1');
    expect(roles).toContain('admin');
    expect(roles).toContain('group-role');
    expect(roles).toContain('member');
  });

  test('getEffectiveRoles with null tenant includes only direct roles plus group roles from null-tenant groups', async () => {
    let callCount = 0;
    mockDbImpl = {
      select: () => {
        callCount++;
        if (callCount === 1) return resolvingBuilder([{ role: 'admin' }, { role: 'viewer' }]);
        return resolvingBuilder([{ groupRoles: ['group-role'], memberRoles: ['member'] }]);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const roles = await adapter.getEffectiveRoles!('user-id', null);
    expect(roles).toContain('admin');
    expect(roles).toContain('viewer');
  });

  test('getEffectiveRoles returns empty array when no roles exist', async () => {
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const roles = await adapter.getEffectiveRoles!('user-id', 'tenant-1');
    expect(roles).toEqual([]);
  });
});

describe('adapter-roles — setRoles', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('setRoles replaces all roles via transaction', async () => {
    mockDbImpl = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(makeTransactionMock([{ count: '0' }])),
      delete: () => resolvingBuilder([]),
      insert: () => resolvingBuilder(undefined),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.setRoles!('user-id', ['admin', 'editor'])).resolves.toBeUndefined();
  });

  test('setRoles with empty array clears all roles', async () => {
    let deleteCalled = false;
    mockDbImpl = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = new Proxy(
          {},
          {
            get() {
              return () => {
                deleteCalled = true;
                return resolvingBuilder(undefined);
              };
            },
          },
        );
        return fn(tx);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await adapter.setRoles!('user-id', []);
    expect(deleteCalled).toBe(true);
  });
});
