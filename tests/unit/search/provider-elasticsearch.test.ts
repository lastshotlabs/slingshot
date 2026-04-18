import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  createElasticsearchProvider,
  searchFilterToElasticsearchQuery,
} from '../../../packages/slingshot-search/src/providers/elasticsearch';
import type { SearchIndexSettings } from '../../../packages/slingshot-search/src/types/provider';
import type { SearchFilter } from '../../../packages/slingshot-search/src/types/query';

// ============================================================================
// Filter translation tests
// ============================================================================

describe('searchFilterToElasticsearchQuery', () => {
  it('translates equality filter to term query', () => {
    const filter: SearchFilter = { field: 'status', op: '=', value: 'published' };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({ term: { status: 'published' } });
  });

  it('translates inequality filter to must_not term', () => {
    const filter: SearchFilter = { field: 'status', op: '!=', value: 'draft' };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      bool: { must_not: [{ term: { status: 'draft' } }] },
    });
  });

  it('translates greater-than filter to range query', () => {
    const filter: SearchFilter = { field: 'price', op: '>', value: 100 };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({ range: { price: { gt: 100 } } });
  });

  it('translates greater-than-or-equal filter', () => {
    const filter: SearchFilter = { field: 'price', op: '>=', value: 50 };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({ range: { price: { gte: 50 } } });
  });

  it('translates less-than filter', () => {
    const filter: SearchFilter = { field: 'price', op: '<', value: 200 };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({ range: { price: { lt: 200 } } });
  });

  it('translates less-than-or-equal filter', () => {
    const filter: SearchFilter = { field: 'price', op: '<=', value: 300 };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({ range: { price: { lte: 300 } } });
  });

  it('translates IN filter to terms query', () => {
    const filter: SearchFilter = { field: 'tags', op: 'IN', value: ['a', 'b', 'c'] };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({ terms: { tags: ['a', 'b', 'c'] } });
  });

  it('translates NOT_IN filter to must_not terms', () => {
    const filter: SearchFilter = { field: 'tags', op: 'NOT_IN', value: ['x', 'y'] };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      bool: { must_not: [{ terms: { tags: ['x', 'y'] } }] },
    });
  });

  it('translates EXISTS filter', () => {
    const filter: SearchFilter = { field: 'email', op: 'EXISTS', value: true };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({ exists: { field: 'email' } });
  });

  it('translates NOT_EXISTS filter', () => {
    const filter: SearchFilter = { field: 'email', op: 'NOT_EXISTS', value: true };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      bool: { must_not: [{ exists: { field: 'email' } }] },
    });
  });

  it('translates BETWEEN filter to range query', () => {
    const filter: SearchFilter = {
      field: 'price',
      op: 'BETWEEN',
      value: [10, 50] as [number, number],
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({ range: { price: { gte: 10, lte: 50 } } });
  });

  it('translates CONTAINS filter to match query', () => {
    const filter: SearchFilter = { field: 'description', op: 'CONTAINS', value: 'hello' };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({ match: { description: 'hello' } });
  });

  it('translates STARTS_WITH filter to prefix query', () => {
    const filter: SearchFilter = { field: 'name', op: 'STARTS_WITH', value: 'abc' };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({ prefix: { name: 'abc' } });
  });

  it('translates $and compound filter', () => {
    const filter: SearchFilter = {
      $and: [
        { field: 'status', op: '=', value: 'active' },
        { field: 'price', op: '>', value: 10 },
      ],
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      bool: {
        filter: [{ term: { status: 'active' } }, { range: { price: { gt: 10 } } }],
      },
    });
  });

  it('translates $or compound filter', () => {
    const filter: SearchFilter = {
      $or: [
        { field: 'status', op: '=', value: 'active' },
        { field: 'status', op: '=', value: 'pending' },
      ],
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      bool: {
        should: [{ term: { status: 'active' } }, { term: { status: 'pending' } }],
        minimum_should_match: 1,
      },
    });
  });

  it('translates $not filter', () => {
    const filter: SearchFilter = {
      $not: { field: 'status', op: '=', value: 'deleted' },
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      bool: { must_not: [{ term: { status: 'deleted' } }] },
    });
  });

  it('translates $geoRadius filter to geo_distance', () => {
    const filter: SearchFilter = {
      $geoRadius: { lat: 48.8566, lng: 2.3522, radiusMeters: 5000 },
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      geo_distance: {
        distance: '5000m',
        _geo: { lat: 48.8566, lon: 2.3522 },
      },
    });
  });

  it('translates $geoBoundingBox filter', () => {
    const filter: SearchFilter = {
      $geoBoundingBox: {
        topLeft: { lat: 49.0, lng: 2.0 },
        bottomRight: { lat: 48.0, lng: 3.0 },
      },
    };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      geo_bounding_box: {
        _geo: {
          top_left: { lat: 49.0, lon: 2.0 },
          bottom_right: { lat: 48.0, lon: 3.0 },
        },
      },
    });
  });

  it('translates Date value in filter', () => {
    const date = new Date('2024-01-15T00:00:00.000Z');
    const filter: SearchFilter = { field: 'createdAt', op: '>=', value: date };
    const result = searchFilterToElasticsearchQuery(filter);
    expect(result).toEqual({
      range: { createdAt: { gte: '2024-01-15T00:00:00.000Z' } },
    });
  });
});

