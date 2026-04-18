import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  createTypesenseProvider,
  searchFilterToTypesenseFilter,
} from '../../../packages/slingshot-search/src/providers/typesense';
import type { SearchIndexSettings } from '../../../packages/slingshot-search/src/types/provider';
import type { SearchFilter } from '../../../packages/slingshot-search/src/types/query';

// ============================================================================
// Filter translation tests
// ============================================================================

describe('searchFilterToTypesenseFilter', () => {
  it('translates equality filter', () => {
    const filter: SearchFilter = { field: 'status', op: '=', value: 'published' };
    expect(searchFilterToTypesenseFilter(filter)).toBe('status:=`published`');
  });

  it('translates inequality filter', () => {
    const filter: SearchFilter = { field: 'status', op: '!=', value: 'draft' };
    expect(searchFilterToTypesenseFilter(filter)).toBe('status:!=`draft`');
  });

  it('translates greater-than filter', () => {
    const filter: SearchFilter = { field: 'price', op: '>', value: 100 };
    expect(searchFilterToTypesenseFilter(filter)).toBe('price:>100');
  });

  it('translates greater-than-or-equal filter', () => {
    const filter: SearchFilter = { field: 'price', op: '>=', value: 50 };
    expect(searchFilterToTypesenseFilter(filter)).toBe('price:>=50');
  });

  it('translates less-than filter', () => {
    const filter: SearchFilter = { field: 'price', op: '<', value: 200 };
    expect(searchFilterToTypesenseFilter(filter)).toBe('price:<200');
  });

  it('translates less-than-or-equal filter', () => {
    const filter: SearchFilter = { field: 'price', op: '<=', value: 300 };
    expect(searchFilterToTypesenseFilter(filter)).toBe('price:<=300');
  });

  it('translates IN filter with array', () => {
    const filter: SearchFilter = { field: 'tags', op: 'IN', value: ['a', 'b', 'c'] };
    expect(searchFilterToTypesenseFilter(filter)).toBe('tags:[`a`,`b`,`c`]');
  });

  it('translates NOT_IN filter with array', () => {
    const filter: SearchFilter = { field: 'tags', op: 'NOT_IN', value: ['x', 'y'] };
    expect(searchFilterToTypesenseFilter(filter)).toBe('tags:!=[`x`,`y`]');
  });

  it('translates EXISTS filter', () => {
    const filter: SearchFilter = { field: 'email', op: 'EXISTS', value: true };
    expect(searchFilterToTypesenseFilter(filter)).toBe('email:!=null');
  });

  it('translates NOT_EXISTS filter', () => {
    const filter: SearchFilter = { field: 'email', op: 'NOT_EXISTS', value: true };
    expect(searchFilterToTypesenseFilter(filter)).toBe('email:=null');
  });

  it('translates BETWEEN filter', () => {
    const filter: SearchFilter = {
      field: 'price',
      op: 'BETWEEN',
      value: [10, 50] as [number, number],
    };
    expect(searchFilterToTypesenseFilter(filter)).toBe('price:[10..50]');
  });

  it('translates $and compound filter', () => {
    const filter: SearchFilter = {
      $and: [
        { field: 'status', op: '=', value: 'active' },
        { field: 'price', op: '>', value: 10 },
      ],
    };
    const result = searchFilterToTypesenseFilter(filter);
    expect(result).toBe('(status:=`active`) && (price:>10)');
  });

  it('translates $or compound filter', () => {
    const filter: SearchFilter = {
      $or: [
        { field: 'status', op: '=', value: 'active' },
        { field: 'status', op: '=', value: 'pending' },
      ],
    };
    const result = searchFilterToTypesenseFilter(filter);
    expect(result).toBe('(status:=`active`) || (status:=`pending`)');
  });

  it('translates $not filter', () => {
    const filter: SearchFilter = {
      $not: { field: 'status', op: '=', value: 'deleted' },
    };
    expect(searchFilterToTypesenseFilter(filter)).toBe('!(status:=`deleted`)');
  });

  it('translates $geoRadius filter', () => {
    const filter: SearchFilter = {
      $geoRadius: { lat: 48.8566, lng: 2.3522, radiusMeters: 5000 },
    };
    expect(searchFilterToTypesenseFilter(filter)).toBe('location:(48.8566, 2.3522, 5 km)');
  });

  it('translates IS_EMPTY filter', () => {
    const filter: SearchFilter = { field: 'name', op: 'IS_EMPTY', value: true };
    expect(searchFilterToTypesenseFilter(filter)).toBe("name:=''");
  });

  it('translates IS_NOT_EMPTY filter', () => {
    const filter: SearchFilter = { field: 'name', op: 'IS_NOT_EMPTY', value: true };
    expect(searchFilterToTypesenseFilter(filter)).toBe("name:!=''");
  });
});

// ============================================================================
// Provider HTTP integration tests (mocked fetch)
// ============================================================================

