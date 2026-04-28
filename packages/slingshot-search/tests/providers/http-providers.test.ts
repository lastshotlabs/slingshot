import { afterEach, describe, expect, test } from 'bun:test';
import { createAlgoliaProvider } from '../../src/providers/algolia';
import { createElasticsearchProvider } from '../../src/providers/elasticsearch';
import { createMeilisearchProvider } from '../../src/providers/meilisearch';
import { createTypesenseProvider } from '../../src/providers/typesense';
import type { SearchIndexSettings, SearchProvider } from '../../src/types/provider';

type FetchFn = typeof fetch;

interface CapturedRequest {
  readonly method: string;
  readonly url: URL;
  readonly body: string | undefined;
  readonly contentType: string | null;
}

const originalFetch = globalThis.fetch as FetchFn;

const settings: SearchIndexSettings = {
  primaryKey: 'id',
  searchableFields: ['title', 'body'],
  filterableFields: ['status', 'category'],
  sortableFields: ['createdAt'],
  facetableFields: ['category'],
};

const searchQuery = {
  q: 'alpha',
  filter: { field: 'status', op: '=', value: 'published' } as const,
  sort: [{ field: 'createdAt', direction: 'desc' as const }],
  facets: ['category'],
  highlight: { fields: ['title'] },
  page: 1,
  hitsPerPage: 10,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(handler: (request: CapturedRequest) => Response): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const headers = new Headers(init?.headers);
    const request: CapturedRequest = {
      method: init?.method ?? 'GET',
      url,
      body,
      contentType: headers.get('content-type'),
    };
    requests.push(request);
    return Promise.resolve(handler(request));
  }) as FetchFn;
  return requests;
}

async function exerciseProvider(provider: SearchProvider): Promise<void> {
  await provider.connect();
  expect((await provider.healthCheck()).healthy).toBe(true);

  await provider.createOrUpdateIndex('articles', settings);
  expect(await provider.listIndexes()).toHaveLength(1);
  expect(await provider.getIndexSettings('articles')).toMatchObject({
    searchableFields: expect.arrayContaining(['title']),
  });

  await provider.indexDocument('articles', { title: 'Alpha', status: 'published' }, 'doc-1');
  await provider.indexDocuments(
    'articles',
    [
      { id: 'doc-2', title: 'Beta', status: 'draft' },
      { id: 'doc-3', title: 'Gamma', status: 'published' },
    ],
    'id',
  );
  await provider.deleteDocument('articles', 'doc-2');
  await provider.deleteDocuments('articles', ['doc-3']);
  await provider.clearIndex('articles');

  const search = await provider.search('articles', searchQuery);
  expect(search.indexName).toBe('articles');
  expect(String(search.hits[0]?.document.title)).toContain('Alpha');

  const multi = await provider.multiSearch?.([{ indexName: 'articles', query: searchQuery }]);
  expect(String(multi?.[0]?.hits[0]?.document.title)).toContain('Alpha');

  const suggestions = await provider.suggest?.('articles', {
    q: 'alp',
    fields: ['title'],
    limit: 2,
    highlight: true,
    filter: { field: 'status', op: '=', value: 'published' },
  });
  expect(suggestions?.suggestions[0]?.text).toContain('Alpha');

  expect(await provider.getTask?.('task-1')).toMatchObject({ status: 'succeeded' });
  expect(await provider.waitForTask?.('task-1', 20)).toMatchObject({ status: 'succeeded' });
  await provider.deleteIndex('articles');
  await provider.teardown();
}

function meiliTask(taskUid = 1, status: 'enqueued' | 'succeeded' = 'succeeded') {
  return {
    taskUid,
    indexUid: 'articles',
    status,
    type: 'indexUpdate',
    enqueuedAt: '2024-01-01T00:00:00Z',
  };
}

function meiliSearchResponse() {
  return {
    hits: [
      {
        id: 'doc-1',
        title: 'Alpha result',
        status: 'published',
        category: 'news',
        _formatted: { title: '<em>Alpha</em> result' },
        _rankingScore: 0.98,
      },
    ],
    query: 'alpha',
    processingTimeMs: 3,
    estimatedTotalHits: 1,
    facetDistribution: { category: { news: 1 } },
    facetStats: { views: { min: 1, max: 9 } },
  };
}

