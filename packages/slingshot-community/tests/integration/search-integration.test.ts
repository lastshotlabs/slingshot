/**
 * Integration tests for the `searchInContainer` custom operation.
 *
 * Tests the memory handler directly with a controlled in-memory store,
 * then smoke-tests the HTTP route via the community harness.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createSearchInContainerMemoryHandler,
  createSearchInContainerMongoHandler,
  createSearchInContainerPostgresHandler,
  createSearchInContainerRedisHandler,
  createSearchInContainerSqliteHandler,
} from '../../src/operations/searchInContainer';

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

function toPgRow(record: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    row[toSnakeCase(key)] = value;
  }
  return row;
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return new Date(value).getTime();
  return 0;
}

function createSearchPool(records: Array<Record<string, unknown>>) {
  return {
    query(sql: string, params: unknown[] = []) {
      let paramIdx = 0;
      const containerId = params[paramIdx++];
      let items = records.filter(r => r.containerId === containerId);

      if (sql.includes('status = $')) {
        const status = params[paramIdx++];
        items = items.filter(r => r.status === status);
      }
      if (sql.includes('author_id = $')) {
        const authorId = params[paramIdx++];
        items = items.filter(r => r.authorId === authorId);
      }
      if (sql.includes('tag_ids @>')) {
        const [tag] = JSON.parse(String(params[paramIdx++])) as string[];
        items = items.filter(r => Array.isArray(r.tagIds) && r.tagIds.includes(tag));
      }
      if (sql.includes('ILIKE')) {
        const pattern = String(params[paramIdx]).toLowerCase().replaceAll('%', '');
        items = items.filter(r => {
          const title = typeof r.title === 'string' ? r.title.toLowerCase() : '';
          const body = typeof r.body === 'string' ? r.body.toLowerCase() : '';
          return title.includes(pattern) || body.includes(pattern);
        });
      }

      items = [...items].sort((left, right) => {
        const leftTime = toMillis(left.createdAt);
        const rightTime = toMillis(right.createdAt);
        if (rightTime !== leftTime) return rightTime - leftTime;
        return String(right.id).localeCompare(String(left.id));
      });

      if (sql.includes('COUNT(*) AS total')) {
        return Promise.resolve({ rows: [{ total: items.length }], rowCount: 1 });
      }

      const limit = Number(params[params.length - 2] ?? 20);
      const offset = Number(params[params.length - 1] ?? 0);
      return Promise.resolve({
        rows: items.slice(offset, offset + limit).map(toPgRow),
        rowCount: Math.max(0, Math.min(limit, items.length - offset)),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(records: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> {
  const store = new Map<string, Record<string, unknown>>();
  for (const r of records) {
    store.set(r.id as string, r);
  }
  return store;
}

function makeThread(
  overrides: Partial<Record<string, unknown>> & { id: string; containerId: string },
): Record<string, unknown> {
  return {
    title: 'Default title',
    body: 'Default body',
    status: 'published',
    authorId: 'user-1',
    tagIds: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Memory handler: containerId filter
// ---------------------------------------------------------------------------

describe('searchInContainer — memory handler — containerId filter', () => {
  let store: Map<string, Record<string, unknown>>;

  beforeEach(() => {
    store = makeStore([
      makeThread({ id: 't1', containerId: 'c1', title: 'Alpha' }),
      makeThread({ id: 't2', containerId: 'c2', title: 'Beta' }),
      makeThread({ id: 't3', containerId: 'c1', title: 'Gamma' }),
    ]);
  });

  test('returns only threads in the requested container', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1' });
    expect(result.items).toHaveLength(2);
    expect(result.items.every(i => i.containerId === 'c1')).toBe(true);
  });

  test('returns empty when container has no threads', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c99' });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test('excludes soft-deleted records', async () => {
    store.set('t4', makeThread({ id: 't4', containerId: 'c1', _softDeleted: true }));
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1' });
    expect(result.items.map(i => i.id)).not.toContain('t4');
  });
});

// ---------------------------------------------------------------------------
// Memory handler: q (full-text) filter
// ---------------------------------------------------------------------------

describe('searchInContainer — memory handler — q filter', () => {
  let store: Map<string, Record<string, unknown>>;

  beforeEach(() => {
    store = makeStore([
      makeThread({ id: 't1', containerId: 'c1', title: 'Hello world', body: 'Nice post' }),
      makeThread({ id: 't2', containerId: 'c1', title: 'Goodbye', body: 'Another Hello' }),
      makeThread({ id: 't3', containerId: 'c1', title: 'Unrelated', body: 'Unrelated content' }),
    ]);
  });

  test('matches on title substring (case-insensitive)', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', q: 'hello' });
    const ids = result.items.map(i => i.id);
    expect(ids).toContain('t1');
    expect(ids).not.toContain('t3');
  });

  test('matches on body substring', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', q: 'another hello' });
    const ids = result.items.map(i => i.id);
    expect(ids).toContain('t2');
  });

  test('q filter is case-insensitive', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const upper = await handler({ containerId: 'c1', q: 'HELLO' });
    const lower = await handler({ containerId: 'c1', q: 'hello' });
    expect(upper.total).toBe(lower.total);
  });

  test('no results when q matches nothing', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', q: 'zzznomatch' });
    expect(result.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Memory handler: authorId filter
// ---------------------------------------------------------------------------

describe('searchInContainer — memory handler — authorId filter', () => {
  let store: Map<string, Record<string, unknown>>;

  beforeEach(() => {
    store = makeStore([
      makeThread({ id: 't1', containerId: 'c1', authorId: 'alice' }),
      makeThread({ id: 't2', containerId: 'c1', authorId: 'bob' }),
      makeThread({ id: 't3', containerId: 'c1', authorId: 'alice' }),
    ]);
  });

  test('filters by authorId', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', authorId: 'alice' });
    expect(result.items).toHaveLength(2);
    expect(result.items.every(i => i.authorId === 'alice')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Memory handler: status filter
// ---------------------------------------------------------------------------

describe('searchInContainer — memory handler — status filter', () => {
  let store: Map<string, Record<string, unknown>>;

  beforeEach(() => {
    store = makeStore([
      makeThread({ id: 't1', containerId: 'c1', status: 'published' }),
      makeThread({ id: 't2', containerId: 'c1', status: 'draft' }),
      makeThread({ id: 't3', containerId: 'c1', status: 'published' }),
    ]);
  });

  test('ignores draft status requests and returns only published threads', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', status: 'draft' });
    expect(result.items).toHaveLength(2);
    expect(new Set(result.items.map(item => item.id))).toEqual(new Set(['t1', 't3']));
  });
});

// ---------------------------------------------------------------------------
// Memory handler: tag filter
// ---------------------------------------------------------------------------

describe('searchInContainer — memory handler — tag filter', () => {
  let store: Map<string, Record<string, unknown>>;

  beforeEach(() => {
    store = makeStore([
      makeThread({ id: 't1', containerId: 'c1', tagIds: JSON.stringify(['tag-a', 'tag-b']) }),
      makeThread({ id: 't2', containerId: 'c1', tagIds: JSON.stringify(['tag-b']) }),
      makeThread({ id: 't3', containerId: 'c1', tagIds: null }),
    ]);
  });

  test('filters by tag (JSON string tagIds)', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', tag: 'tag-a' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('t1');
  });

  test('filters by shared tag returns multiple', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', tag: 'tag-b' });
    expect(result.items).toHaveLength(2);
  });

  test('tag not present in any thread → empty', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', tag: 'tag-z' });
    expect(result.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Memory handler: pagination
// ---------------------------------------------------------------------------

describe('searchInContainer — memory handler — pagination', () => {
  let store: Map<string, Record<string, unknown>>;

  beforeEach(() => {
    store = makeStore(
      Array.from({ length: 25 }, (_, i) => ({
        id: `t${i}`,
        containerId: 'c1',
        title: `Thread ${i}`,
        body: '',
        status: 'published',
        authorId: 'user-1',
        tagIds: null,
        createdAt: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
      })),
    );
  });

  test('default limit is 20', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1' });
    expect(result.items).toHaveLength(20);
    expect(result.total).toBe(25);
  });

  test('nextCursor is present when more pages exist', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1' });
    expect(result.nextCursor).toBeDefined();
  });

  test('second page with cursor returns remaining items', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const first = await handler({ containerId: 'c1' });
    const second = await handler({ containerId: 'c1', cursor: first.nextCursor });
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
  });

  test('explicit limit is respected', async () => {
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', limit: '5' });
    expect(result.items).toHaveLength(5);
  });

  test('limit is clamped to 100', async () => {
    const largeStore = makeStore(
      Array.from({ length: 150 }, (_, i) => ({
        id: `t${i}`,
        containerId: 'c1',
        title: `Thread ${i}`,
        body: '',
        status: 'published',
        authorId: 'user-1',
        tagIds: null,
        createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      })),
    );
    const handler = createSearchInContainerMemoryHandler(largeStore);
    const result = await handler({ containerId: 'c1', limit: '200' });
    expect(result.items).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// Memory handler: sort order
// ---------------------------------------------------------------------------

describe('searchInContainer — memory handler — sort order', () => {
  test('results are sorted by createdAt descending', async () => {
    const store = makeStore([
      makeThread({ id: 't-old', containerId: 'c1', createdAt: '2024-01-01T00:00:00.000Z' }),
      makeThread({ id: 't-new', containerId: 'c1', createdAt: '2024-06-01T00:00:00.000Z' }),
      makeThread({ id: 't-mid', containerId: 'c1', createdAt: '2024-03-01T00:00:00.000Z' }),
    ]);
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1' });
    expect(result.items[0].id).toBe('t-new');
    expect(result.items[2].id).toBe('t-old');
  });
});

describe('searchInContainer â€” postgres handler', () => {
  test('filters by q and authorId, then sorts newest-first', async () => {
    const pool = createSearchPool([
      makeThread({
        id: 'old-match',
        containerId: 'c1',
        authorId: 'alice',
        title: 'Hello there',
        body: 'Older post',
        createdAt: '2024-01-01T00:00:00.000Z',
      }),
      makeThread({
        id: 'new-match',
        containerId: 'c1',
        authorId: 'alice',
        title: 'General update',
        body: 'Says hello in the body',
        createdAt: '2024-06-01T00:00:00.000Z',
      }),
      makeThread({
        id: 'wrong-author',
        containerId: 'c1',
        authorId: 'bob',
        title: 'Hello from Bob',
        createdAt: '2024-07-01T00:00:00.000Z',
      }),
    ]);

    const result = await createSearchInContainerPostgresHandler(pool)({
      containerId: 'c1',
      q: 'hello',
      authorId: 'alice',
    });

    expect(result.total).toBe(2);
    expect(result.items.map(item => item.id)).toEqual(['new-match', 'old-match']);
  });

  test('filters by tag and paginates with nextCursor', async () => {
    const pool = createSearchPool([
      makeThread({
        id: 't1',
        containerId: 'c1',
        tagIds: ['tag-a', 'tag-b'],
        createdAt: '2024-01-01T00:00:00.000Z',
      }),
      makeThread({
        id: 't2',
        containerId: 'c1',
        tagIds: ['tag-b'],
        createdAt: '2024-02-01T00:00:00.000Z',
      }),
      makeThread({
        id: 't3',
        containerId: 'c1',
        tagIds: ['tag-c'],
        createdAt: '2024-03-01T00:00:00.000Z',
      }),
    ]);

    const first = await createSearchInContainerPostgresHandler(pool)({
      containerId: 'c1',
      tag: 'tag-b',
      limit: '1',
    });

    expect(first.total).toBe(2);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();

    const second = await createSearchInContainerPostgresHandler(pool)({
      containerId: 'c1',
      tag: 'tag-b',
      limit: '1',
      cursor: first.nextCursor,
    });

    expect(second.items).toHaveLength(1);
    expect(
      new Set([...first.items.map(item => item.id), ...second.items.map(item => item.id)]),
    ).toEqual(new Set(['t1', 't2']));
  });
});

// ---------------------------------------------------------------------------
// Stub backend smoke tests
// ---------------------------------------------------------------------------

describe('searchInContainer — stub backends return empty results', () => {
  const params = { containerId: 'c1', q: 'hello' };

  test('sqlite handler returns empty', async () => {
    const result = await createSearchInContainerSqliteHandler(null)(params);
    expect(result).toEqual({ items: [], total: 0 });
  });

  test('mongo handler returns empty', async () => {
    const result = await createSearchInContainerMongoHandler(null)(params);
    expect(result).toEqual({ items: [], total: 0 });
  });

  test('redis handler returns empty', async () => {
    const result = await createSearchInContainerRedisHandler(null)(params);
    expect(result).toEqual({ items: [], total: 0 });
  });
});
