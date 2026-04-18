/**
 * Integration tests for the `listByContainerSorted` custom operation.
 *
 * Verifies each sort preset returns the correct ordering against the memory
 * handler, and smoke-tests stub backends.
 */
import { describe, expect, test } from 'bun:test';
import {
  createListSortedMemoryHandler,
  createListSortedMongoHandler,
  createListSortedPostgresHandler,
  createListSortedRedisHandler,
  createListSortedSqliteHandler,
} from '../../src/operations/listByContainerSorted';

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

function createListPool(records: Array<Record<string, unknown>>) {
  return {
    query(sql: string, params: unknown[] = []) {
      let paramIdx = 0;
      const containerId = params[paramIdx++];
      let items = records.filter(r => r.containerId === containerId);

      if (sql.includes('created_at >=')) {
        const cutoff = toMillis(params[paramIdx]);
        items = items.filter(r => toMillis(r.createdAt) >= cutoff);
      }

      if (sql.includes('COALESCE(last_activity_at, created_at) DESC')) {
        items = [...items].sort((left, right) => {
          const leftValue = left.lastActivityAt ?? left.createdAt;
          const rightValue = right.lastActivityAt ?? right.createdAt;
          const leftTime = toMillis(leftValue);
          const rightTime = toMillis(rightValue);
          if (rightTime !== leftTime) return rightTime - leftTime;
          return String(right.id).localeCompare(String(left.id));
        });
      } else if (sql.includes('score DESC')) {
        items = [...items].sort((left, right) => {
          const leftScore = Number(left.score ?? 0);
          const rightScore = Number(right.score ?? 0);
          if (rightScore !== leftScore) return rightScore - leftScore;
          const leftTime = toMillis(left.createdAt);
          const rightTime = toMillis(right.createdAt);
          if (rightTime !== leftTime) return rightTime - leftTime;
          return String(right.id).localeCompare(String(left.id));
        });
      } else {
        items = [...items].sort((left, right) => {
          const leftTime = toMillis(left.createdAt);
          const rightTime = toMillis(right.createdAt);
          if (rightTime !== leftTime) return rightTime - leftTime;
          return String(right.id).localeCompare(String(left.id));
        });
      }

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
  for (const r of records) store.set(r.id as string, r);
  return store;
}

const BASE_EPOCH = 1_700_000_000_000; // ms

function buildThreads() {
  const now = BASE_EPOCH;
  return makeStore([
    {
      id: 'oldest',
      containerId: 'c1',
      createdAt: new Date(now - 7_200_000).toISOString(), // -2h
      lastActivityAt: new Date(now - 1_000).toISOString(), // very recent activity
      score: 5,
    },
    {
      id: 'middle',
      containerId: 'c1',
      createdAt: new Date(now - 3_600_000).toISOString(), // -1h
      lastActivityAt: new Date(now - 5_000_000).toISOString(),
      score: 20,
    },
    {
      id: 'newest',
      containerId: 'c1',
      createdAt: new Date(now).toISOString(), // now
      lastActivityAt: new Date(now - 600_000).toISOString(),
      score: 1,
    },
  ]);
}

// ---------------------------------------------------------------------------
// sort=new (default)
// ---------------------------------------------------------------------------

describe('listByContainerSorted — sort=new', () => {
  test('returns threads newest-first', async () => {
    const handler = createListSortedMemoryHandler(buildThreads());
    const result = await handler({ containerId: 'c1', sort: 'new' });
    const ids = result.items.map(i => i.id);
    expect(ids[0]).toBe('newest');
    expect(ids[ids.length - 1]).toBe('oldest');
  });

  test('default (no sort param) behaves as new', async () => {
    const handler = createListSortedMemoryHandler(buildThreads());
    const withSort = await handler({ containerId: 'c1', sort: 'new' });
    const noSort = await handler({ containerId: 'c1' });
    expect(withSort.items.map(i => i.id)).toEqual(noSort.items.map(i => i.id));
  });
});

// ---------------------------------------------------------------------------
// sort=active
// ---------------------------------------------------------------------------

describe('listByContainerSorted — sort=active', () => {
  test('orders by lastActivityAt descending', async () => {
    const handler = createListSortedMemoryHandler(buildThreads());
    const result = await handler({ containerId: 'c1', sort: 'active' });
    // oldest thread has most recent activity
    expect(result.items[0].id).toBe('oldest');
  });

  test('falls back to createdAt when lastActivityAt is absent', async () => {
    const store = makeStore([
      {
        id: 'a',
        containerId: 'c1',
        createdAt: new Date(BASE_EPOCH - 1000).toISOString(),
        score: 0,
      },
      {
        id: 'b',
        containerId: 'c1',
        createdAt: new Date(BASE_EPOCH).toISOString(),
        score: 0,
      },
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'active' });
    expect(result.items[0].id).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// sort=hot
// ---------------------------------------------------------------------------

describe('listByContainerSorted — sort=hot', () => {
  test('orders by score desc, then createdAt desc as tiebreaker', async () => {
    const handler = createListSortedMemoryHandler(buildThreads());
    const result = await handler({ containerId: 'c1', sort: 'hot' });
    expect(result.items[0].id).toBe('middle'); // score=20 wins
  });

  test('tiebreaker: among equal scores, newest first', async () => {
    const store = makeStore([
      {
        id: 'old',
        containerId: 'c1',
        score: 10,
        createdAt: new Date(BASE_EPOCH - 1000).toISOString(),
      },
      { id: 'new', containerId: 'c1', score: 10, createdAt: new Date(BASE_EPOCH).toISOString() },
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'hot' });
    expect(result.items[0].id).toBe('new');
  });
});

// ---------------------------------------------------------------------------
// sort=top
// ---------------------------------------------------------------------------

describe('listByContainerSorted — sort=top', () => {
  test('orders by score desc', async () => {
    const handler = createListSortedMemoryHandler(buildThreads());
    const result = await handler({ containerId: 'c1', sort: 'top' });
    expect(result.items[0].id).toBe('middle'); // score=20 wins
  });

  test('window=24h excludes old threads', async () => {
    const store = makeStore([
      {
        id: 'recent',
        containerId: 'c1',
        score: 1,
        createdAt: new Date(Date.now() - 3_600_000).toISOString(), // 1h ago
      },
      {
        id: 'old',
        containerId: 'c1',
        score: 100,
        createdAt: new Date(Date.now() - 48 * 3_600_000).toISOString(), // 2d ago
      },
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'top', window: '24h' });
    const ids = result.items.map(i => i.id);
    expect(ids).toContain('recent');
    expect(ids).not.toContain('old');
  });

  test('window=all includes all threads regardless of age', async () => {
    const store = makeStore([
      {
        id: 'ancient',
        containerId: 'c1',
        score: 5,
        createdAt: new Date(Date.now() - 365 * 86_400_000).toISOString(),
      },
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'top', window: 'all' });
    expect(result.items.map(i => i.id)).toContain('ancient');
  });
});

// ---------------------------------------------------------------------------
// sort=controversial
// ---------------------------------------------------------------------------

describe('listByContainerSorted — sort=controversial', () => {
  test('orders by score desc', async () => {
    const store = makeStore([
      { id: 'a', containerId: 'c1', score: 5, createdAt: new Date().toISOString() },
      { id: 'b', containerId: 'c1', score: 99, createdAt: new Date().toISOString() },
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'controversial' });
    expect(result.items[0].id).toBe('b');
  });

  test('window=7d excludes old content', async () => {
    const store = makeStore([
      {
        id: 'within',
        containerId: 'c1',
        score: 1,
        createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), // 3d ago
      },
      {
        id: 'outside',
        containerId: 'c1',
        score: 100,
        createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), // 10d ago
      },
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'controversial', window: '7d' });
    expect(result.items.map(i => i.id)).not.toContain('outside');
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('listByContainerSorted — pagination', () => {
  test('default limit is 20', async () => {
    const store = makeStore(
      Array.from({ length: 30 }, (_, i) => ({
        id: `t${i}`,
        containerId: 'c1',
        score: i,
        createdAt: new Date(BASE_EPOCH + i * 1000).toISOString(),
      })),
    );
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1' });
    expect(result.items).toHaveLength(20);
    expect(result.total).toBe(30);
    expect(result.nextCursor).toBeDefined();
  });

  test('cursor advances to next page', async () => {
    const store = makeStore(
      Array.from({ length: 25 }, (_, i) => ({
        id: `t${i}`,
        containerId: 'c1',
        score: 0,
        createdAt: new Date(BASE_EPOCH + i * 1000).toISOString(),
      })),
    );
    const handler = createListSortedMemoryHandler(store);
    const page1 = await handler({ containerId: 'c1', limit: '10' });
    expect(page1.items).toHaveLength(10);
    const page2 = await handler({ containerId: 'c1', limit: '10', cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(10);
    // No overlap
    const ids1 = new Set(page1.items.map(i => i.id));
    const ids2 = page2.items.map(i => i.id);
    expect(ids2.some(id => ids1.has(id))).toBe(false);
  });
});

describe('listByContainerSorted â€” postgres handler', () => {
  test('sort=active orders by lastActivityAt descending', async () => {
    const pool = createListPool(Array.from(buildThreads().values()));
    const result = await createListSortedPostgresHandler(pool)({
      containerId: 'c1',
      sort: 'active',
    });
    expect(result.items[0].id).toBe('oldest');
  });

  test('sort=top with window=24h excludes older threads', async () => {
    const now = Date.now();
    const pool = createListPool([
      {
        id: 'recent',
        containerId: 'c1',
        score: 1,
        createdAt: new Date(now - 3_600_000).toISOString(),
      },
      {
        id: 'old',
        containerId: 'c1',
        score: 100,
        createdAt: new Date(now - 48 * 3_600_000).toISOString(),
      },
    ]);

    const result = await createListSortedPostgresHandler(pool)({
      containerId: 'c1',
      sort: 'top',
      window: '24h',
    });

    expect(result.items.map(item => item.id)).toEqual(['recent']);
  });

  test('supports cursor pagination', async () => {
    const pool = createListPool(
      Array.from({ length: 25 }, (_, i) => ({
        id: `t${i}`,
        containerId: 'c1',
        score: i,
        createdAt: new Date(BASE_EPOCH + i * 1000).toISOString(),
      })),
    );

    const first = await createListSortedPostgresHandler(pool)({
      containerId: 'c1',
      sort: 'new',
      limit: '10',
    });
    const second = await createListSortedPostgresHandler(pool)({
      containerId: 'c1',
      sort: 'new',
      limit: '10',
      cursor: first.nextCursor,
    });

    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(10);
    expect(
      second.items.some(item => first.items.map(firstItem => firstItem.id).includes(item.id)),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stub backend smoke tests
// ---------------------------------------------------------------------------

describe('listByContainerSorted — stub backends return empty results', () => {
  const params = { containerId: 'c1', sort: 'new' };

  test('sqlite handler returns empty', async () => {
    const result = await createListSortedSqliteHandler(null)(params);
    expect(result).toEqual({ items: [], total: 0 });
  });

  test('mongo handler returns empty', async () => {
    const result = await createListSortedMongoHandler(null)(params);
    expect(result).toEqual({ items: [], total: 0 });
  });

  test('redis handler returns empty', async () => {
    const result = await createListSortedRedisHandler(null)(params);
    expect(result).toEqual({ items: [], total: 0 });
  });
});
