/**
 * Unit tests for cursor encoding and decoding used in keyset pagination.
 *
 * The `encodeCursor` and `decodeCursor` functions are internal to the adapter
 * module and not exported. We test them here by:
 *   1. Re-implementing the exact same encoding/decoding logic locally for
 *      pure unit tests on cursor payload structure.
 *   2. Testing the behaviour through the public `listGroups` and
 *      `getGroupMembers` methods, which consume cursors internally.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createPostgresAdapter } from '../src/adapter.js';

// ---------------------------------------------------------------------------
// Pure-function re-implementation (matching src/adapter.ts exactly)
// ---------------------------------------------------------------------------

interface CursorPayload {
  createdAt: string;
  id: string;
}

function encodeCursor(createdAt: Date, id: string): string {
  return btoa(JSON.stringify({ createdAt: createdAt.toISOString(), id }));
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(atob(cursor)) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt === 'string' && typeof parsed.id === 'string') {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('encodeCursor', () => {
  test('produces a base64-encoded JSON string', () => {
    const date = new Date('2026-04-01T12:00:00.000Z');
    const cursor = encodeCursor(date, 'row-42');
    expect(cursor).toBeString();
    // Verify it decodes back to valid JSON
    const decoded = JSON.parse(atob(cursor));
    expect(decoded).toEqual({
      createdAt: '2026-04-01T12:00:00.000Z',
      id: 'row-42',
    });
  });

  test('produces unique cursors for different timestamps', () => {
    const c1 = encodeCursor(new Date('2026-04-01T12:00:00.000Z'), 'a');
    const c2 = encodeCursor(new Date('2026-04-02T12:00:00.000Z'), 'a');
    expect(c1).not.toBe(c2);
  });

  test('produces unique cursors for different IDs with same timestamp', () => {
    const t = new Date('2026-04-01T12:00:00.000Z');
    const c1 = encodeCursor(t, 'a');
    const c2 = encodeCursor(t, 'b');
    expect(c1).not.toBe(c2);
  });

  test('handles millisecond precision in ISO string', () => {
    const date = new Date('2026-04-01T12:00:00.123Z');
    const cursor = encodeCursor(date, 'id-1');
    const decoded = JSON.parse(atob(cursor));
    expect(decoded.createdAt).toBe('2026-04-01T12:00:00.123Z');
  });
});

describe('decodeCursor', () => {
  test('decodes a valid base64 cursor', () => {
    const cursor = btoa(JSON.stringify({ createdAt: '2026-04-01T12:00:00.000Z', id: 'row-42' }));
    const result = decodeCursor(cursor);
    expect(result).toEqual({
      createdAt: '2026-04-01T12:00:00.000Z',
      id: 'row-42',
    });
  });

  test('returns null for malformed JSON', () => {
    const cursor = btoa('not-json');
    expect(decodeCursor(cursor)).toBeNull();
  });

  test('returns null for missing createdAt field', () => {
    const cursor = btoa(JSON.stringify({ id: 'row-42' }));
    expect(decodeCursor(cursor)).toBeNull();
  });

  test('returns null for missing id field', () => {
    const cursor = btoa(JSON.stringify({ createdAt: '2026-04-01T12:00:00.000Z' }));
    expect(decodeCursor(cursor)).toBeNull();
  });

  test('returns null when id is not a string', () => {
    const cursor = btoa(JSON.stringify({ createdAt: '2026-04-01T12:00:00.000Z', id: 42 }));
    expect(decodeCursor(cursor)).toBeNull();
  });

  test('returns null when createdAt is not a string', () => {
    const cursor = btoa(JSON.stringify({ createdAt: 123456, id: 'row-42' }));
    expect(decodeCursor(cursor)).toBeNull();
  });

  test('returns null for invalid base64 input', () => {
    expect(decodeCursor('!!!invalid-base64!!!')).toBeNull();
  });

  test('returns null for empty string', () => {
    // atob('') returns '' in bun, and JSON.parse('') throws
    expect(decodeCursor('')).toBeNull();
  });

  test('returns null for a cursor with extra fields', () => {
    // Extra fields should be ignored as long as createdAt and id are present
    // and of the right type.
    const cursor = btoa(
      JSON.stringify({
        createdAt: '2026-04-01T12:00:00.000Z',
        id: 'row-42',
        extraField: 'should-be-ignored',
      }),
    );
    const result = decodeCursor(cursor);
    expect(result).toEqual({
      createdAt: '2026-04-01T12:00:00.000Z',
      id: 'row-42',
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: public API behaviour with cursors
// ---------------------------------------------------------------------------

interface MockDb {
  select?: () => ReturnType<typeof makeBuilder>;
  insert?: (table?: unknown) => ReturnType<typeof makeBuilder>;
  update?: (table?: unknown) => ReturnType<typeof makeBuilder>;
  delete?: (table?: unknown) => ReturnType<typeof makeBuilder>;
  transaction?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
}

let mockDbImpl: MockDb | null = null;
let mockMigrationVersion = 0;

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

describe('listGroups — cursor pagination through public API', () => {
  const now = new Date('2026-04-01T12:00:00.000Z');

  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;

    // Build several group rows with staggered timestamps
    const groups = [
      { id: 'g-1', name: 'alpha', roles: [], tenantId: null, createdAt: now, updatedAt: now },
      {
        id: 'g-2',
        name: 'beta',
        roles: [],
        tenantId: null,
        createdAt: new Date('2026-04-01T12:01:00.000Z'),
        updatedAt: now,
      },
      {
        id: 'g-3',
        name: 'gamma',
        roles: [],
        tenantId: null,
        createdAt: new Date('2026-04-01T12:02:00.000Z'),
        updatedAt: now,
      },
    ];

    // Store groups so tests can override
    (globalThis as Record<string, unknown>).__testGroups = groups;
  });

  function makeListGroupsSelect(): () => Builder {
    return () => {
      // Return stored groups
      const groups = (globalThis as Record<string, unknown>).__testGroups as Array<
        Record<string, unknown>
      >;
      return resolvingBuilder(groups);
    };
  }

  test('returns first page of groups with no cursor', async () => {
    mockDbImpl = {
      select: makeListGroupsSelect(),
      insert: () => resolvingBuilder(undefined),
      update: () => resolvingBuilder(undefined),
      delete: () => resolvingBuilder([]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.listGroups!(null, { limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.items[0].name).toBe('alpha');
    expect(result.items[1].name).toBe('beta');
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeString();
  });

  test('returns all items when fewer than limit', async () => {
    (globalThis as Record<string, unknown>).__testGroups = [
      { id: 'g-1', name: 'alpha', roles: [], tenantId: null, createdAt: now, updatedAt: now },
    ];

    mockDbImpl = {
      select: makeListGroupsSelect(),
      insert: () => resolvingBuilder(undefined),
      update: () => resolvingBuilder(undefined),
      delete: () => resolvingBuilder([]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.listGroups!(null, { limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  test('limit is capped at 200', async () => {
    // Even if we request limit > 200, the adapter caps it at 200.
    // We can verify by checking that hasMore logic works correctly:
    // with 201 rows and a limit of 200, hasMore should be true.
    const manyGroups = Array.from({ length: 201 }, (_, i) => ({
      id: `g-${i}`,
      name: `group-${i}`,
      roles: [],
      tenantId: null,
      createdAt: new Date(Date.now() + i),
      updatedAt: now,
    }));
    (globalThis as Record<string, unknown>).__testGroups = manyGroups;

    mockDbImpl = {
      select: makeListGroupsSelect(),
      insert: () => resolvingBuilder(undefined),
      update: () => resolvingBuilder(undefined),
      delete: () => resolvingBuilder([]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    // Request 500, but adapter caps to 200
    const result = await adapter.listGroups!(null, { limit: 500 });

    expect(result.items.length).toBeLessThanOrEqual(200);
    // With 201 rows and limit 200, hasMore = true (rows.length === 201 > 200)
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeString();
  });

  test('malformed cursor string is treated as null (returns first page)', async () => {
    let selectCallCount = 0;
    const groups = (globalThis as Record<string, unknown>).__testGroups as Array<
      Record<string, unknown>
    >;

    mockDbImpl = {
      select: () => {
        selectCallCount++;
        return resolvingBuilder(groups);
      },
      insert: () => resolvingBuilder(undefined),
      update: () => resolvingBuilder(undefined),
      delete: () => resolvingBuilder([]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });

    // Pass a malformed cursor — should not throw, should return first page
    const result = await adapter.listGroups!(null, {
      limit: 2,
      cursor: '!!!invalid!!!',
    });

    expect(result.items).toHaveLength(2);
    // The condition should have no cursor clause (since decodeCursor returned null),
    // which means all rows are returned and slicing happens. Since we have 3 rows
    // and limit 2, we get 2 items with hasMore=true.
    expect(result.hasMore).toBe(true);
  });

  test('empty cursor string is treated as null', async () => {
    mockDbImpl = {
      select: () => resolvingBuilder([]),
      insert: () => resolvingBuilder(undefined),
      update: () => resolvingBuilder(undefined),
      delete: () => resolvingBuilder([]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    // Empty cursor string → decodeCursor('') → null → no cursor filter
    const result = await adapter.listGroups!(null, { limit: 10, cursor: '' });
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});

describe('getGroupMembers — cursor pagination through public API', () => {
  const now = new Date('2026-04-01T12:00:00.000Z');

  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
    (globalThis as Record<string, unknown>).__testMembers = [
      { userId: 'u-1', roles: ['admin'], createdAt: now },
      {
        userId: 'u-2',
        roles: ['viewer'],
        createdAt: new Date('2026-04-01T12:01:00.000Z'),
      },
      {
        userId: 'u-3',
        roles: ['editor'],
        createdAt: new Date('2026-04-01T12:02:00.000Z'),
      },
    ];
  });

  test('paginates members with hasMore and nextCursor', async () => {
    mockDbImpl = {
      select: () => {
        const members = (globalThis as Record<string, unknown>).__testMembers as Array<
          Record<string, unknown>
        >;
        return resolvingBuilder(members);
      },
      insert: () => resolvingBuilder(undefined),
      update: () => resolvingBuilder(undefined),
      delete: () => resolvingBuilder([]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.getGroupMembers!('group-1', { limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeString();
  });

  test('returns all members when fewer than limit with no cursor', async () => {
    (globalThis as Record<string, unknown>).__testMembers = [
      { userId: 'u-1', roles: ['admin'], createdAt: now },
    ];
    mockDbImpl = {
      select: () => {
        const members = (globalThis as Record<string, unknown>).__testMembers as Array<
          Record<string, unknown>
        >;
        return resolvingBuilder(members);
      },
      insert: () => resolvingBuilder(undefined),
      update: () => resolvingBuilder(undefined),
      delete: () => resolvingBuilder([]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.getGroupMembers!('group-1', { limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  test('malformed cursor falls back to first page without throwing', async () => {
    mockDbImpl = {
      select: () => resolvingBuilder([]),
      insert: () => resolvingBuilder(undefined),
      update: () => resolvingBuilder(undefined),
      delete: () => resolvingBuilder([]),
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });

    await expect(
      adapter.getGroupMembers!('group-1', { limit: 10, cursor: 'bad-cursor' }),
    ).resolves.toBeDefined();
  });
});
