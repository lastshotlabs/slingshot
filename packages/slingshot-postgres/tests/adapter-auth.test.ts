/**
 * Auth-adapter tests for slingshot-postgres.
 *
 * Covers auth-specific adapter methods: findOrCreateByProvider,
 * setPassword, verifyPassword, consumeRecoveryCode, and related
 * edge cases not covered in existing test files.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

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
import { HttpError } from '@lastshotlabs/slingshot-core';

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

describe('adapter-auth — findOrCreateByProvider', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('creates new user when no OAuth account and no email conflict exist', async () => {
    let callCount = 0;
    mockDbImpl = {
      select: () => {
        callCount++;
        if (callCount <= 2) return resolvingBuilder([]);
        return resolvingBuilder([{ role: 'admin' }]);
      },
      insert: () => resolvingBuilder(undefined),
      update: () => resolvingBuilder(undefined),
      delete: () => resolvingBuilder([]),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(makeTransactionMock()),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.findOrCreateByProvider!('github', 'gh-123', {
      email: 'newuser@example.com',
      displayName: 'New User',
    });
    expect(result.created).toBe(true);
    expect(result).toHaveProperty('id');
  });

  test('returns existing user when OAuth account already linked', async () => {
    mockDbImpl = { select: () => resolvingBuilder([{ userId: 'existing-id' }]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.findOrCreateByProvider!('google', 'g-456', {
      email: 'existing@example.com',
    });
    expect(result).toEqual({ id: 'existing-id', created: false });
  });

  test('throws HttpError(409) when email conflicts with existing user', async () => {
    let callCount = 0;
    mockDbImpl = {
      select: () => {
        callCount++;
        if (callCount === 1) return resolvingBuilder([]);
        return resolvingBuilder([{ id: 'existing-user' }]);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const thrown = await adapter.findOrCreateByProvider!('google', 'g-789', {
      email: 'conflict@example.com',
    }).catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
  });

  test('throws HttpError(409) when no email provided and OAuth not found', async () => {
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(
      adapter.findOrCreateByProvider!('github', 'gh-no-email', {}),
    ).rejects.toThrow(/email/i);
  });
});

describe('adapter-auth — setPassword and verifyPassword', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('setPassword updates the password hash', async () => {
    let updateCalled = false;
    mockDbImpl = { update: () => {
      updateCalled = true;
      return resolvingBuilder(undefined);
    }};
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await adapter.setPassword!('user-id', '$2b$10$newhashvalue');
    expect(updateCalled).toBe(true);
  });

  test('verifyPassword returns true for matching hash', async () => {
    const hash = await Bun.password.hash('correct-password');
    mockDbImpl = { select: () => resolvingBuilder([{ passwordHash: hash }]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.verifyPassword('user-id', 'correct-password');
    expect(result).toBe(true);
  });

  test('verifyPassword returns false for wrong password', async () => {
    const hash = await Bun.password.hash('correct-password');
    mockDbImpl = { select: () => resolvingBuilder([{ passwordHash: hash }]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.verifyPassword('user-id', 'wrong-password');
    expect(result).toBe(false);
  });

  test('verifyPassword returns false when user has no password hash', async () => {
    mockDbImpl = { select: () => resolvingBuilder([{ passwordHash: null }]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.verifyPassword('user-id', 'any-password');
    expect(result).toBe(false);
  });

  test('verifyPassword returns false for missing user', async () => {
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.verifyPassword('nonexistent', 'password');
    expect(result).toBe(false);
  });
});

describe('adapter-auth — consumeRecoveryCode', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('consumeRecoveryCode returns true when code is found and deleted', async () => {
    mockDbImpl = { delete: () => resolvingBuilder([{ codeHash: 'found-hash' }]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.consumeRecoveryCode('user-id', 'found-hash');
    expect(result).toBe(true);
  });

  test('consumeRecoveryCode returns false when code is not found', async () => {
    mockDbImpl = { delete: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.consumeRecoveryCode('user-id', 'missing-hash');
    expect(result).toBe(false);
  });
});