test('meilisearch provider maps lifecycle, writes, search, suggest, tasks, and settings', async () => {
  const requests = installFetch(request => {
    const path = request.url.pathname + request.url.search;
    if (path === '/health') return jsonResponse({ status: 'available' });
    if (path === '/version') return jsonResponse({ pkgVersion: '1.8.0' });
    if (path === '/indexes') {
      if (request.method === 'GET') {
        return jsonResponse({
          results: [{ uid: 'articles', numberOfDocuments: 3, updatedAt: '2024-01-01T00:00:00Z' }],
        });
      }
      return jsonResponse(meiliTask(1, 'succeeded'));
    }
    if (path === '/indexes/articles/settings') {
      if (request.method === 'GET') {
        return jsonResponse({
          searchableAttributes: ['title', 'body'],
          filterableAttributes: ['status', 'category'],
          sortableAttributes: ['createdAt'],
          displayedAttributes: ['*'],
          rankingRules: ['words', 'typo'],
          distinctAttribute: null,
          synonyms: { tv: ['television'] },
          stopWords: ['the'],
        });
      }
      return jsonResponse(meiliTask(2, 'succeeded'));
    }
    if (path.startsWith('/tasks/')) return jsonResponse(meiliTask(3, 'succeeded'));
    if (path === '/indexes/articles/documents' && request.method === 'POST') {
      return jsonResponse(meiliTask(4, 'succeeded'));
    }
    if (path === '/indexes/articles/documents' && request.method === 'DELETE') {
      return jsonResponse(meiliTask(5, 'succeeded'));
    }
    if (path === '/indexes/articles/documents/delete-batch') {
      return jsonResponse(meiliTask(6, 'succeeded'));
    }
    if (path === '/indexes/articles/search') return jsonResponse(meiliSearchResponse());
    if (path === '/multi-search') return jsonResponse({ results: [meiliSearchResponse()] });
    if (path.startsWith('/indexes/articles/documents/'))
      return jsonResponse(meiliTask(7, 'succeeded'));
    if (path === '/indexes/articles') return jsonResponse(meiliTask(8, 'succeeded'));
    return jsonResponse({ ok: true });
  });

  await exerciseProvider(
    createMeilisearchProvider({
      provider: 'meilisearch',
      url: 'http://meili.test',
      apiKey: 'master',
      retries: 0,
      retryDelayMs: 1,
    }),
  );

  expect(requests.some(request => request.url.pathname === '/indexes/articles/search')).toBe(true);
  expect(
    requests.find(request => request.url.pathname === '/indexes/articles/settings')?.body,
  ).toContain('searchableAttributes');
});

function typesenseCollection() {
  return {
    name: 'articles',
    num_documents: 3,
    created_at: 1_704_067_200,
    default_sorting_field: 'createdAt',
    fields: [
      { name: 'title', type: 'string', facet: false },
      { name: 'body', type: 'string', facet: false },
      { name: 'status', type: 'string', facet: true },
      { name: 'category', type: 'string', facet: true },
      { name: 'createdAt', type: 'string', sort: true },
    ],
  };
}

function typesenseSearchResponse() {
  return {
    found: 1,
    page: 1,
    search_time_ms: 4,
    hits: [
      {
        document: { id: 'doc-1', title: 'Alpha result', status: 'published', category: 'news' },
        text_match: 99,
        highlights: [{ field: 'title', snippet: '<mark>Alpha</mark> result' }],
      },
    ],
    facet_counts: [
      { field_name: 'category', counts: [{ value: 'news', count: 1 }], stats: { min: 1, max: 9 } },
    ],
  };
}

test('typesense provider maps lifecycle, collection schema, JSONL import, search, and tasks', async () => {
  const requests = installFetch(request => {
    const path = request.url.pathname + request.url.search;
    if (path === '/health') return jsonResponse({ ok: true });
    if (path === '/collections') {
      return request.method === 'GET' ? jsonResponse([typesenseCollection()]) : jsonResponse({});
    }
    if (path === '/collections/articles') return jsonResponse(typesenseCollection());
    if (path.startsWith('/collections/articles/documents/search')) {
      return jsonResponse(typesenseSearchResponse());
    }
    if (path === '/multi_search') return jsonResponse({ results: [typesenseSearchResponse()] });
    return jsonResponse({});
  });

  await exerciseProvider(
    createTypesenseProvider({
      provider: 'typesense',
      url: 'http://typesense.test',
      apiKey: 'master',
      retries: 0,
      retryDelayMs: 1,
    }),
  );

  const importRequest = requests.find(request =>
    request.url.pathname.endsWith('/documents/import'),
  );
  expect(importRequest?.contentType).toBe('text/plain');
  expect(importRequest?.body).toContain('"id":"doc-2"');
});

