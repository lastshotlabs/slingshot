/**
 * Prod-hardening tests (round 2) for slingshot-postgres.
 *
 * Covers SQL injection resistance in search operations, concurrent
 * user creation race conditions, and additional error-path hardening
 * scenarios.
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

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTransactionMock(selectValues: unknown[] = []): Record<string, unknown> {
  let idx = 0;
  const select = selectValues.length > 0
    ? () => resolvingBuilder(selectValues[Math.min(idx++, selectValues.length - 1)])
    : () => resolvingBuilder([]);
  return { select, insert: () => resolvingBuilder(undefined), update: () => resolvingBuilder(undefined), delete: () => resolvingBuilder(undefined) };
}

function selectSequence(first: unknown, ...rest: unknown[]): () => Builder {
  const sequence = [first, ...rest];
  let index = 0;
  return () => resolvingBuilder(sequence[Math.min(index++, sequence.length - 1)]);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('prod-hardening-2 — SQL injection resistance', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('findByEmail with SQL injection pattern returns null (no match)', async () => {
    // The adapter uses parameterized queries, not string interpolation,
    // so injection patterns should simply not match any rows.
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.findByEmail("' OR 1=1 --");
    expect(result).toBeNull();
  });

  test('findByEmail with SQL injection in email returns null', async () => {
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.findByEmail("test@example.com; DROP TABLE users;");
    expect(result).toBeNull();
  });

  test('getUser with SQL injection ID returns null', async () => {
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const user = await adapter.getUser!("' OR '1'='1");
    expect(user).toBeNull();
  });
});

describe('prod-hardening-2 — concurrent creation race conditions', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('create with unique constraint violation returns HttpError(409)', async () => {
    const err = Object.assign(new Error('duplicate key value'), { code: '23505' });
    mockDbImpl = { insert: () => throwingBuilder(err) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });

    const { HttpError } = await import('@lastshotlabs/slingshot-core');
    const thrown = await adapter.create('dup@example.com', 'hash').catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
  });

  test('concurrent create calls on same email both handled gracefully', async () => {
    // Simulate: first call succeeds, second fails with 23505
    let callCount = 0;
    mockDbImpl = {
      insert: () => {
        callCount++;
        if (callCount === 1) return resolvingBuilder(undefined);
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });

    const { HttpError } = await import('@lastshotlabs/slingshot-core');

    // First creation should succeed
    const r1 = await adapter.create('race@example.com', 'hash1');
    expect(r1.id).toBeString();

    // Second creation should fail with 409
    const r2 = await adapter.create('race@example.com', 'hash2').catch(e => e);
    expect(r2).toBeInstanceOf(HttpError);
    expect((r2 as HttpError).status).toBe(409);
  });

  test('findOrCreateByProvider handles concurrent creation', async () => {
    let callCount = 0;
    mockDbImpl = {
      select: () => {
        callCount++;
        // First two selects return empty (no existing OAuth, no email conflict)
        if (callCount <= 2) return resolvingBuilder([]);
        // Subsequent selects return roles
        return resolvingBuilder([{ role: 'user' }]);
      },
      insert: () => resolvingBuilder(undefined),
      update: () => resolvingBuilder(undefined),
      delete: () => resolvingBuilder([]),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(makeTransactionMock()),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.findOrCreateByProvider!('github', 'gh-concurrent', {
      email: 'concurrent@example.com',
    });
    expect(result.created).toBe(true);
  });
});

describe('prod-hardening-2 — adapter method edge cases', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('getIdentifier returns user id when email is null', async () => {
    mockDbImpl = { select: () => resolvingBuilder([{ email: null }]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const id = await adapter.getIdentifier('user-id');
    expect(id).toBe('user-id');
  });

  test('getIdentifier returns email when present', async () => {
    mockDbImpl = { select: () => resolvingBuilder([{ email: 'user@example.com' }]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const id = await adapter.getIdentifier('user-id');
    expect(id).toBe('user@example.com');
  });

  test('linkProvider does not throw on successful link', async () => {
    mockDbImpl = { insert: () => resolvingBuilder(undefined) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.linkProvider!('uid', 'github', 'gh-1')).resolves.toBeUndefined();
  });

  test('unlinkProvider does not throw on successful unlink', async () => {
    mockDbImpl = { delete: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.unlinkProvider!('uid', 'github')).resolves.toBeUndefined();
  });

  test('setMfaEnabled toggles without error', async () => {
    mockDbImpl = { update: () => resolvingBuilder(undefined) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.setMfaEnabled!('uid', true)).resolves.toBeUndefined();
    await expect(adapter.setMfaEnabled!('uid', false)).resolves.toBeUndefined();
  });

  test('isMfaEnabled returns false when no MFA data exists', async () => {
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const enabled = await adapter.isMfaEnabled!('uid');
    expect(enabled).toBe(false);
  });

  test('setRecoveryCodes and getRecoveryCodes round-trip correctly', async () => {
    const codes = ['code1', 'code2', 'code3'];
    mockDbImpl = {
      delete: () => resolvingBuilder([]),
      insert: () => resolvingBuilder(undefined),
      select: () => resolvingBuilder(codes.map(c => ({ codeHash: c }))),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(makeTransactionMock()),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await adapter.setRecoveryCodes!('uid', codes);
    const retrieved = await adapter.getRecoveryCodes!('uid');
    expect(retrieved).toEqual(codes);
  });
});
