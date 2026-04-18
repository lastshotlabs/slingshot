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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeStore(records) {
  const store = new Map();
  for (const r of records) store.set(r.id, r);
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
// ---------------------------------------------------------------------------
// Stub backend smoke tests
// ---------------------------------------------------------------------------
describe('listByContainerSorted — stub backends return empty results', () => {
  const params = { containerId: 'c1', sort: 'new' };
  test('sqlite handler returns empty', async () => {
    const result = await createListSortedSqliteHandler(null)(params);
    expect(result).toEqual({ items: [], total: 0 });
  });
  test('postgres handler returns empty', async () => {
    const result = await createListSortedPostgresHandler(null)(params);
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
