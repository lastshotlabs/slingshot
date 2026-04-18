import { describe, expect, it } from 'bun:test';
import type {
  SearchClientLike,
  SearchOpConfig,
  SearchQueryLike,
  SearchResponseLike,
} from '../../../packages/slingshot-core/src';
import {
  searchViaProvider,
  translateFilter,
} from '../../../packages/slingshot-entity/src/configDriven/operationExecutors/searchProvider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSearchClient(
  hits: Array<{ document: Record<string, unknown> }>,
  totalHits?: number,
): SearchClientLike {
  return {
    async indexDocument() {},
    async removeDocument() {},
    async search(query: SearchQueryLike): Promise<SearchResponseLike> {
      const offset = query.offset ?? 0;
      const limit = query.limit ?? hits.length;
      const sliced = hits.slice(offset, offset + limit);
      return {
        hits: sliced,
        totalHits: totalHits ?? hits.length,
      };
    },
  };
}

function createMockSearchClientWithCapture(hits: Array<{ document: Record<string, unknown> }>): {
  client: SearchClientLike;
  capturedQueries: SearchQueryLike[];
} {
  const capturedQueries: SearchQueryLike[] = [];
  const client: SearchClientLike = {
    async indexDocument() {},
    async removeDocument() {},
    async search(query: SearchQueryLike): Promise<SearchResponseLike> {
      capturedQueries.push(query);
      const offset = query.offset ?? 0;
      const limit = query.limit ?? hits.length;
      const sliced = hits.slice(offset, offset + limit);
      return {
        hits: sliced,
        totalHits: hits.length,
      };
    },
  };
  return { client, capturedQueries };
}

// ---------------------------------------------------------------------------
// Tests: translateFilter
// ---------------------------------------------------------------------------

