/**
 * Unit tests for error paths in slingshot-postgres adapter.
 *
 * These tests focus exclusively on error paths not covered by the docker
 * integration tests (tests/docker/postgres-adapter.test.ts). The happy
 * path is covered there.
 *
 * Strategy: mock `pg` (so Pool construction is captured) and
 * `drizzle-orm/node-postgres` (so drizzle() returns a fake db object).
 * The fake db object lets us simulate query failures and transaction
 * rollback scenarios at the drizzle level.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  HttpError,
  attachPostgresPoolRuntime,
  createPostgresPoolRuntime,
} from '@lastshotlabs/slingshot-core';
// ── Import adapter AFTER mocks ────────────────────────────────────────────────
import { createPostgresAdapter } from '../src/adapter.js';

// ── Mock helpers ─────────────────────────────────────────────────────────────

// We need to control what drizzle's db object returns per-test, so we keep
// references to the per-test overrides here.
let mockDbImpl: MockDb | null = null;
let mockMigrationVersion = 2;

interface MockDb {
  select?: () => ReturnType<typeof makeBuilder>;
  insert?: (table: unknown) => ReturnType<typeof makeBuilder>;
  update?: (table: unknown) => ReturnType<typeof makeBuilder>;
  delete?: (table: unknown) => ReturnType<typeof makeBuilder>;
  transaction?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
}

/**
 * Returns a chainable query builder (Proxy) that, when awaited, either resolves
 * with `result` or rejects with `error`. All chainable drizzle methods (from,
 * where, set, values, limit, offset, onConflictDoNothing, …) return the same
 * proxy, so the chain can be any length.
 */
type DrizzleBuilder = Record<string, unknown> & PromiseLike<unknown>;
function makeBuilder(result: unknown, error: Error | null): DrizzleBuilder {
  const proxy: DrizzleBuilder = new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (prop === 'then') {
        return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
          const p = error ? Promise.reject(error) : Promise.resolve(result);
          return p.then(onFulfilled, onRejected);
        };
      }
      if (prop === Symbol.toStringTag) return 'MockBuilder';
      // All other property accesses (from, where, set, values, limit, offset,
      // onConflictDoNothing, etc.) return a function that returns the same proxy.
      return () => proxy;
    },
  }) as DrizzleBuilder;
  return proxy;
}

function throwingBuilder(error: Error): DrizzleBuilder {
  return makeBuilder(null, error);
}

function resolvingBuilder(value: unknown): ReturnType<typeof makeBuilder> {
  return makeBuilder(value, null);
}

function resolvingSequence(...values: unknown[]): () => DrizzleBuilder {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return resolvingBuilder(value ?? []);
  };
}

function makeTransactionMock(selectValues: unknown[] = []): Record<string, unknown> {
  const nextSelect = selectValues.length > 0 ? resolvingSequence(...selectValues) : undefined;
  return {
    select: nextSelect ?? (() => resolvingBuilder([])),
    insert: () => resolvingBuilder(undefined),
    update: () => resolvingBuilder(undefined),
    delete: () => resolvingBuilder(undefined),
  };
}

// ── Mock `pg` ─────────────────────────────────────────────────────────────────
// Pool is used in createPostgresAdapter; we mock it here so the real Pool is
// never constructed. Migration queries go through pool.query — we stub them to
// succeed so that the adapter factory resolves in every test.