// ============================================================================
// Provider HTTP integration tests (mocked fetch)
// ============================================================================

describe('createElasticsearchProvider', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 'green', cluster_name: 'test' }), {
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
    return createElasticsearchProvider({
      provider: 'elasticsearch',
      url: 'http://localhost:9200',
      auth: { username: 'elastic', password: 'changeme' },
      timeoutMs: 5000,
      retries: 0,
    });
  }

  it('connect calls /_cluster/health', async () => {
    const provider = createProvider();
    await provider.connect();

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:9200/_cluster/health');
  });

  it('connect throws if cluster is red', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 'red' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const provider = createProvider();
    expect(provider.connect()).rejects.toThrow('red');
  });

  it('sets Basic auth header', async () => {
    const provider = createProvider();
    await provider.connect();

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    const encoded = btoa('elastic:changeme');
    expect(headers.Authorization).toBe(`Basic ${encoded}`);
  });

  it('uses Bearer auth when configured', async () => {
    const provider = createElasticsearchProvider({
      provider: 'elasticsearch',
      url: 'http://localhost:9200',
      auth: { bearer: 'my-token' },
      retries: 0,
    });

    await provider.connect();

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer my-token');
  });

  it('healthCheck returns healthy status', async () => {
    fetchMock.mockImplementation((url: string) => {
      if ((url as string).includes('/_cluster/health')) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'green', cluster_name: 'test' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      // Root endpoint for version
      return Promise.resolve(
        new Response(JSON.stringify({ version: { number: '8.12.0' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    const provider = createProvider();
    const result = await provider.healthCheck();

    expect(result.healthy).toBe(true);
    expect(result.provider).toBe('elasticsearch');
    expect(result.version).toBe('8.12.0');
  });

  it('createOrUpdateIndex sends PUT with mappings', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ acknowledged: true }), {
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

    await provider.createOrUpdateIndex('test_index', settings);

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:9200/test_index');
    expect((call[1] as RequestInit).method).toBe('PUT');

    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.mappings).toBeDefined();
    expect(body.mappings.properties).toBeDefined();
    expect(body.mappings.properties.title.type).toBe('text');
    expect(body.mappings.properties.status.type).toBe('keyword');
  });

  it('search uses _search endpoint with query DSL', async () => {
    fetchMock.mockImplementation((url: string) => {
      if ((url as string).includes('/_search')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              took: 5,
              timed_out: false,
              hits: {
                total: { value: 1, relation: 'eq' },
                max_score: 1.5,
                hits: [
                  {
                    _index: 'test_index',
                    _id: '1',
                    _score: 1.5,
                    _source: { title: 'Test Document' },
                    highlight: { title: ['<mark>Test</mark> Document'] },
                  },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      // Mapping endpoint for field cache
      return Promise.resolve(
        new Response(
          JSON.stringify({
            test_index: {
              mappings: {
                properties: {
                  title: { type: 'text' },
                },
              },
            },
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
    expect(result.hits[0].document).toEqual({ id: '1', title: 'Test Document' });
    expect(result.hits[0].score).toBe(1.5);
    expect(result.hits[0].highlights).toEqual({ title: '<mark>Test</mark> Document' });
    expect(result.totalHitsRelation).toBe('exact');
  });

  it('indexDocuments sends bulk NDJSON', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ errors: false, items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const provider = createProvider();
    await provider.indexDocuments(
      'test_index',
      [
        { id: '1', title: 'Doc 1' },
        { id: '2', title: 'Doc 2' },
      ],
      'id',
    );

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:9200/_bulk');
    const options = call[1] as RequestInit;
    expect(options.headers).toHaveProperty('Content-Type', 'application/x-ndjson');

    const body = options.body as string;
    const lines = body.trim().split('\n');
    expect(lines.length).toBe(4); // 2 action lines + 2 document lines
  });

  it('waitForTask returns immediately with succeeded', async () => {
    const provider = createProvider();
    const result = await provider.waitForTask!('task-1');

    expect(result.status).toBe('succeeded');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('multiSearch uses _msearch endpoint', async () => {
    fetchMock.mockImplementation((url: string) => {
      if ((url as string).includes('/_msearch')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              responses: [
                {
                  took: 1,
                  timed_out: false,
                  hits: { total: { value: 0, relation: 'eq' }, max_score: null, hits: [] },
                },
                {
                  took: 1,
                  timed_out: false,
                  hits: { total: { value: 0, relation: 'eq' }, max_score: null, hits: [] },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            test_index: { mappings: { properties: { title: { type: 'text' } } } },
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
  });
});