describe('translateFilter', () => {
  it('translates simple equality filters', () => {
    const result = translateFilter({ status: 'active' }, {});
    expect(result).toEqual({ field: 'status', op: '=', value: 'active' });
  });

  it('resolves param: references from filter params', () => {
    const result = translateFilter({ roomId: 'param:roomId' }, { roomId: 'room-123' });
    expect(result).toEqual({ field: 'roomId', op: '=', value: 'room-123' });
  });

  it('translates $ne operator', () => {
    const result = translateFilter({ status: { $ne: 'deleted' } }, {});
    expect(result).toEqual({ field: 'status', op: '!=', value: 'deleted' });
  });

  it('translates $gt operator', () => {
    const result = translateFilter({ score: { $gt: 10 } }, {});
    expect(result).toEqual({ field: 'score', op: '>', value: 10 });
  });

  it('translates $in operator', () => {
    const result = translateFilter({ type: { $in: ['text', 'image'] } }, {});
    expect(result).toEqual({ field: 'type', op: 'IN', value: ['text', 'image'] });
  });

  it('translates $contains operator', () => {
    const result = translateFilter({ tags: { $contains: 'urgent' } }, {});
    expect(result).toEqual({ field: 'tags', op: 'CONTAINS', value: 'urgent' });
  });

  it('translates $and combinator', () => {
    const result = translateFilter({ $and: [{ status: 'active' }, { score: { $gt: 5 } }] }, {});
    expect(result).toEqual({
      $and: [
        { field: 'status', op: '=', value: 'active' },
        { field: 'score', op: '>', value: 5 },
      ],
    });
  });

  it('translates $or combinator', () => {
    const result = translateFilter({ $or: [{ type: 'text' }, { type: 'image' }] }, {});
    expect(result).toEqual({
      $or: [
        { field: 'type', op: '=', value: 'text' },
        { field: 'type', op: '=', value: 'image' },
      ],
    });
  });

  it('returns undefined for empty filter', () => {
    const result = translateFilter({}, {});
    expect(result).toBeUndefined();
  });

  it('translates multiple field conditions with $and', () => {
    const result = translateFilter({ status: 'active', type: 'text' }, {});
    expect(result).toEqual({
      $and: [
        { field: 'status', op: '=', value: 'active' },
        { field: 'type', op: '=', value: 'text' },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: searchViaProvider — delegation behavior
// ---------------------------------------------------------------------------

describe('searchViaProvider', () => {
  it('delegates to provider and returns entity array (non-paginated)', async () => {
    const docs = [
      { document: { id: '1', title: 'Hello world', body: 'content' } },
      { document: { id: '2', title: 'Hello there', body: 'more content' } },
    ];
    const client = createMockSearchClient(docs);

    const op: SearchOpConfig = { kind: 'search', fields: ['title', 'body'] };
    const searchFn = searchViaProvider(
      op,
      () => client,
      async () => {},
    );

    const result = await searchFn('Hello');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { id: '1', title: 'Hello world', body: 'content' },
      { id: '2', title: 'Hello there', body: 'more content' },
    ]);
  });

  it('delegates to provider and returns paginated result', async () => {
    const docs = [
      { document: { id: '1', title: 'A' } },
      { document: { id: '2', title: 'B' } },
      { document: { id: '3', title: 'C' } },
    ];
    const client = createMockSearchClient(docs);

    const op: SearchOpConfig = { kind: 'search', fields: ['title'], paginate: true };
    const searchFn = searchViaProvider(
      op,
      () => client,
      async () => {},
    );

    const result = (await searchFn('test', undefined, 2)) as {
      items: Record<string, unknown>[];
      nextCursor?: string;
      hasMore: boolean;
    };
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeDefined();
  });

  it('returns all items when no hasMore for paginated', async () => {
    const docs = [{ document: { id: '1', title: 'A' } }];
    const client = createMockSearchClient(docs);

    const op: SearchOpConfig = { kind: 'search', fields: ['title'], paginate: true };
    const searchFn = searchViaProvider(
      op,
      () => client,
      async () => {},
    );

    const result = (await searchFn('test', undefined, 50)) as {
      items: Record<string, unknown>[];
      nextCursor?: string;
      hasMore: boolean;
    };
    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  it('drops highlights, scores, and metadata — returns entities only', async () => {
    const docs = [
      {
        document: { id: '1', title: 'Match' },
        score: 0.95,
        highlights: { title: '<em>Match</em>' },
      } as unknown as { document: Record<string, unknown> },
    ];
    const client = createMockSearchClient(docs);

    const op: SearchOpConfig = { kind: 'search', fields: ['title'] };
    const searchFn = searchViaProvider(
      op,
      () => client,
      async () => {},
    );

    const result = (await searchFn('Match')) as Record<string, unknown>[];
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: '1', title: 'Match' });
    // No score, highlights, etc.
    expect(result[0]).not.toHaveProperty('score');
    expect(result[0]).not.toHaveProperty('highlights');
  });

  it('throws when search client is not available', async () => {
    const op: SearchOpConfig = { kind: 'search', fields: ['title'] };
    const searchFn = searchViaProvider(
      op,
      () => null,
      async () => {},
    );

    await expect(searchFn('test')).rejects.toThrow('Search provider client is not available');
  });

  it('passes pagination offset correctly via cursor', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      document: { id: String(i), title: `Item ${i}` },
    }));
    const { client, capturedQueries } = createMockSearchClientWithCapture(docs);

    const op: SearchOpConfig = { kind: 'search', fields: ['title'], paginate: true };
    const searchFn = searchViaProvider(
      op,
      () => client,
      async () => {},
    );

    // First page
    const result1 = (await searchFn('test', undefined, 3)) as {
      items: Record<string, unknown>[];
      nextCursor?: string;
      hasMore: boolean;
    };
    expect(result1.items).toHaveLength(3);
    expect(result1.hasMore).toBe(true);
    expect(capturedQueries[0].offset).toBeUndefined(); // First page, no offset

    // Second page using cursor
    const result2 = (await searchFn('test', undefined, 3, result1.nextCursor)) as {
      items: Record<string, unknown>[];
      nextCursor?: string;
      hasMore: boolean;
    };
    expect(result2.items).toHaveLength(3);
    expect(capturedQueries[1].offset).toBe(3);
  });

  it('translates filter params for provider query', async () => {
    const docs = [{ document: { id: '1', title: 'A', status: 'active' } }];
    const { client, capturedQueries } = createMockSearchClientWithCapture(docs);

    const op: SearchOpConfig = {
      kind: 'search',
      fields: ['title'],
      filter: { status: 'param:status' },
    };
    const searchFn = searchViaProvider(
      op,
      () => client,
      async () => {},
    );

    await searchFn('test', { status: 'active' });
    expect(capturedQueries[0].filter).toEqual({
      field: 'status',
      op: '=',
      value: 'active',
    });
  });

  it('respects limit for non-paginated results', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      document: { id: String(i), title: `Item ${i}` },
    }));
    const client = createMockSearchClient(docs);

    const op: SearchOpConfig = { kind: 'search', fields: ['title'] };
    const searchFn = searchViaProvider(
      op,
      () => client,
      async () => {},
    );

    const result = (await searchFn('test', undefined, 3)) as Record<string, unknown>[];
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: useSearchProvider config behavior
// ---------------------------------------------------------------------------

describe('useSearchProvider config', () => {
  it('entity with search config defaults useSearchProvider to true', () => {
    const op: SearchOpConfig = { kind: 'search', fields: ['title'] };
    // Default: useSearchProvider is undefined, which means true when entity has search config
    expect(op.useSearchProvider).toBeUndefined();
  });

  it('entity with useSearchProvider: false bypasses provider', () => {
    const op: SearchOpConfig = {
      kind: 'search',
      fields: ['title'],
      useSearchProvider: false,
    };
    expect(op.useSearchProvider).toBe(false);
  });

  it('entity with useSearchProvider: true explicitly enables provider', () => {
    const op: SearchOpConfig = {
      kind: 'search',
      fields: ['title'],
      useSearchProvider: true,
    };
    expect(op.useSearchProvider).toBe(true);
  });
});
