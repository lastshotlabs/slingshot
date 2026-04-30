import { describe, expect, test } from 'bun:test';
import {
  type ListSortedParams,
  createListSortedMemoryHandler,
} from '../../../src/operations/listByContainerSorted';

function makeThread(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `thread-${Math.random().toString(36).slice(2, 8)}`,
    containerId: 'c1',
    createdAt: new Date().toISOString(),
    score: 0,
    ...overrides,
  };
}

function buildStore(threads: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const store = new Map<string, Record<string, unknown>>();
  for (const t of threads) {
    store.set(t.id as string, t);
  }
  return store;
}

describe('listByContainerSorted (memory handler)', () => {
  test('filters by containerId', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1' }),
      makeThread({ id: 't2', containerId: 'c2' }),
      makeThread({ id: 't3', containerId: 'c1' }),
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1' });
    expect(result.total).toBe(2);
    expect(result.items.every(i => i.containerId === 'c1')).toBe(true);
  });

  test('sort=new orders by createdAt desc', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', createdAt: '2024-01-01T00:00:00Z' }),
      makeThread({ id: 't2', containerId: 'c1', createdAt: '2024-03-01T00:00:00Z' }),
      makeThread({ id: 't3', containerId: 'c1', createdAt: '2024-02-01T00:00:00Z' }),
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'new' });
    expect(result.items[0]!.id).toBe('t2');
    expect(result.items[1]!.id).toBe('t3');
    expect(result.items[2]!.id).toBe('t1');
  });

  test('sort=active orders by lastActivityAt desc', async () => {
    const store = buildStore([
      makeThread({
        id: 't1',
        containerId: 'c1',
        createdAt: '2024-01-01T00:00:00Z',
        lastActivityAt: '2024-04-01T00:00:00Z',
      }),
      makeThread({
        id: 't2',
        containerId: 'c1',
        createdAt: '2024-03-01T00:00:00Z',
        lastActivityAt: '2024-03-01T00:00:00Z',
      }),
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'active' });
    expect(result.items[0]!.id).toBe('t1');
    expect(result.items[1]!.id).toBe('t2');
  });

  test('sort=hot orders by score desc then createdAt desc', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', score: 5, createdAt: '2024-01-01T00:00:00Z' }),
      makeThread({ id: 't2', containerId: 'c1', score: 10, createdAt: '2024-01-01T00:00:00Z' }),
      makeThread({ id: 't3', containerId: 'c1', score: 5, createdAt: '2024-06-01T00:00:00Z' }),
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'hot' });
    expect(result.items[0]!.id).toBe('t2');
    // Among equal scores, t3 (newer) comes before t1
    expect(result.items[1]!.id).toBe('t3');
    expect(result.items[2]!.id).toBe('t1');
  });

  test('sort=top orders by score desc', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', score: 1 }),
      makeThread({ id: 't2', containerId: 'c1', score: 100 }),
      makeThread({ id: 't3', containerId: 'c1', score: 50 }),
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'top' });
    expect(result.items[0]!.id).toBe('t2');
    expect(result.items[1]!.id).toBe('t3');
    expect(result.items[2]!.id).toBe('t1');
  });

  test('window=24h filters threads older than 24 hours for sort=top', async () => {
    const recent = new Date(Date.now() - 3_600_000).toISOString(); // 1h ago
    const old = new Date(Date.now() - 100_000_000).toISOString(); // > 24h ago
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', score: 100, createdAt: old }),
      makeThread({ id: 't2', containerId: 'c1', score: 50, createdAt: recent }),
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'top', window: '24h' });
    expect(result.total).toBe(1);
    expect(result.items[0]!.id).toBe('t2');
  });

  test('window=all does not filter any threads', async () => {
    const old = new Date(Date.now() - 100_000_000_000).toISOString();
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', score: 10, createdAt: old }),
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'top', window: 'all' });
    expect(result.total).toBe(1);
  });

  test('pagination with limit and cursor', async () => {
    const threads = Array.from({ length: 5 }, (_, i) =>
      makeThread({
        id: `t${i}`,
        containerId: 'c1',
        createdAt: new Date(2024, 0, 5 - i).toISOString(),
      }),
    );
    const store = buildStore(threads);
    const handler = createListSortedMemoryHandler(store);

    const page1 = await handler({ containerId: 'c1', sort: 'new', limit: '2' });
    expect(page1.items.length).toBe(2);
    expect(page1.total).toBe(5);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await handler({
      containerId: 'c1',
      sort: 'new',
      limit: '2',
      cursor: page1.nextCursor,
    });
    expect(page2.items.length).toBe(2);
    expect(page2.nextCursor).toBeDefined();

    const page3 = await handler({
      containerId: 'c1',
      sort: 'new',
      limit: '2',
      cursor: page2.nextCursor,
    });
    expect(page3.items.length).toBe(1);
    expect(page3.nextCursor).toBeUndefined();
  });

  test('defaults to sort=new when sort value is invalid', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', createdAt: '2024-01-01T00:00:00Z' }),
      makeThread({ id: 't2', containerId: 'c1', createdAt: '2024-06-01T00:00:00Z' }),
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1', sort: 'invalid' });
    expect(result.items[0]!.id).toBe('t2');
  });

  test('excludes soft-deleted threads', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1' }),
      makeThread({ id: 't2', containerId: 'c1', _softDeleted: true }),
      makeThread({ id: 't3', containerId: 'c1', _deleted: true }),
    ]);
    const handler = createListSortedMemoryHandler(store);
    const result = await handler({ containerId: 'c1' });
    expect(result.total).toBe(1);
    expect(result.items[0]!.id).toBe('t1');
  });
});
