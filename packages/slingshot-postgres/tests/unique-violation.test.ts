/**
 * Unit tests for unique-constraint-violation detection (PostgreSQL error code 23505).
 *
 * Tests both the pure detection functions (hasCode23505, isUniqueViolation) and
 * the public adapter methods that translate 23505 into typed HttpError responses.
 *
 * Key behaviours under test:
 *   1. Raw `pg` errors with `code === '23505'` are detected at the top level.
 *   2. Drizzle-wrapped errors with `{ cause: { code: '23505' } }` are detected.
 *   3. Non-23505 codes, nullish values, and non-object types return false.
 *   4. `create()`, `createGroup()`, and `addGroupMember()` each translate 23505
 *      into the correct HttpError(409) with domain-specific `.code`.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { HttpError } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Pure-function re-implementation (matching src/adapter.ts exactly)
// ---------------------------------------------------------------------------

function hasCode23505(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}

function isUniqueViolation(err: unknown): boolean {
  if (hasCode23505(err)) return true;
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    return hasCode23505((err as { cause: unknown }).cause);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function pgError(code: string, message: string): Error & { code?: string } {
  const e: Error & { code?: string } = new Error(message);
  e.code = code;
  return e;
}

function drizzleQueryError(code: string, message: string): Error {
  const pgErr = pgError(code, message);
  const wrapped: Error & { cause?: unknown } = new Error('Drizzle query error');
  wrapped.cause = pgErr;
  return wrapped;
}

// ---------------------------------------------------------------------------
// hasCode23505
// ---------------------------------------------------------------------------

describe('hasCode23505', () => {
  test('returns true when error has code exactly "23505"', () => {
    expect(hasCode23505(pgError('23505', 'unique violation'))).toBe(true);
  });

  test('returns false for other PostgreSQL error codes', () => {
    expect(hasCode23505(pgError('23514', 'check violation'))).toBe(false);
    expect(hasCode23505(pgError('23503', 'foreign key violation'))).toBe(false);
    expect(hasCode23505(pgError('P0001', 'raise exception'))).toBe(false);
    expect(hasCode23505(pgError('42703', 'undefined column'))).toBe(false);
    expect(hasCode23505(pgError('00000', 'successful completion'))).toBe(false);
  });

  test('returns false for non-object values', () => {
    expect(hasCode23505(null)).toBe(false);
    expect(hasCode23505(undefined)).toBe(false);
    expect(hasCode23505('23505')).toBe(false);
    expect(hasCode23505(23505)).toBe(false);
  });

  test('returns false for an object without a code property', () => {
    expect(hasCode23505(new Error('generic'))).toBe(false);
    expect(hasCode23505({})).toBe(false);
  });

  test('returns false when code is a number rather than a string', () => {
    const err = new Error('numeric code') as Error & { code?: number };
    err.code = 23505;
    // The production code does `=== '23505'` (strict string), so a numeric 23505
    // should *not* match, even though semantically it represents the same code.
    // This test locks in that strict-string contract.
    expect(hasCode23505(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isUniqueViolation
// ---------------------------------------------------------------------------

describe('isUniqueViolation', () => {
  test('detects 23505 at the top level (raw pg error)', () => {
    expect(isUniqueViolation(pgError('23505', 'dup'))).toBe(true);
  });

  test('detects 23505 inside .cause (Drizzle-wrapped error)', () => {
    expect(isUniqueViolation(drizzleQueryError('23505', 'dup'))).toBe(true);
  });

  test('returns false for non-23505 error with cause', () => {
    const wrapped = drizzleQueryError('23514', 'check violation');
    expect(isUniqueViolation(wrapped)).toBe(false);
  });

  test('returns false for error with cause that has no code', () => {
    const err: Error & { cause?: unknown } = new Error('wrapped');
    err.cause = new Error('inner');
    expect(isUniqueViolation(err)).toBe(false);
  });

  test('returns false for error with cause that is null', () => {
    const err: Error & { cause?: unknown } = new Error('wrapped');
    err.cause = null;
    expect(isUniqueViolation(err)).toBe(false);
  });

  test('returns false for plain Error without code or cause', () => {
    expect(isUniqueViolation(new Error('generic'))).toBe(false);
  });

  test('returns false for null and undefined', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  test('returns false for a cause that is non-object (string)', () => {
    const err: Error & { cause?: unknown } = new Error('wrapped');
    err.cause = 'string cause';
    expect(isUniqueViolation(err)).toBe(false);
  });

  test('handles deep cause chain where top level has no code but cause does', () => {
    const inner = pgError('23505', 'inner dup');
    const outer: Error & { cause?: unknown } = new Error('outer');
    outer.cause = inner;
    expect(isUniqueViolation(outer)).toBe(true);
  });

  test('does NOT recurse beyond one level of cause', () => {
    // If the error has cause, and that cause ALSO has cause with 23505, we
    // only check one level deep (matching the production implementation).
    const deep = pgError('23505', 'deep dup');
    const mid: Error & { cause?: unknown } = new Error('mid');
    mid.cause = deep;
    const outer: Error & { cause?: unknown } = new Error('outer');
    outer.cause = mid;
    // outer.cause is mid, which does NOT have code === '23505'
    expect(isUniqueViolation(outer)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: public adapter methods
// ---------------------------------------------------------------------------

let mockDbImpl: MockDb | null = null;
let mockMigrationVersion = 0;

interface MockDb {
  select?: () => ReturnType<typeof makeBuilder>;
  insert?: (table?: unknown) => ReturnType<typeof makeBuilder>;
  update?: (table?: unknown) => ReturnType<typeof makeBuilder>;
  delete?: (table?: unknown) => ReturnType<typeof makeBuilder>;
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

import { createPostgresAdapter } from '../src/adapter.js';

describe('HTTP 409 conversion for 23505', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2; // already migrated
  });

  test('create: raw 23505 error becomes HttpError(409, "Email already registered")', async () => {
    const pgErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockDbImpl = { insert: () => throwingBuilder(pgErr) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const thrown = await adapter.create('dup@example.com', 'hash').catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
    expect((thrown as HttpError).message).toBe('Email already registered');
    // No .code property on the HttpError for email conflicts
    expect((thrown as HttpError).code).toBeUndefined();
  });

  test('create: Drizzle-wrapped 23505 in .cause also becomes HttpError(409)', async () => {
    const inner = Object.assign(new Error('duplicate key'), { code: '23505' });
    const drizzleErr = Object.assign(new Error('Drizzle query error'), { cause: inner });
    mockDbImpl = { insert: () => throwingBuilder(drizzleErr) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const thrown = await adapter.create('dup@example.com', 'hash').catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
  });

  test('create: non-23505 errors pass through unchanged', async () => {
    const pgErr = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    mockDbImpl = { insert: () => throwingBuilder(pgErr) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.create('user@example.com', 'hash')).rejects.toThrow('deadlock detected');
  });

  test('createGroup: 23505 becomes HttpError(409) with GROUP_NAME_CONFLICT code', async () => {
    const pgErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockDbImpl = { insert: () => throwingBuilder(pgErr) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const thrown = await adapter
      .createGroup!({ name: 'dup-group', tenantId: 'default', roles: [] })
      .catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
    expect((thrown as HttpError).message).toBe('A group with this name already exists in this scope');
    expect((thrown as HttpError).code).toBe('GROUP_NAME_CONFLICT');
  });

  test('addGroupMember: 23505 becomes HttpError(409) with GROUP_MEMBER_CONFLICT code', async () => {
    mockDbImpl = {
      select: () => resolvingBuilder([{ tenantId: null }]),
      insert: () =>
        throwingBuilder(Object.assign(new Error('duplicate key'), { code: '23505' })),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const thrown = await adapter.addGroupMember!('group-id', 'user-id').catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
    expect((thrown as HttpError).code).toBe('GROUP_MEMBER_CONFLICT');
  });

  test('addGroupMember: Drizzle-wrapped 23505 in .cause also becomes HttpError(409)', async () => {
    const inner = Object.assign(new Error('duplicate key'), { code: '23505' });
    const drizzleErr = Object.assign(new Error('Drizzle query error'), { cause: inner });
    mockDbImpl = {
      select: () => resolvingBuilder([{ tenantId: null }]),
      insert: () => throwingBuilder(drizzleErr),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const thrown = await adapter.addGroupMember!('group-id', 'user-id').catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
    expect((thrown as HttpError).code).toBe('GROUP_MEMBER_CONFLICT');
  });

  test('addGroupMember: non-23505 insert errors pass through unchanged', async () => {
    mockDbImpl = {
      select: () => resolvingBuilder([{ tenantId: null }]),
      insert: () => throwingBuilder(new Error('connection reset')),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.addGroupMember!('group-id', 'user-id')).rejects.toThrow(
      'connection reset',
    );
  });

  test('addGroupMember: 404 error when group does not exist takes precedence', async () => {
    // Group query returns no rows → 404 before any insert happens
    mockDbImpl = { select: () => resolvingBuilder([]) };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const thrown = await adapter.addGroupMember!('missing-group', 'user-id').catch(e => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(404);
    expect((thrown as HttpError).message).toBe('Group not found');
  });
});
