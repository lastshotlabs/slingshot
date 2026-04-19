import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  createAlgoliaProvider,
  searchFilterToAlgoliaFilter,
} from '../../../packages/slingshot-search/src/providers/algolia';
import type { SearchIndexSettings } from '../../../packages/slingshot-search/src/types/provider';
import type { SearchFilter } from '../../../packages/slingshot-search/src/types/query';

// ============================================================================
// Filter translation tests
// ============================================================================

describe('searchFilterToAlgoliaFilter', () => {
  it('translates equality filter', () => {
    const filter: SearchFilter = { field: 'status', op: '=', value: 'published' };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('status:"published"');
  });

  it('translates inequality filter', () => {
    const filter: SearchFilter = { field: 'status', op: '!=', value: 'draft' };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('NOT status:"draft"');
  });

  it('translates greater-than filter', () => {
    const filter: SearchFilter = { field: 'price', op: '>', value: 100 };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('price > 100');
  });

  it('translates greater-than-or-equal filter', () => {
    const filter: SearchFilter = { field: 'price', op: '>=', value: 50 };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('price >= 50');
  });

  it('translates less-than filter', () => {
    const filter: SearchFilter = { field: 'price', op: '<', value: 200 };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('price < 200');
  });

  it('translates less-than-or-equal filter', () => {
    const filter: SearchFilter = { field: 'price', op: '<=', value: 300 };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('price <= 300');
  });

  it('translates IN filter with array', () => {
    const filter: SearchFilter = { field: 'tags', op: 'IN', value: ['a', 'b', 'c'] };
    const result = searchFilterToAlgoliaFilter(filter);
    expect(result).toBe('(tags:"a" OR tags:"b" OR tags:"c")');
  });

  it('translates NOT_IN filter with array', () => {
    const filter: SearchFilter = { field: 'tags', op: 'NOT_IN', value: ['x', 'y'] };
    const result = searchFilterToAlgoliaFilter(filter);
    expect(result).toBe('(NOT tags:"x" AND NOT tags:"y")');
  });

  it('translates EXISTS filter', () => {
    const filter: SearchFilter = { field: 'email', op: 'EXISTS', value: true };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('email:*');
  });

  it('translates NOT_EXISTS filter', () => {
    const filter: SearchFilter = { field: 'email', op: 'NOT_EXISTS', value: true };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('NOT email:*');
  });

  it('translates BETWEEN filter', () => {
    const filter: SearchFilter = {
      field: 'price',
      op: 'BETWEEN',
      value: [10, 50] as [number, number],
    };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('price:10 TO 50');
  });

  it('translates IS_EMPTY filter', () => {
    const filter: SearchFilter = { field: 'name', op: 'IS_EMPTY', value: true };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('NOT name:*');
  });

  it('translates IS_NOT_EMPTY filter', () => {
    const filter: SearchFilter = { field: 'name', op: 'IS_NOT_EMPTY', value: true };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('name:*');
  });

  it('translates $and compound filter', () => {
    const filter: SearchFilter = {
      $and: [
        { field: 'status', op: '=', value: 'active' },
        { field: 'price', op: '>', value: 10 },
      ],
    };
    const result = searchFilterToAlgoliaFilter(filter);
    expect(result).toBe('(status:"active") AND (price > 10)');
  });

  it('translates $or compound filter', () => {
    const filter: SearchFilter = {
      $or: [
        { field: 'status', op: '=', value: 'active' },
        { field: 'status', op: '=', value: 'pending' },
      ],
    };
    const result = searchFilterToAlgoliaFilter(filter);
    expect(result).toBe('(status:"active") OR (status:"pending")');
  });

  it('translates $not filter', () => {
    const filter: SearchFilter = {
      $not: { field: 'status', op: '=', value: 'deleted' },
    };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('NOT (status:"deleted")');
  });

  it('translates $geoRadius filter', () => {
    const filter: SearchFilter = {
      $geoRadius: { lat: 48.8566, lng: 2.3522, radiusMeters: 5000 },
    };
    expect(searchFilterToAlgoliaFilter(filter)).toBe(
      'aroundLatLng:48.8566,2.3522,aroundRadius:5000',
    );
  });

  it('translates numeric value with boolean', () => {
    const filter: SearchFilter = { field: 'active', op: '=', value: true };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('active:true');
  });

  it('escapes double quotes in string values', () => {
    const filter: SearchFilter = { field: 'name', op: '=', value: 'hello "world"' };
    expect(searchFilterToAlgoliaFilter(filter)).toBe('name:"hello \\"world\\""');
  });
});

