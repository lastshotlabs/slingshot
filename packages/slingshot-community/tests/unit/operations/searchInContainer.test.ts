import { describe, expect, test } from 'bun:test';
import {
  type SearchInContainerParams,
  createSearchInContainerMemoryHandler,
} from '../../../src/operations/searchInContainer';

function makeThread(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `thread-${Math.random().toString(36).slice(2, 8)}`,
    containerId: 'c1',
    title: '',
    body: '',
    authorId: 'author-1',
    status: 'published',
    createdAt: new Date().toISOString(),
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

describe('searchInContainer (memory handler)', () => {
  test('filters by containerId', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', title: 'Hello' }),
      makeThread({ id: 't2', containerId: 'c2', title: 'Hello' }),
    ]);
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1' });
    expect(result.total).toBe(1);
    expect(result.items[0]!.id).toBe('t1');
  });

  test('case-insensitive substring search on title', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', title: 'Hello World' }),
      makeThread({ id: 't2', containerId: 'c1', title: 'Goodbye World' }),
      makeThread({ id: 't3', containerId: 'c1', title: 'Testing' }),
    ]);
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', q: 'world' });
    expect(result.total).toBe(2);
  });

  test('case-insensitive substring search on body', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', title: 'Title', body: 'Found the answer here' }),
      makeThread({ id: 't2', containerId: 'c1', title: 'Title', body: 'Nothing relevant' }),
    ]);
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', q: 'ANSWER' });
    expect(result.total).toBe(1);
    expect(result.items[0]!.id).toBe('t1');
  });

  test('filters by status', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', status: 'published' }),
      makeThread({ id: 't2', containerId: 'c1', status: 'draft' }),
    ]);
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', status: 'published' });
    expect(result.total).toBe(1);
    expect(result.items[0]!.id).toBe('t1');
  });

  test('filters by authorId', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', authorId: 'user-1' }),
      makeThread({ id: 't2', containerId: 'c1', authorId: 'user-2' }),
    ]);
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', authorId: 'user-1' });
    expect(result.total).toBe(1);
    expect(result.items[0]!.id).toBe('t1');
  });

  test('filters by tag in tagIds array field', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', tagIds: ['tag-1', 'tag-2'] }),
      makeThread({ id: 't2', containerId: 'c1', tagIds: ['tag-3'] }),
      makeThread({ id: 't3', containerId: 'c1', tagIds: JSON.stringify(['tag-1']) }),
    ]);
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', tag: 'tag-1' });
    expect(result.total).toBe(2);
  });

  test('handles null tagIds gracefully', async () => {
    const store = buildStore([makeThread({ id: 't1', containerId: 'c1', tagIds: null })]);
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', tag: 'tag-1' });
    expect(result.total).toBe(0);
  });

  test('combines multiple filters', async () => {
    const store = buildStore([
      makeThread({
        id: 't1',
        containerId: 'c1',
        status: 'published',
        authorId: 'user-1',
        title: 'Matching title',
      }),
      makeThread({
        id: 't2',
        containerId: 'c1',
        status: 'published',
        authorId: 'user-2',
        title: 'Matching title',
      }),
      makeThread({
        id: 't3',
        containerId: 'c1',
        status: 'draft',
        authorId: 'user-1',
        title: 'Matching title',
      }),
    ]);
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({
      containerId: 'c1',
      status: 'published',
      authorId: 'user-1',
      q: 'matching',
    });
    expect(result.total).toBe(1);
    expect(result.items[0]!.id).toBe('t1');
  });

  test('results are ordered by createdAt descending', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1', createdAt: '2024-01-01T00:00:00Z' }),
      makeThread({ id: 't2', containerId: 'c1', createdAt: '2024-06-01T00:00:00Z' }),
      makeThread({ id: 't3', containerId: 'c1', createdAt: '2024-03-01T00:00:00Z' }),
    ]);
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1' });
    expect(result.items[0]!.id).toBe('t2');
    expect(result.items[1]!.id).toBe('t3');
    expect(result.items[2]!.id).toBe('t1');
  });

  test('pagination works correctly', async () => {
    const threads = Array.from({ length: 5 }, (_, i) =>
      makeThread({
        id: `t${i}`,
        containerId: 'c1',
        createdAt: new Date(2024, 0, 5 - i).toISOString(),
      }),
    );
    const store = buildStore(threads);
    const handler = createSearchInContainerMemoryHandler(store);

    const page1 = await handler({ containerId: 'c1', limit: '2' });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await handler({ containerId: 'c1', limit: '2', cursor: page1.nextCursor });
    expect(page2.items.length).toBe(2);

    // No overlap between pages
    const page1Ids = page1.items.map(i => i.id);
    const page2Ids = page2.items.map(i => i.id);
    for (const id of page1Ids) {
      expect(page2Ids).not.toContain(id);
    }
  });

  test('excludes soft-deleted threads', async () => {
    const store = buildStore([
      makeThread({ id: 't1', containerId: 'c1' }),
      makeThread({ id: 't2', containerId: 'c1', _softDeleted: true }),
      makeThread({ id: 't3', containerId: 'c1', _deleted: true }),
    ]);
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1' });
    expect(result.total).toBe(1);
    expect(result.items[0]!.id).toBe('t1');
  });

  test('returns empty results when no matches', async () => {
    const store = buildStore([makeThread({ id: 't1', containerId: 'c1', title: 'Hello' })]);
    const handler = createSearchInContainerMemoryHandler(store);
    const result = await handler({ containerId: 'c1', q: 'nonexistent' });
    expect(result.total).toBe(0);
    expect(result.items.length).toBe(0);
    expect(result.nextCursor).toBeUndefined();
  });
});