function elasticsearchSearchResponse() {
  return {
    took: 5,
    timed_out: false,
    hits: {
      total: { value: 1, relation: 'eq' },
      max_score: 1,
      hits: [
        {
          _index: 'articles',
          _id: 'doc-1',
          _score: 1,
          _source: { title: 'Alpha result', status: 'published', category: 'news' },
          highlight: { title: ['<mark>Alpha</mark> result'] },
        },
      ],
    },
    aggregations: {
      category: { buckets: [{ key: 'news', doc_count: 1 }] },
      views_stats: { min: 1, max: 9, avg: 5, sum: 10, count: 2 },
    },
  };
}

test('elasticsearch provider maps auth headers, mappings, bulk writes, search, and suggest', async () => {
  const requests = installFetch(request => {
    const path = request.url.pathname + request.url.search;
    if (path === '/_cluster/health') return jsonResponse({ status: 'green', cluster_name: 'test' });
    if (path === '/') return jsonResponse({ version: { number: '8.12.0' } });
    if (path === '/_all') {
      return jsonResponse({
        articles: { aliases: {}, mappings: {}, settings: { index: { creation_date: '1' } } },
      });
    }
    if (path === '/_stats/docs') {
      return jsonResponse({ indices: { articles: { primaries: { docs: { count: 3 } } } } });
    }
    if (path === '/articles/_mapping') {
      return jsonResponse({
        articles: {
          mappings: {
            properties: {
              title: { type: 'text' },
              body: { type: 'text' },
              status: { type: 'keyword' },
              category: { type: 'keyword' },
            },
          },
        },
      });
    }
    if (path === '/articles/_search') return jsonResponse(elasticsearchSearchResponse());
    if (path === '/_msearch') return jsonResponse({ responses: [elasticsearchSearchResponse()] });
    return jsonResponse({ acknowledged: true });
  });

  await exerciseProvider(
    createElasticsearchProvider({
      provider: 'elasticsearch',
      url: 'http://elastic.test',
      auth: { bearer: 'token' },
      retries: 0,
      retryDelayMs: 1,
    }),
  );

  const bulkRequest = requests.find(request => request.url.pathname === '/_bulk');
  expect(bulkRequest?.contentType).toBe('application/x-ndjson');
  expect(requests.find(request => request.url.pathname === '/_cluster/health')).toBeDefined();
});

function algoliaSearchResponse() {
  return {
    hits: [
      {
        objectID: 'doc-1',
        title: 'Alpha result',
        status: 'published',
        category: 'news',
        _highlightResult: {
          title: { value: '<em>Alpha</em> result', matchLevel: 'full', matchedWords: ['alpha'] },
        },
      },
    ],
    nbHits: 1,
    page: 0,
    nbPages: 1,
    hitsPerPage: 10,
    processingTimeMS: 2,
    query: 'alpha',
    facets: { category: { news: 1 } },
    facets_stats: { views: { min: 1, max: 9, avg: 5, sum: 10 } },
  };
}

test('algolia provider maps index settings, batch writes, search-only client, and task helpers', async () => {
  const requests = installFetch(request => {
    const path = request.url.pathname + request.url.search;
    if (path === '/1/indexes') {
      return jsonResponse({
        items: [{ name: 'articles', entries: 3, updatedAt: '2024-01-01T00:00:00Z' }],
      });
    }
    if (path === '/1/indexes/articles/settings') {
      if (request.method === 'GET') {
        return jsonResponse({
          searchableAttributes: ['title', 'body'],
          attributesForFaceting: ['filterOnly(status)', 'category'],
          customRanking: ['desc(createdAt)'],
          ranking: ['typo', 'geo'],
          distinct: false,
          attributeForDistinct: null,
        });
      }
      return jsonResponse({ taskID: 1, updatedAt: '2024-01-01T00:00:00Z' });
    }
    if (path === '/1/indexes/articles/query') return jsonResponse(algoliaSearchResponse());
    if (path === '/1/indexes/*/queries') {
      return jsonResponse({ results: [algoliaSearchResponse()] });
    }
    return jsonResponse({ taskID: 2, updatedAt: '2024-01-01T00:00:00Z' });
  });

  await exerciseProvider(
    createAlgoliaProvider({
      provider: 'algolia',
      applicationId: 'APPID',
      apiKey: 'search-key',
      adminApiKey: 'admin-key',
      retries: 0,
      retryDelayMs: 1,
    }),
  );

  const searchRequest = requests.find(
    request => request.url.pathname === '/1/indexes/articles/query',
  );
  expect(searchRequest?.body).toContain('alpha');
  expect(requests.some(request => request.url.hostname === 'appid-dsn.algolia.net')).toBe(true);
});
