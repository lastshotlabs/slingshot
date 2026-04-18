import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDbNativeProvider } from '../../../packages/slingshot-search/src/providers/dbNative';
import type {
  SearchIndexSettings,
  SearchProvider,
} from '../../../packages/slingshot-search/src/types/provider';

// ============================================================================
// Helpers
// ============================================================================

function makeSettings(overrides?: Partial<SearchIndexSettings>): SearchIndexSettings {
  return {
    searchableFields: ['title', 'body'],
    filterableFields: ['status', 'category'],
    sortableFields: ['createdAt'],
    facetableFields: ['category'],
    ...overrides,
  };
}

function makeDocs(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${i + 1}`,
    title: `Title ${i + 1}`,
    body: `Body content for document ${i + 1}`,
    status: i % 2 === 0 ? 'published' : 'draft',
    category: i % 3 === 0 ? 'news' : 'blog',
    createdAt: new Date(2024, 0, i + 1).toISOString(),
  }));
}

// ============================================================================
// Contract tests for SearchProvider (db-native implementation)
// ============================================================================

describe('SearchProvider contract (db-native)', () => {
  let provider: SearchProvider;
  const INDEX = 'test_articles';
  const settings = makeSettings();

  beforeEach(async () => {
    provider = createDbNativeProvider();
    await provider.connect();
  });

  afterEach(async () => {
    await provider.teardown();
  });

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  describe('lifecycle', () => {
    test('connect sets provider to healthy state', async () => {
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.provider).toBe('db-native');
      expect(typeof health.latencyMs).toBe('number');
    });

    test('teardown clears state and reports unhealthy', async () => {
      await provider.createOrUpdateIndex(INDEX, settings);
      await provider.teardown();

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
    });

    test('healthCheck returns version string', async () => {
      const health = await provider.healthCheck();
      expect(health.version).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Index management
  // --------------------------------------------------------------------------

  describe('createOrUpdateIndex', () => {
    test('creates a new index', async () => {
      await provider.createOrUpdateIndex(INDEX, settings);
      const indexes = await provider.listIndexes();
      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe(INDEX);
      expect(indexes[0].documentCount).toBe(0);
    });

    test('updates settings on existing index without losing documents', async () => {
      await provider.createOrUpdateIndex(INDEX, settings);
      await provider.indexDocument(INDEX, { id: '1', title: 'Hello' }, '1');

      const newSettings = makeSettings({ searchableFields: ['title', 'body', 'summary'] });
      await provider.createOrUpdateIndex(INDEX, newSettings);

      const retrieved = await provider.getIndexSettings(INDEX);
      expect(retrieved.searchableFields).toEqual(['title', 'body', 'summary']);

      const indexes = await provider.listIndexes();
      expect(indexes[0].documentCount).toBe(1);
    });

    test('deleteIndex removes the index', async () => {
      await provider.createOrUpdateIndex(INDEX, settings);
      await provider.deleteIndex(INDEX);
      const indexes = await provider.listIndexes();
      expect(indexes).toHaveLength(0);
    });

    test('getIndexSettings returns settings for existing index', async () => {
      await provider.createOrUpdateIndex(INDEX, settings);
      const retrieved = await provider.getIndexSettings(INDEX);
      expect(retrieved.searchableFields).toEqual(['title', 'body']);
      expect(retrieved.filterableFields).toEqual(['status', 'category']);
    });

    test('getIndexSettings throws for nonexistent index', async () => {
      expect(provider.getIndexSettings('nonexistent')).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Document operations
  // --------------------------------------------------------------------------

  describe('indexDocument / indexDocuments', () => {
    beforeEach(async () => {
      await provider.createOrUpdateIndex(INDEX, settings);
    });

    test('indexDocument adds a single document', async () => {
      await provider.indexDocument(INDEX, { id: '1', title: 'Test' }, '1');
      const indexes = await provider.listIndexes();
      expect(indexes[0].documentCount).toBe(1);
    });

    test('indexDocuments adds multiple documents', async () => {
      const docs = makeDocs(5);
      await provider.indexDocuments(INDEX, docs, 'id');
      const indexes = await provider.listIndexes();
      expect(indexes[0].documentCount).toBe(5);
    });

    test('indexDocument overwrites existing document with same id', async () => {
      await provider.indexDocument(INDEX, { id: '1', title: 'Original' }, '1');
      await provider.indexDocument(INDEX, { id: '1', title: 'Updated' }, '1');

      const result = await provider.search(INDEX, { q: 'Updated' });
      expect(result.totalHits).toBe(1);
      expect(result.hits[0].document.title).toBe('Updated');
    });
  });

  describe('deleteDocument / deleteDocuments', () => {
    beforeEach(async () => {
      await provider.createOrUpdateIndex(INDEX, settings);
      await provider.indexDocuments(INDEX, makeDocs(5), 'id');
    });

    test('deleteDocument removes a single document', async () => {
      await provider.deleteDocument(INDEX, 'doc-1');
      const indexes = await provider.listIndexes();
      expect(indexes[0].documentCount).toBe(4);
    });

    test('deleteDocuments removes multiple documents', async () => {
      await provider.deleteDocuments(INDEX, ['doc-1', 'doc-2', 'doc-3']);
      const indexes = await provider.listIndexes();
      expect(indexes[0].documentCount).toBe(2);
    });
  });

  describe('clearIndex', () => {
    test('removes all documents from an index', async () => {
      await provider.createOrUpdateIndex(INDEX, settings);
      await provider.indexDocuments(INDEX, makeDocs(10), 'id');
      await provider.clearIndex(INDEX);
      const indexes = await provider.listIndexes();
      expect(indexes[0].documentCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  describe('search', () => {
    beforeEach(async () => {
      await provider.createOrUpdateIndex(INDEX, settings);
      await provider.indexDocuments(INDEX, makeDocs(10), 'id');
    });

    test('text matching returns relevant hits', async () => {
      const result = await provider.search(INDEX, { q: 'Title 1' });
      expect(result.totalHits).toBeGreaterThan(0);
      expect(result.query).toBe('Title 1');
      expect(result.indexName).toBe(INDEX);
    });

    test('empty query returns all documents', async () => {
      const result = await provider.search(INDEX, { q: '' });
      expect(result.totalHits).toBe(10);
    });

    test('filtering narrows results', async () => {
      const result = await provider.search(INDEX, {
        q: '',
        filter: { field: 'status', op: '=', value: 'published' },
      });
      expect(result.hits.every(h => h.document.status === 'published')).toBe(true);
    });

    test('sorting orders results', async () => {
      const result = await provider.search(INDEX, {
        q: '',
        sort: [{ field: 'createdAt', direction: 'asc' }],
      });
      const dates = result.hits.map(h => h.document.createdAt as string);
      const sorted = [...dates].sort();
      expect(dates).toEqual(sorted);
    });

    test('offset-based pagination', async () => {
      const page1 = await provider.search(INDEX, { q: '', limit: 3, offset: 0 });
      const page2 = await provider.search(INDEX, { q: '', limit: 3, offset: 3 });

      expect(page1.hits).toHaveLength(3);
      expect(page2.hits).toHaveLength(3);
      expect(page1.offset).toBe(0);
      expect(page1.limit).toBe(3);

      const page1Ids = page1.hits.map(h => h.document.id);
      const page2Ids = page2.hits.map(h => h.document.id);
      expect(page1Ids).not.toEqual(page2Ids);
    });

    test('page-based pagination', async () => {
      const result = await provider.search(INDEX, { q: '', page: 1, hitsPerPage: 4 });
      expect(result.hits).toHaveLength(4);
      expect(result.page).toBe(1);
      expect(result.hitsPerPage).toBe(4);
      expect(result.totalPages).toBe(3); // 10 docs / 4 per page = 3 pages
    });

    test('highlighting wraps matched terms', async () => {
      await provider.indexDocument(
        INDEX,
        { id: 'hl-1', title: 'Searchable content', body: 'Some body' },
        'hl-1',
      );
      const result = await provider.search(INDEX, {
        q: 'Searchable',
        highlight: { fields: ['title'] },
      });
      const hit = result.hits.find(h => h.document.id === 'hl-1');
      expect(hit).toBeDefined();
      expect(hit!.highlights).toBeDefined();
      expect(hit!.highlights!.title).toContain('<mark>');
    });

    test('custom highlight tags', async () => {
      await provider.indexDocument(
        INDEX,
        { id: 'hl-2', title: 'Custom highlight', body: '' },
        'hl-2',
      );
      const result = await provider.search(INDEX, {
        q: 'Custom',
        highlight: { fields: ['title'], preTag: '<em>', postTag: '</em>' },
      });
      const hit = result.hits.find(h => h.document.id === 'hl-2');
      expect(hit?.highlights?.title).toContain('<em>');
      expect(hit?.highlights?.title).toContain('</em>');
    });

    test('showRankingScore includes score in hits', async () => {
      const result = await provider.search(INDEX, { q: 'Title', showRankingScore: true });
      expect(result.hits.length).toBeGreaterThan(0);
      for (const hit of result.hits) {
        expect(typeof hit.score).toBe('number');
      }
    });

    test('totalHitsRelation is exact', async () => {
      const result = await provider.search(INDEX, { q: '' });
      expect(result.totalHitsRelation).toBe('exact');
    });

    test('processingTimeMs is a number', async () => {
      const result = await provider.search(INDEX, { q: '' });
      expect(typeof result.processingTimeMs).toBe('number');
    });
  });

  // --------------------------------------------------------------------------
  // Suggest
  // --------------------------------------------------------------------------

  describe('suggest', () => {
    beforeEach(async () => {
      await provider.createOrUpdateIndex(INDEX, settings);
      await provider.indexDocuments(
        INDEX,
        [
          { id: '1', title: 'Apple pie recipe', body: '' },
          { id: '2', title: 'Applesauce tips', body: '' },
          { id: '3', title: 'Banana bread', body: '' },
        ],
        'id',
      );
    });

    test('returns prefix-matched suggestions', async () => {
      const result = await provider.suggest(INDEX, { q: 'App' });
      expect(result.suggestions.length).toBeGreaterThan(0);
      for (const s of result.suggestions) {
        expect(s.text.toLowerCase()).toContain('app');
      }
    });

    test('respects limit', async () => {
      const result = await provider.suggest(INDEX, { q: 'App', limit: 1 });
      expect(result.suggestions.length).toBeLessThanOrEqual(1);
    });

    test('highlight option wraps matches', async () => {
      const result = await provider.suggest(INDEX, { q: 'App', highlight: true });
      for (const s of result.suggestions) {
        expect(s.highlight).toBeDefined();
        expect(s.highlight).toContain('<mark>');
      }
    });

    test('processingTimeMs is a number', async () => {
      const result = await provider.suggest(INDEX, { q: 'test' });
      expect(typeof result.processingTimeMs).toBe('number');
    });
  });

  // --------------------------------------------------------------------------
  // multiSearch
  // --------------------------------------------------------------------------

  describe('multiSearch', () => {
    test('executes multiple queries and returns results per query', async () => {
      await provider.createOrUpdateIndex('idx_a', settings);
      await provider.createOrUpdateIndex('idx_b', settings);
      await provider.indexDocuments('idx_a', [{ id: '1', title: 'Alpha', body: '' }], 'id');
      await provider.indexDocuments('idx_b', [{ id: '1', title: 'Beta', body: '' }], 'id');

      const results = await provider.multiSearch([
        { indexName: 'idx_a', query: { q: 'Alpha' } },
        { indexName: 'idx_b', query: { q: 'Beta' } },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].hits[0].document.title).toBe('Alpha');
      expect(results[1].hits[0].document.title).toBe('Beta');
    });
  });

  // --------------------------------------------------------------------------
  // Provider name
  // --------------------------------------------------------------------------

  test('provider name is db-native', () => {
    expect(provider.name).toBe('db-native');
  });
});