describe('createTypesenseProvider', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
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
    return createTypesenseProvider({
      provider: 'typesense',
      url: 'http://localhost:8108',
      apiKey: 'test-api-key',
      timeoutMs: 5000,
      retries: 0,
    });
  }

  it('sets X-TYPESENSE-API-KEY header on requests', async () => {
    const provider = createProvider();
    await provider.connect();

    expect(fetchMock).toHaveBeenCalled();
    const call = fetchMock.mock.calls[0];
    const options = call[1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers['X-TYPESENSE-API-KEY']).toBe('test-api-key');
  });

  it('connect calls /health endpoint', async () => {
    const provider = createProvider();
    await provider.connect();

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:8108/health');
  });

  it('healthCheck returns healthy status', async () => {
    const provider = createProvider();
    const result = await provider.healthCheck();

    expect(result.healthy).toBe(true);
    expect(result.provider).toBe('typesense');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('healthCheck returns unhealthy on error', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('Connection refused')));

    const provider = createProvider();
    const result = await provider.healthCheck();

    expect(result.healthy).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('createOrUpdateIndex posts collection schema', async () => {
    const provider = createProvider();
    const settings: SearchIndexSettings = {
      searchableFields: ['title', 'body'],
      filterableFields: ['status'],
      sortableFields: ['createdAt'],
      facetableFields: ['category'],
    };

    await provider.createOrUpdateIndex('test_index', settings);

    // Should have called POST /collections
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:8108/collections');
    const options = call[1] as RequestInit;
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body as string);
    expect(body.name).toBe('test_index');
    expect(body.fields).toBeDefined();
    expect(Array.isArray(body.fields)).toBe(true);

    // Check that searchable fields have type 'string'
    const titleField = body.fields.find((f: { name: string }) => f.name === 'title');
    expect(titleField).toBeDefined();
    expect(titleField.type).toBe('string');

    // Check facetable field has facet: true
    const categoryField = body.fields.find((f: { name: string }) => f.name === 'category');
    expect(categoryField).toBeDefined();
    expect(categoryField.facet).toBe(true);
  });

  it('indexDocument posts to documents endpoint with upsert', async () => {
    // First call: GET collection (for searchable fields cache setup)
    // Second call: POST document
    fetchMock.mockImplementation((url: string) => {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes('/documents')
              ? { id: 'doc1' }
              : { name: 'idx', fields: [], num_documents: 0 },
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });

    const provider = createProvider();
    await provider.indexDocument('test_index', { title: 'Hello' }, 'doc1');

    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(lastCall[0] as string).toContain('/collections/test_index/documents');
    expect(lastCall[0] as string).toContain('action=upsert');

    const options = lastCall[1] as RequestInit;
    const body = JSON.parse(options.body as string);
    expect(body.id).toBe('doc1');
    expect(body.title).toBe('Hello');
  });

  it('search calls documents/search endpoint', async () => {
    fetchMock.mockImplementation((url: string) => {
      if ((url as string).includes('/documents/search')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              found: 1,
              hits: [
                {
                  document: { id: '1', title: 'Test' },
                  text_match: 100,
                  highlights: [{ field: 'title', snippet: '<mark>Test</mark>' }],
                },
              ],
              search_time_ms: 5,
              page: 1,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      // Collection info for field cache
      return Promise.resolve(
        new Response(
          JSON.stringify({
            name: 'test_index',
            fields: [{ name: 'title', type: 'string' }],
            num_documents: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });

    const provider = createProvider();
    const result = await provider.search('test_index', { q: 'test' });

    expect(result.totalHits).toBe(1);
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].document).toEqual({ id: '1', title: 'Test' });
    expect(result.hits[0].score).toBe(100);
    expect(result.hits[0].highlights).toEqual({ title: '<mark>Test</mark>' });
    expect(result.indexName).toBe('test_index');
    expect(result.query).toBe('test');
  });

  it('waitForTask returns immediately with succeeded status', async () => {
    const provider = createProvider();
    const result = await provider.waitForTask!('task-123');

    expect(result.taskId).toBe('task-123');
    expect(result.status).toBe('succeeded');
  });

  it('deleteDocument calls correct endpoint', async () => {
    const provider = createProvider();
    await provider.deleteDocument('test_index', 'doc1');

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:8108/collections/test_index/documents/doc1');
    expect((call[1] as RequestInit).method).toBe('DELETE');
  });

  it('multiSearch uses /multi_search endpoint', async () => {
    // Mock collection info then multi_search
    fetchMock.mockImplementation((url: string) => {
      if ((url as string).includes('/multi_search')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                { found: 0, hits: [], search_time_ms: 1, page: 1 },
                { found: 0, hits: [], search_time_ms: 1, page: 1 },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            name: 'idx',
            fields: [{ name: 'title', type: 'string' }],
            num_documents: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });

    const provider = createProvider();
    const results = await provider.multiSearch([
      { indexName: 'idx1', query: { q: 'foo' } },
      { indexName: 'idx2', query: { q: 'bar' } },
    ]);

    expect(results.length).toBe(2);

    // Check that /multi_search was called
    const multiSearchCall = fetchMock.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('/multi_search'),
    );
    expect(multiSearchCall).toBeDefined();
  });

  it('suggest uses prefix search', async () => {
    fetchMock.mockImplementation((url: string) => {
      if ((url as string).includes('/documents/search')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              found: 1,
              hits: [
                {
                  document: { id: '1', title: 'Testing autocomplete' },
                  text_match: 80,
                  highlights: [],
                },
              ],
              search_time_ms: 2,
              page: 1,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            name: 'idx',
            fields: [{ name: 'title', type: 'string' }],
            num_documents: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });

    const provider = createProvider();
    const result = await provider.suggest('test_index', { q: 'test' });

    expect(result.suggestions.length).toBe(1);
    expect(result.suggestions[0].text).toBe('Testing autocomplete');

    // Verify prefix=true is in the query
    const searchCall = fetchMock.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('/documents/search'),
    );
    expect(searchCall).toBeDefined();
    expect(searchCall![0] as string).toContain('prefix=true');
  });
});