// ============================================================================
// Provider HTTP integration tests (mocked fetch)
// ============================================================================

describe('createAlgoliaProvider', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createProvider() {
    return createAlgoliaProvider({
      provider: 'algolia',
      applicationId: 'test-app-id',
      apiKey: 'test-search-key',
      adminApiKey: 'test-admin-key',
      timeoutMs: 5000,
      retries: 0,
    });
  }

  it('sets Algolia auth headers on requests', async () => {
    const provider = createProvider();
    await provider.connect();

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Algolia-Application-Id']).toBe('test-app-id');
    // Admin key used for management operations
    expect(headers['X-Algolia-API-Key']).toBe('test-admin-key');
  });

  it('connect calls /1/indexes', async () => {
    const provider = createProvider();
    await provider.connect();

    const call = fetchMock.mock.calls[0];
    expect(call[0] as string).toContain('/1/indexes');
  });

  it('uses correct Algolia host', async () => {
    const provider = createProvider();
    await provider.connect();

    const call = fetchMock.mock.calls[0];
    expect(call[0] as string).toContain('test-app-id-dsn.algolia.net');
  });

  it('healthCheck returns healthy status', async () => {
    const provider = createProvider();
    const result = await provider.healthCheck();

    expect(result.healthy).toBe(true);
    expect(result.provider).toBe('algolia');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('healthCheck returns unhealthy on error', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('Connection refused')));

    const provider = createProvider();
    const result = await provider.healthCheck();

    expect(result.healthy).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('createOrUpdateIndex sends settings to Algolia', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ taskID: 123, updatedAt: '2024-01-01T00:00:00Z' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const provider = createProvider();
    const settings: SearchIndexSettings = {
      searchableFields: ['title', 'body'],
      filterableFields: ['status'],
      sortableFields: ['createdAt'],
      facetableFields: ['category'],
    };

    const task = await provider.createOrUpdateIndex('test_index', settings);

    const call = fetchMock.mock.calls[0];
    expect(call[0] as string).toContain('/1/indexes/test_index/settings');
    expect((call[1] as RequestInit).method).toBe('PUT');

    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.searchableAttributes).toEqual(['title', 'body']);
    expect(body.attributesForFaceting).toBeDefined();

    // filterOnly for filterable-only fields
    expect(body.attributesForFaceting).toContain('filterOnly(status)');
    // Facetable fields without filterOnly prefix
    expect(body.attributesForFaceting).toContain('category');

    expect(task).toBeDefined();
    expect(task!.taskId).toBe(123);
  });

  it('search posts to /query endpoint with search key', async () => {
    fetchMock.mockImplementation(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            hits: [
              {
                objectID: '1',
                title: 'Test',
                _highlightResult: {
                  title: { value: '<em>Test</em>', matchLevel: 'full', matchedWords: ['test'] },
                },
              },
            ],
            nbHits: 1,
            page: 0,
            nbPages: 1,
            hitsPerPage: 20,
            processingTimeMS: 3,
            query: 'test',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });

    const provider = createProvider();
    const result = await provider.search('test_index', {
      q: 'test',
      highlight: { fields: ['title'] },
    });

    expect(result.totalHits).toBe(1);
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].document).toHaveProperty('id', '1');
    expect(result.hits[0].document).toHaveProperty('title', 'Test');
    expect(result.hits[0].highlights).toEqual({ title: '<em>Test</em>' });
    expect(result.query).toBe('test');

    // Should use search key (not admin key) for search
    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Algolia-API-Key']).toBe('test-search-key');
  });

  it('search handles page-based pagination (0-indexed to 1-indexed)', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            hits: [],
            nbHits: 100,
            page: 1,
            nbPages: 5,
            hitsPerPage: 20,
            processingTimeMS: 2,
            query: 'test',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const provider = createProvider();
    const result = await provider.search('test_index', {
      q: 'test',
      page: 2,
      hitsPerPage: 20,
    });

    // Our API is 1-indexed, Algolia is 0-indexed
    // We send page-1=1, Algolia returns page=1, we map back to page=2
    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(5);

    // Check that we sent page=1 (0-indexed) to Algolia
    const call = fetchMock.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.page).toBe(1);
  });

  it('indexDocuments sends batch request', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ taskID: 456 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const provider = createProvider();
    const task = await provider.indexDocuments(
      'test_index',
      [
        { id: '1', title: 'Doc 1' },
        { id: '2', title: 'Doc 2' },
      ],
      'id',
    );

    const call = fetchMock.mock.calls[0];
    expect(call[0] as string).toContain('/1/indexes/test_index/batch');

    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0].action).toBe('addObject');
    expect(body.requests[0].body.objectID).toBe('1');
    expect(body.requests[1].body.objectID).toBe('2');

    expect(task).toBeDefined();
    expect(task!.taskId).toBe(456);
  });

  it('deleteDocuments sends batch delete', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ taskID: 789 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const provider = createProvider();
    await provider.deleteDocuments('test_index', ['1', '2']);

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0].action).toBe('deleteObject');
    expect(body.requests[0].body.objectID).toBe('1');
  });

  it('multiSearch uses /1/indexes/*/queries endpoint', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                hits: [],
                nbHits: 0,
                page: 0,
                nbPages: 0,
                hitsPerPage: 20,
                processingTimeMS: 1,
                query: 'foo',
              },
              {
                hits: [],
                nbHits: 0,
                page: 0,
                nbPages: 0,
                hitsPerPage: 20,
                processingTimeMS: 1,
                query: 'bar',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const provider = createProvider();
    const results = await provider.multiSearch([
      { indexName: 'idx1', query: { q: 'foo' } },
      { indexName: 'idx2', query: { q: 'bar' } },
    ]);

    expect(results.length).toBe(2);

    const call = fetchMock.mock.calls[0];
    expect(call[0] as string).toContain('/1/indexes/*/queries');
  });

  it('suggest returns suggestions from search results', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            hits: [
              {
                objectID: '1',
                title: 'Testing autocomplete',
                _highlightResult: {
                  title: {
                    value: '<em>Test</em>ing autocomplete',
                    matchLevel: 'partial',
                    matchedWords: ['test'],
                  },
                },
              },
            ],
            nbHits: 1,
            page: 0,
            nbPages: 1,
            hitsPerPage: 5,
            processingTimeMS: 2,
            query: 'test',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const provider = createProvider();
    const result = await provider.suggest('test_index', {
      q: 'test',
      highlight: true,
      fields: ['title'],
    });

    expect(result.suggestions.length).toBe(1);
    expect(result.suggestions[0].text).toBe('Testing autocomplete');
    expect(result.suggestions[0].highlight).toBe('<em>Test</em>ing autocomplete');
  });

  it('listIndexes returns formatted index list', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              { name: 'index1', entries: 100, updatedAt: '2024-01-01T00:00:00Z' },
              { name: 'index2', entries: 50, updatedAt: '2024-01-02T00:00:00Z' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const provider = createProvider();
    const indexes = await provider.listIndexes();

    expect(indexes.length).toBe(2);
    expect(indexes[0].name).toBe('index1');
    expect(indexes[0].documentCount).toBe(100);
    expect(indexes[1].name).toBe('index2');
  });
});
