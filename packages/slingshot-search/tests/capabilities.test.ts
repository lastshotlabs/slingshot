/**
 * Provider capability mismatch tests.
 *
 * Tests behavior when a provider has missing optional methods or capabilities.
 * Verifies graceful fallback or clear error handling.
 */
import { describe, expect, it } from 'bun:test';
import type { SearchIndexSettings, SearchIndexTask, SearchProvider } from '../src/types/provider';
import type { SearchQuery, SuggestQuery } from '../src/types/query';
import type { SearchResponse, SuggestResponse } from '../src/types/response';

// ============================================================================
// Minimal provider stubs
// ============================================================================

function makeMinimalProvider(overrides: Partial<SearchProvider> = {}): SearchProvider {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const settings = new Map<string, SearchIndexSettings>();

  const base: SearchProvider = {
    name: 'minimal-stub',

    async connect() {},
    async teardown() {},

    async healthCheck() {
      return { healthy: true, provider: 'minimal-stub', latencyMs: 0 };
    },

    async createOrUpdateIndex(indexName, s): Promise<SearchIndexTask | undefined> {
      if (!store.has(indexName)) store.set(indexName, new Map());
      settings.set(indexName, s);
      return undefined;
    },

    async deleteIndex(indexName) {
      store.delete(indexName);
      settings.delete(indexName);
    },

    async listIndexes() {
      return [...store.entries()].map(([name, docs]) => ({
        name,
        documentCount: docs.size,
        updatedAt: new Date(),
      }));
    },

    async getIndexSettings(indexName) {
      const s = settings.get(indexName);
      if (!s) throw new Error(`Index '${indexName}' not found`);
      return s;
    },

    async indexDocument(indexName, document, documentId) {
      const idx = store.get(indexName);
      if (!idx) throw new Error(`Index '${indexName}' not found`);
      idx.set(documentId, document);
    },

    async deleteDocument(indexName, documentId) {
      store.get(indexName)?.delete(documentId);
    },

    async indexDocuments(indexName, documents, primaryKey): Promise<SearchIndexTask | undefined> {
      const idx = store.get(indexName);
      if (!idx) throw new Error(`Index '${indexName}' not found`);
      for (const doc of documents) {
        const id = String(doc[primaryKey] ?? '');
        if (id) idx.set(id, doc);
      }
      return undefined;
    },

    async deleteDocuments(indexName, ids): Promise<SearchIndexTask | undefined> {
      const idx = store.get(indexName);
      if (!idx) return undefined;
      for (const id of ids) idx.delete(id);
      return undefined;
    },

    async clearIndex(indexName): Promise<SearchIndexTask | undefined> {
      store.get(indexName)?.clear();
      return undefined;
    },

    async search(indexName: string, query: SearchQuery): Promise<SearchResponse> {
      const idx = store.get(indexName);
      if (!idx) throw new Error(`Index '${indexName}' not found`);
      const hits = [...idx.values()]
        .filter(
          doc =>
            !query.q ||
            Object.values(doc).some(
              v => typeof v === 'string' && v.toLowerCase().includes(query.q.toLowerCase()),
            ),
        )
        .map(document => ({ document }));
      const limited = hits.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 20));
      return {
        hits: limited,
        totalHits: hits.length,
        totalHitsRelation: 'exact' as const,
        query: query.q,
        processingTimeMs: 0,
        indexName,
        offset: query.offset ?? 0,
        limit: query.limit ?? 20,
      };
    },

    async multiSearch(queries) {
      return Promise.all(queries.map(({ indexName, query }) => base.search(indexName, query)));
    },

    async suggest(_indexName: string, query: SuggestQuery): Promise<SuggestResponse> {
      // Basic stub: return no suggestions
      return { suggestions: [], processingTimeMs: 0 };
    },

    ...overrides,
  };

  return base;
}

// ============================================================================
// Tests
// ============================================================================

describe('provider capability mismatches', () => {
  it('provider without waitForTask — async operations proceed without waiting', async () => {
    // Provider has no waitForTask/getTask — should still work for indexing
    const provider = makeMinimalProvider({
      // waitForTask and getTask are not defined — they're optional on SearchProvider
    });

    await provider.createOrUpdateIndex('cap_test', {
      searchableFields: ['title'],
      filterableFields: [],
      sortableFields: [],
      facetableFields: [],
    });

    // indexDocuments returns void (not a task) — no waitForTask needed
    const result = await provider.indexDocuments(
      'cap_test',
      [{ id: '1', title: 'Test Doc' }],
      'id',
    );

    // Result is void — no task
    expect(result).toBeUndefined();

    const searchResult = await provider.search('cap_test', { q: 'Test Doc' });
    expect(searchResult.totalHits).toBeGreaterThanOrEqual(1);

    await provider.teardown();
  });

  it('provider without search support — throws a descriptive error when search is called', async () => {
    // Simulates a provider that does not support full-text search (throws NotImplementedError).
    // The system should surface the error clearly rather than silently swallowing it.
    const provider = makeMinimalProvider({
      search: async (_indexName: string, _query: SearchQuery): Promise<SearchResponse> => {
        throw new Error('Search is not supported by this provider');
      },
    });

    await provider.createOrUpdateIndex('no_search_idx', {
      searchableFields: ['title'],
      filterableFields: [],
      sortableFields: [],
      facetableFields: [],
    });

    await expect(provider.search('no_search_idx', { q: 'test' })).rejects.toThrow(
      'Search is not supported by this provider',
    );

    await provider.teardown();
  });

  it('provider without suggest support — suggest throws a descriptive error', async () => {
    // Simulates a provider that does not support autocomplete suggestions.
    // The suggest route should surface the error clearly to the caller.
    const provider = makeMinimalProvider({
      suggest: async (_indexName: string, _query: SuggestQuery): Promise<SuggestResponse> => {
        throw new Error('Suggest is not supported by this provider');
      },
    });

    await provider.createOrUpdateIndex('no_suggest_idx', {
      searchableFields: ['title'],
      filterableFields: [],
      sortableFields: [],
      facetableFields: [],
    });

    await expect(provider.suggest('no_suggest_idx', { q: 'partial' })).rejects.toThrow(
      'Suggest is not supported by this provider',
    );

    await provider.teardown();
  });

  it('provider health check returns required fields when healthy', async () => {
    const provider = makeMinimalProvider();
    await provider.connect();

    const health = await provider.healthCheck();
    expect(health).toHaveProperty('healthy');
    expect(health).toHaveProperty('provider');
    expect(health).toHaveProperty('latencyMs');
    expect(typeof health.healthy).toBe('boolean');
    expect(typeof health.provider).toBe('string');
    expect(typeof health.latencyMs).toBe('number');

    await provider.teardown();
  });

  it('provider teardown can be called multiple times without throwing', async () => {
    const provider = makeMinimalProvider();
    await provider.connect();
    await provider.teardown();
    await expect(provider.teardown()).resolves.toBeUndefined();
  });
});
