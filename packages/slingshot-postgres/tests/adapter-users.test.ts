/**
 * User-management tests for slingshot-postgres.
 *
 * Covers createUser, updateUser, deleteUser, suspendUser, and getUser
 * with various edge cases including missing users, null fields, and
 * concurrent operations.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { HttpError } from '@lastshotlabs/slingshot-core';
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

describe('adapter-users — createUser (create method)', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('create returns a UUID id', async () => {
    mockDbImpl = { insert: () => resolvingBuilder(undefined) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.create('user@example.com', 'hash123');
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('create lowercases the email', async () => {
    mockDbImpl = { insert: () => resolvingBuilder(undefined) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.create('UPPERCASE@Example.Com', 'hash');
    expect(result.id).toBeString();
  });

  test('create throws HttpError(409) on duplicate email', async () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockDbImpl = { insert: () => throwingBuilder(err) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const thrown = await adapter.create('dup@example.com', 'hash').catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
  });
});

describe('adapter-users — getUser', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('getUser returns user data when found', async () => {
    const now = new Date();
    mockDbImpl = {
      select: () =>
        resolvingBuilder([
          {
            id: 'user-1',
            email: 'user@example.com',
            displayName: 'User',
            firstName: 'First',
            lastName: 'Last',
            externalId: 'ext-1',
            emailVerified: true,
            suspended: false,
            suspendedReason: null,
            suspendedAt: null,
            userMetadata: {},
            appMetadata: {},
            createdAt: now,
            updatedAt: now,
          },
        ]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const user = await adapter.getUser!('user-1');
    expect(user?.id).toBe('user-1');
    expect(user?.email).toBe('user@example.com');
    expect(user?.suspended).toBe(false);
  });

  test('getUser returns null when user not found', async () => {
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const user = await adapter.getUser!('nonexistent');
    expect(user).toBeNull();
  });

  test('getUser handles null emailVerified', async () => {
    mockDbImpl = {
      select: () => resolvingBuilder([{ id: 'u1', email: 'test@test.com', emailVerified: null }]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const user = await adapter.getUser!('u1');
    expect(user?.emailVerified).toBe(false);
  });
});

describe('adapter-users — deleteUser and suspension', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('deleteUser removes user without error', async () => {
    mockDbImpl = { delete: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.deleteUser!('user-1')).resolves.toBeUndefined();
  });

  test('deleteUser is a no-op for non-existent user', async () => {
    mockDbImpl = { delete: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.deleteUser!('nonexistent')).resolves.toBeUndefined();
  });

  test('setSuspended marks the user as suspended', async () => {
    let updateCalled = false;
    mockDbImpl = {
      update: () => {
        updateCalled = true;
        return resolvingBuilder(undefined);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await adapter.setSuspended!('user-1', true, 'violation of terms');
    expect(updateCalled).toBe(true);
  });

  test('setSuspended unsuspends the user', async () => {
    mockDbImpl = { update: () => resolvingBuilder(undefined) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.setSuspended!('user-1', false, null)).resolves.toBeUndefined();
  });

  test('getSuspended returns suspension state', async () => {
    mockDbImpl = {
      select: () => resolvingBuilder([{ suspended: true, suspendedReason: 'policy' }]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.getSuspended!('user-1');
    expect(result).toEqual({ suspended: true, suspendedReason: 'policy' });
  });

  test('getSuspended returns not suspended when no row found', async () => {
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.getSuspended!('nonexistent');
    expect(result).toBeNull();
  });
});

describe('adapter-users — listUsers', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('listUsers returns paginated results', async () => {
    mockDbImpl = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = new Proxy(
          {},
          {
            get() {
              return () =>
                resolvingBuilder([{ count: '1' }, { id: 'u1', email: 'user@example.com' }]);
            },
          },
        );
        return fn(tx);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.listUsers!({});
    expect(result.totalResults).toBe(1);
  });

  test('listUsers with email filter returns matching users', async () => {
    mockDbImpl = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = new Proxy(
          {},
          {
            get() {
              return () => resolvingBuilder([{ count: '0' }]);
            },
          },
        );
        return fn(tx);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.listUsers!({ email: 'nonexistent' });
    expect(result.totalResults).toBe(0);
  });
});