mock.module('pg', () => {
  return {
    Pool: class MockPool {
      // runMigrations uses pool.connect() + PoolClient, not pool.query() directly.
      connect(): Promise<{
        query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
        release(): void;
      }> {
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
      end(): Promise<void> {
        return Promise.resolve();
      }
    },
  };
});

// ── Mock `drizzle-orm/node-postgres` ─────────────────────────────────────────
// drizzle() returns our per-test mockDbImpl proxy.

mock.module('drizzle-orm/node-postgres', () => {
  return {
    drizzle: () => {
      return new Proxy(
        {},
        {
          get(_target, prop) {
            if (!mockDbImpl) throw new Error('mockDbImpl not set');
            const impl = mockDbImpl as Record<string | symbol, unknown>;
            if (prop in impl) return impl[prop];
            throw new Error(`mockDbImpl missing method: ${String(prop)}`);
          },
        },
      );
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function pgError(code: string, message: string): Error & { code?: string } {
  const e: Error & { code?: string } = new Error(message);
  e.code = code;
  return e;
}

function connectionError(): Error {
  const e: Error & { code?: string } = new Error('connect ECONNREFUSED 127.0.0.1:5432');
  e.code = 'ECONNREFUSED';
  return e;
}

function timeoutError(): Error {
  const e: Error & { code?: string } = new Error('Query read timeout');
  e.code = 'ETIMEDOUT';
  return e;
}

function uniqueConstraintError(): Error {
  // Postgres error code 23505 = unique_violation
  return pgError(
    '23505',
    'duplicate key value violates unique constraint "slingshot_users_email_key"',
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('slingshot-postgres adapter — error paths', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('fails closed when the database schema version is newer than this binary supports', async () => {
    mockMigrationVersion = 3;
    await expect(createPostgresAdapter({ pool: new (await import('pg')).Pool() })).rejects.toThrow(
      'Database schema version 3 is newer than this binary supports (2)',
    );
  });

  test('skips adapter migrations when the pool runtime is configured as assume-ready', async () => {
    mockMigrationVersion = 99;
    const pool = new (await import('pg')).Pool();
    attachPostgresPoolRuntime(pool, createPostgresPoolRuntime({ migrationMode: 'assume-ready' }));

    await expect(createPostgresAdapter({ pool })).resolves.toBeDefined();
  });

  // ── Connection / network errors ────────────────────────────────────────────

  describe('connection failure', () => {
    test('findByEmail propagates ECONNREFUSED', async () => {
      const err = connectionError();
      mockDbImpl = { select: () => throwingBuilder(err) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.findByEmail('test@example.com')).rejects.toThrow('ECONNREFUSED');
    });

    test('create propagates ECONNREFUSED', async () => {
      const err = connectionError();
      mockDbImpl = { insert: () => throwingBuilder(err) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.create('test@example.com', 'hash')).rejects.toThrow('ECONNREFUSED');
    });

    test('getUser propagates ECONNREFUSED', async () => {
      const err = connectionError();
      mockDbImpl = { select: () => throwingBuilder(err) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.getUser!('user-id')).rejects.toThrow('ECONNREFUSED');
    });
  });

  // ── Query timeout ──────────────────────────────────────────────────────────

  describe('query timeout', () => {
    test('findByEmail propagates timeout error', async () => {
      const err = timeoutError();
      mockDbImpl = { select: () => throwingBuilder(err) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.findByEmail('test@example.com')).rejects.toThrow('Query read timeout');
    });

    test('listUsers propagates timeout error', async () => {
      const err = timeoutError();
      mockDbImpl = {
        transaction: async () => {
          throw err;
        },
      };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.listUsers!({})).rejects.toThrow('Query read timeout');
    });
  });

  // ── Unique constraint violations (pg error code 23505) ────────────────────
  //
  // Duplicate-email creates are normalized to the public HttpError contract.
  // Other duplicate-safe paths either avoid conflicts via SQL upserts or
  // retain their existing explicit conflict handling.

  describe('unique constraint violation (23505)', () => {
    test('create: 23505 becomes HttpError(409)', async () => {
      const err = uniqueConstraintError();
      mockDbImpl = { insert: () => throwingBuilder(err) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      const thrown = await adapter.create('dup@example.com', 'hash').catch(e => e);
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(409);
      expect((thrown as HttpError).message).toBe('Email already registered');
    });

    test('addRole: 23505 does NOT occur because onConflictDoNothing() is used', async () => {
      // addRole uses .onConflictDoNothing() — the adapter handles the duplicate
      // at SQL level, so no error should be thrown.
      mockDbImpl = { insert: () => resolvingBuilder(undefined) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.addRole!('user-id', 'admin')).resolves.toBeUndefined();
    });

    test('linkProvider: 23505 does NOT occur because onConflictDoNothing() is used', async () => {
      mockDbImpl = { insert: () => resolvingBuilder(undefined) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.linkProvider!('user-id', 'github', 'gh-123')).resolves.toBeUndefined();
    });
  });

  // ── findOrCreateByProvider — email conflict HTTP error ────────────────────
  //
  // This is the ONE place where the adapter wraps a business-logic error into
  // HttpError(409) rather than letting a DB error bubble up.

  describe('findOrCreateByProvider — email conflict', () => {
    test('throws HttpError(409) from slingshot-core when email already exists', async () => {
      // First select (for existing oauth account) returns empty; second select
      // (for email conflict check) returns a user row.
      let callCount = 0;
      mockDbImpl = {
        select: () => {
          callCount++;
          if (callCount === 1) return resolvingBuilder([]);
          return resolvingBuilder([{ id: 'existing-user-id' }]);
        },
      };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      const thrown = await adapter.findOrCreateByProvider!('google', 'google-123', {
        email: 'existing@example.com',
      }).catch(e => e);

      // Must be the HttpError class from slingshot-core so instanceof checks in
      // the auth plugin's catch handler recognise it correctly.
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(409);
      expect((thrown as HttpError).code).toBe('PROVIDER_EMAIL_CONFLICT');
      expect(thrown.message).toContain('already exists');
    });

    test('does NOT throw when oauth account already exists', async () => {
      mockDbImpl = { select: () => resolvingBuilder([{ userId: 'existing-user-id' }]) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      const result = await adapter.findOrCreateByProvider!('google', 'google-123', {
        email: 'existing@example.com',
      });
      expect(result).toEqual({ id: 'existing-user-id', created: false });
    });
  });

  // ── Transaction rollback on partial failure ────────────────────────────────
  //
  // drizzle's db.transaction() automatically rolls back if the callback throws.
  // The adapter does NOT add its own rollback logic — it delegates entirely to
  // drizzle. We verify that the outer error propagates when the inner tx throws.

  describe('transaction rollback on partial failure', () => {
    test('setRoles: transaction failure propagates to caller', async () => {
      const err = new Error('deadlock detected');
      mockDbImpl = {
        transaction: async () => {
          throw err;
        },
      };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.setRoles!('user-id', ['admin'])).rejects.toThrow('deadlock detected');
    });

    test('setTenantRoles: transaction failure propagates to caller', async () => {
      const err = new Error('connection reset during transaction');
      mockDbImpl = {
        transaction: async () => {
          throw err;
        },
      };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.setTenantRoles!('user-id', 'tenant-1', ['member'])).rejects.toThrow(
        'connection reset during transaction',
      );
    });

    test('findOrCreateByProvider: inner tx failure propagates (no user created)', async () => {
      const transactionErr = new Error('insert failed mid-transaction');
      let callCount = 0;
      mockDbImpl = {
        select: () => {
          callCount++;
          if (callCount === 1) return resolvingBuilder([]);
          return resolvingBuilder([]);
        },
        transaction: async () => {
          throw transactionErr;
        },
      };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(
        adapter.findOrCreateByProvider!('google', 'google-999', { email: 'new@example.com' }),
      ).rejects.toThrow('insert failed mid-transaction');
    });

    test('listUsers: transaction failure propagates to caller', async () => {
      const err = new Error('serialization failure');
      mockDbImpl = {
        transaction: async () => {
          throw err;
        },
      };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.listUsers!({})).rejects.toThrow('serialization failure');
    });

    test('setRecoveryCodes: transaction failure propagates to caller', async () => {
      const err = new Error('deadlock on recovery codes');
      mockDbImpl = {
        transaction: async () => {
          throw err;
        },
      };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.setRecoveryCodes!('user-id', ['hash1', 'hash2'])).rejects.toThrow(
        'deadlock on recovery codes',
      );
    });
  });

  // ── consumeRecoveryCode ────────────────────────────────────────────────────
  //
  // Atomic DELETE ... RETURNING: true when the code existed and was consumed,
  // false when the code was not found.

  describe('consumeRecoveryCode', () => {
    test('returns true when code exists and is deleted', async () => {
      mockDbImpl = { delete: () => resolvingBuilder([{ codeHash: 'hashed-code' }]) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      expect(await adapter.consumeRecoveryCode('user-id', 'hashed-code')).toBe(true);
    });

    test('returns false when code is not found', async () => {
      mockDbImpl = { delete: () => resolvingBuilder([]) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      expect(await adapter.consumeRecoveryCode('user-id', 'missing-code')).toBe(false);
    });

    test('propagates DB error', async () => {
      mockDbImpl = { delete: () => throwingBuilder(connectionError()) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.consumeRecoveryCode('user-id', 'hashed-code')).rejects.toThrow(
        'ECONNREFUSED',
      );
    });
  });

  // ── listUsers filter coverage ──────────────────────────────────────────────
  //
  // Verify that the three UserQuery filter fields (email, externalId, suspended)
  // are passed through to the transaction rather than silently ignored.

  describe('listUsers — filter fields reach the transaction', () => {
    test('email filter: transaction is called (not silently bypassed)', async () => {
      let called = false;
      mockDbImpl = {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          called = true;
          // Provide a minimal tx that returns empty results
          const tx = new Proxy(
            {},
            {
              get() {
                const builder = resolvingBuilder([{ count: '0' }]);
                return () => builder;
              },
            },
          );
          return fn(tx);
        },
      };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await adapter.listUsers!({ email: 'alice' });
      expect(called).toBe(true);
    });

    test('suspended filter: transaction is called', async () => {
      let called = false;
      mockDbImpl = {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          called = true;
          const tx = new Proxy(
            {},
            {
              get() {
                const builder = resolvingBuilder([{ count: '0' }]);
                return () => builder;
              },
            },
          );
          return fn(tx);
        },
      };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await adapter.listUsers!({ suspended: true });
      expect(called).toBe(true);
    });

    test('externalId filter: transaction is called', async () => {
      let called = false;
      mockDbImpl = {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          called = true;
          const tx = new Proxy(
            {},
            {
              get() {
                const builder = resolvingBuilder([{ count: '0' }]);
                return () => builder;
              },
            },
          );
          return fn(tx);
        },
      };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await adapter.listUsers!({ externalId: 'ext-123' });
      expect(called).toBe(true);
    });
  });

  // ── Generic error propagation (no wrapping) ───────────────────────────────
  //
  // Verify that arbitrary errors from several methods bubble up unmodified.

  describe('error propagation — no wrapping', () => {
    const methods: Array<{
      name: string;
      setup: (db: MockDb) => void;
      call: (adapter: Awaited<ReturnType<typeof createPostgresAdapter>>) => Promise<unknown>;
    }> = [
      {
        name: 'getRoles',
        setup: db => {
          db.select = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.getRoles!('user-id'),
      },
      {
        name: 'deleteUser',
        setup: db => {
          db.delete = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.deleteUser!('user-id'),
      },
      {
        name: 'setSuspended',
        setup: db => {
          db.update = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.setSuspended!('user-id', true, 'reason'),
      },
      {
        name: 'getSuspended',
        setup: db => {
          db.select = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.getSuspended!('user-id'),
      },
      {
        name: 'updateProfile',
        setup: db => {
          db.update = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.updateProfile!('user-id', { displayName: 'Test' }),
      },
      {
        name: 'setPassword',
        setup: db => {
          db.update = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.setPassword!('user-id', 'newhash'),
      },
      {
        name: 'setMfaSecret',
        setup: db => {
          db.update = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.setMfaSecret!('user-id', 'base32secret'),
      },
      {
        name: 'getMfaSecret',
        setup: db => {
          db.select = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.getMfaSecret!('user-id'),
      },
      {
        name: 'setMfaMethods',
        setup: db => {
          db.update = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.setMfaMethods!('user-id', ['totp']),
      },
      {
        name: 'getWebAuthnCredentials',
        setup: db => {
          db.select = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.getWebAuthnCredentials!('user-id'),
      },
      {
        name: 'addWebAuthnCredential',
        setup: db => {
          db.insert = () => throwingBuilder(new Error('db offline'));
        },
        call: a =>
          a.addWebAuthnCredential!('user-id', {
            credentialId: 'cred-1',
            publicKey: 'key',
            signCount: 0,
            createdAt: Date.now(),
          }),
      },
      {
        name: 'getGroup',
        setup: db => {
          db.select = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.getGroup!('group-id'),
      },
      {
        name: 'deleteGroup',
        setup: db => {
          db.delete = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.deleteGroup!('group-id'),
      },
      {
        name: 'updateGroup',
        setup: db => {
          db.update = () => throwingBuilder(new Error('db offline'));
        },
        call: a => a.updateGroup!('group-id', { displayName: 'X' }),
      },
    ];

    for (const { name, setup, call } of methods) {
      test(`${name} propagates raw error without wrapping`, async () => {
        const db: MockDb = {};
        setup(db);
        mockDbImpl = db;
        const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
        await expect(call(adapter)).rejects.toThrow('db offline');
      });
    }
  });

  // ── createGroup — name conflict ────────────────────────────────────────────
  //
  // 23505 on groups is mapped to HttpError(409, GROUP_NAME_CONFLICT).
  // All other errors bubble up raw.

  describe('createGroup — name conflict', () => {
    test('23505 → HttpError(409, GROUP_NAME_CONFLICT)', async () => {
      mockDbImpl = { insert: () => throwingBuilder(uniqueConstraintError()) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      const thrown = await adapter.createGroup!({
        name: 'dup-group',
        tenantId: 'default',
        roles: [],
      }).catch(e => e);
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(409);
      expect((thrown as HttpError).code).toBe('GROUP_NAME_CONFLICT');
    });

    test('non-23505 errors bubble up raw', async () => {
      mockDbImpl = { insert: () => throwingBuilder(connectionError()) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(
        adapter.createGroup!({ name: 'g1', tenantId: 'default', roles: [] }),
      ).rejects.toThrow('ECONNREFUSED');
    });
  });

  // ── addGroupMember ─────────────────────────────────────────────────────────
  //
  // HttpError(404) when the group row is not found;
  // HttpError(409, GROUP_MEMBER_CONFLICT) on 23505 from insert;
  // other errors bubble raw.

  describe('addGroupMember', () => {
    test('throws HttpError(404) when group does not exist', async () => {
      mockDbImpl = { select: () => resolvingBuilder([]) };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      const thrown = await adapter.addGroupMember!('nonexistent-group', 'user-id').catch(e => e);
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(404);
    });

    test('23505 on memberships → HttpError(409, GROUP_MEMBER_CONFLICT)', async () => {
      mockDbImpl = {
        select: () => resolvingBuilder([{ tenantId: null }]),
        insert: () => throwingBuilder(uniqueConstraintError()),
      };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      const thrown = await adapter.addGroupMember!('group-id', 'user-id').catch(e => e);
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(409);
      expect((thrown as HttpError).code).toBe('GROUP_MEMBER_CONFLICT');
    });

    test('non-23505 insert errors bubble up raw', async () => {
      mockDbImpl = {
        select: () => resolvingBuilder([{ tenantId: null }]),
        insert: () => throwingBuilder(timeoutError()),
      };
      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
      await expect(adapter.addGroupMember!('group-id', 'user-id')).rejects.toThrow(
        'Query read timeout',
      );
    });
  });

  describe('happy-path adapter surface', () => {
    test('maps reads, writes, transactions, pagination, and role aggregation', async () => {
      const now = new Date('2026-01-02T03:04:05.000Z');
      const passwordHash = await Bun.password.hash('correct-password');
      const userRow = {
        id: 'user-1',
        email: 'USER@example.com',
        displayName: 'User One',
        firstName: 'User',
        lastName: 'One',
        externalId: 'external-1',
        emailVerified: true,
        suspended: false,
        suspendedReason: null,
        suspendedAt: null,
        userMetadata: { plan: 'pro' },
        appMetadata: { flags: ['beta'] },
      };
      const groupRow = {
        id: 'group-1',
        name: 'ops',
        displayName: 'Operations',
        description: 'Ops team',
        roles: ['group-role'],
        tenantId: 'tenant-1',
        createdAt: now,
        updatedAt: now,
      };
      const secondGroupRow = { ...groupRow, id: 'group-2', name: 'support' };
      const memberRow = {
        userId: 'user-1',
        roles: ['member-role'],
        createdAt: now,
      };

      const select = resolvingSequence(
        [{ id: 'user-1', passwordHash: 'hash' }],
        [{ passwordHash }],
        [{ email: 'USER@example.com' }],
        [userRow],
        [{ emailVerified: true }],
        [{ passwordHash: 'hash' }],
        [{ userMetadata: { plan: 'pro' }, appMetadata: { flags: ['beta'] } }],
        [],
        [],
        [{ mfaSecret: 'base32-secret' }],
        [{ mfaEnabled: true }],
        [{ codeHash: 'code-1' }, { codeHash: 'code-2' }],
        [{ mfaMethods: ['totp', 'webauthn'] }],
        [
          {
            credentialId: 'cred-1',
            publicKey: 'public-key',
            signCount: 7,
            transports: ['usb'],
            name: 'Security key',
            createdAt: now,
          },
        ],
        [{ userId: 'user-1' }],
        [{ role: 'admin' }, { role: 'viewer' }],
        [{ role: 'tenant-admin' }],
        [groupRow],
        [groupRow, secondGroupRow],
        [{ tenantId: 'tenant-1' }],
        [memberRow, { ...memberRow, userId: 'user-2' }],
        [
          {
            groupId: 'group-1',
            groupName: 'ops',
            groupDisplayName: 'Operations',
            groupDescription: 'Ops team',
            groupRoles: ['group-role'],
            groupTenantId: 'tenant-1',
            groupCreatedAt: now,
            groupUpdatedAt: now,
            memberRoles: ['member-role'],
          },
        ],
        [{ role: 'tenant-admin' }],
        [{ groupRoles: ['group-role'], memberRoles: ['member-role'] }],
        [{ role: 'admin' }],
        [{ groupRoles: ['group-role'], memberRoles: ['admin'] }],
        [{ suspended: true, suspendedReason: 'policy' }],
      );

      mockDbImpl = {
        select,
        insert: () => resolvingBuilder(undefined),
        update: () => resolvingBuilder(undefined),
        delete: () => resolvingBuilder([{ codeHash: 'hashed-code' }]),
        transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(makeTransactionMock([[userRow], [{ count: '1' }]])),
      };

      const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });

      expect(await adapter.findByEmail('USER@example.com')).toEqual({
        id: 'user-1',
        passwordHash: 'hash',
      });
      expect((await adapter.create('USER@example.com', 'hash')).id).toBeString();
      expect(await adapter.verifyPassword('user-1', 'correct-password')).toBe(true);
      expect(await adapter.getIdentifier('user-1')).toBe('USER@example.com');
      expect(await adapter.consumeRecoveryCode('user-1', 'hashed-code')).toBe(true);
      expect(await adapter.getUser!('user-1')).toMatchObject({
        email: 'USER@example.com',
        displayName: 'User One',
        emailVerified: true,
        suspended: false,
      });

      await adapter.setPassword!('user-1', 'new-hash');
      await adapter.deleteUser!('user-1');
      await adapter.setEmailVerified!('user-1', true);
      expect(await adapter.getEmailVerified!('user-1')).toBe(true);
      expect(await adapter.hasPassword!('user-1')).toBe(true);
      await adapter.updateProfile!('user-1', {
        displayName: 'User One',
        firstName: 'User',
        lastName: 'One',
        externalId: 'external-1',
      });
      expect(await adapter.getUserMetadata!('user-1')).toEqual({
        userMetadata: { plan: 'pro' },
        appMetadata: { flags: ['beta'] },
      });
      await adapter.setUserMetadata!('user-1', { plan: 'enterprise' });
      await adapter.setAppMetadata!('user-1', { flags: ['ga'] });

      expect(
        await adapter.findOrCreateByProvider!('google', 'google-1', {
          email: 'New@Example.com',
          displayName: 'New User',
          firstName: 'New',
          lastName: 'User',
          externalId: 'google-1',
        }),
      ).toMatchObject({ created: true });
      await adapter.linkProvider!('user-1', 'google', 'google-1');
      await adapter.unlinkProvider!('user-1', 'google');

      await adapter.setMfaSecret!('user-1', 'base32-secret');
      expect(await adapter.getMfaSecret!('user-1')).toBe('base32-secret');
      expect(await adapter.isMfaEnabled!('user-1')).toBe(true);
      await adapter.setMfaEnabled!('user-1', true);
      await adapter.setRecoveryCodes!('user-1', ['code-1', 'code-2']);
      expect(await adapter.getRecoveryCodes!('user-1')).toEqual(['code-1', 'code-2']);
      await adapter.removeRecoveryCode!('user-1', 'code-1');
      expect(await adapter.getMfaMethods!('user-1')).toEqual(['totp', 'webauthn']);
      await adapter.setMfaMethods!('user-1', ['totp']);

      expect(await adapter.getWebAuthnCredentials!('user-1')).toEqual([
        {
          credentialId: 'cred-1',
          publicKey: 'public-key',
          signCount: 7,
          transports: ['usb'],
          name: 'Security key',
          createdAt: now.getTime(),
        },
      ]);
      await adapter.addWebAuthnCredential!('user-1', {
        credentialId: 'cred-2',
        publicKey: 'public-key-2',
        signCount: 0,
        transports: ['nfc'],
        name: 'Backup key',
        createdAt: now.getTime(),
      });
      await adapter.removeWebAuthnCredential!('user-1', 'cred-2');
      await adapter.updateWebAuthnCredentialSignCount!('user-1', 'cred-1', 8);
      expect(await adapter.findUserByWebAuthnCredentialId!('cred-1')).toBe('user-1');

      expect(await adapter.getRoles!('user-1')).toEqual(['admin', 'viewer']);
      await adapter.setRoles!('user-1', ['admin']);
      await adapter.addRole!('user-1', 'editor');
      await adapter.removeRole!('user-1', 'viewer');
      expect(await adapter.getTenantRoles!('user-1', 'tenant-1')).toEqual(['tenant-admin']);
      await adapter.setTenantRoles!('user-1', 'tenant-1', ['tenant-admin']);
      await adapter.addTenantRole!('user-1', 'tenant-1', 'billing');
      await adapter.removeTenantRole!('user-1', 'tenant-1', 'billing');

      expect(
        (await adapter.createGroup!({ name: 'ops', tenantId: 'tenant-1', roles: [] })).id,
      ).toBeString();
      await adapter.deleteGroup!('group-1');
      expect(await adapter.getGroup!('group-1')).toMatchObject({
        id: 'group-1',
        tenantId: 'tenant-1',
        createdAt: now.getTime(),
      });
      const groupPage = await adapter.listGroups!('tenant-1', { limit: 1 });
      expect(groupPage.items).toHaveLength(1);
      expect(groupPage.hasMore).toBe(true);
      expect(groupPage.nextCursor).toBeString();
      await adapter.updateGroup!('group-1', {
        name: 'ops-renamed',
        displayName: undefined,
        description: undefined,
        roles: ['operator'],
      });
      await adapter.addGroupMember!('group-1', 'user-1', ['member-role']);
      await adapter.updateGroupMembership!('group-1', 'user-1', ['owner']);
      await adapter.removeGroupMember!('group-1', 'user-1');
      const membersPage = await adapter.getGroupMembers!('group-1', { limit: 1 });
      expect(membersPage.items).toEqual([{ userId: 'user-1', roles: ['member-role'] }]);
      expect(membersPage.hasMore).toBe(true);
      expect(await adapter.getUserGroups!('user-1', 'tenant-1')).toEqual([
        {
          group: {
            id: 'group-1',
            name: 'ops',
            displayName: 'Operations',
            description: 'Ops team',
            roles: ['group-role'],
            tenantId: 'tenant-1',
            createdAt: now.getTime(),
            updatedAt: now.getTime(),
          },
          membershipRoles: ['member-role'],
        },
      ]);
      expect(await adapter.getEffectiveRoles!('user-1', 'tenant-1')).toEqual([
        'tenant-admin',
        'group-role',
        'member-role',
      ]);
      expect(await adapter.getEffectiveRoles!('user-1', null)).toEqual(['admin', 'group-role']);

      await adapter.setSuspended!('user-1', true, 'policy');
      expect(await adapter.getSuspended!('user-1')).toEqual({
        suspended: true,
        suspendedReason: 'policy',
      });
      expect(await adapter.listUsers!({ email: 'USER', count: 1 })).toMatchObject({
        totalResults: 1,
        users: [{ id: 'user-1', email: 'USER@example.com' }],
      });
    });
  });
});
