/**
 * Provider contract tests.
 *
 * Parameterized over available providers. The DB-native provider runs without
 * external services. External providers are gated behind env vars.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDbNativeProvider } from '../../src/providers/dbNative';
import type { SearchIndexSettings, SearchProvider } from '../../src/types/provider';

// ============================================================================
// Provider registry
// ============================================================================

const TEST_INDEX = 'test_items';
const PRIMARY_KEY = 'id';

const BASE_SETTINGS: SearchIndexSettings = {
  searchableFields: ['title', 'body'],
  filterableFields: ['category', 'status'],
  sortableFields: ['createdAt'],
  facetableFields: ['category'],
};

interface ProviderEntry {
  name: string;
  create: () => SearchProvider;
}

const providers: ProviderEntry[] = [{ name: 'db-native', create: () => createDbNativeProvider() }];

const MEILISEARCH_URL = process.env.TEST_MEILISEARCH_URL;
const MEILISEARCH_KEY = process.env.TEST_MEILISEARCH_KEY ?? '';
if (MEILISEARCH_URL) {
  // Dynamically add Meilisearch when env is configured
  const { createMeilisearchProvider } = await import('../../src/providers/meilisearch');
  providers.push({
    name: 'meilisearch',
    create: () =>
      createMeilisearchProvider({
        provider: 'meilisearch',
        url: MEILISEARCH_URL,
        apiKey: MEILISEARCH_KEY,
      }),
  });
}

const TYPESENSE_URL = process.env.TEST_TYPESENSE_URL;
const TYPESENSE_KEY = process.env.TEST_TYPESENSE_KEY ?? '';
if (TYPESENSE_URL) {
  const { createTypesenseProvider } = await import('../../src/providers/typesense');
  providers.push({
    name: 'typesense',
    create: () =>
      createTypesenseProvider({ provider: 'typesense', url: TYPESENSE_URL, apiKey: TYPESENSE_KEY }),
  });
}

// ============================================================================
// Contract test suite — parameterized
// ============================================================================

for (const { name, create } of providers) {
  describe(`${name} provider contract`, () => {
    let provider: SearchProvider;

    beforeEach(async () => {
      provider = create();
      await provider.connect();
    });

    afterEach(async () => {
      // Best-effort cleanup
      try {
        await provider.deleteIndex(TEST_INDEX);
      } catch {
        // Ignore if index doesn't exist
      }
      await provider.teardown();
    });

    // --- createOrUpdateIndex ---

    it('createOrUpdateIndex() creates an index', async () => {
      await provider.createOrUpdateIndex(TEST_INDEX, BASE_SETTINGS);
      const indexes = await provider.listIndexes();
      const found = indexes.find(i => i.name === TEST_INDEX);
      expect(found).toBeDefined();
      expect(found!.name).toBe(TEST_INDEX);
    });

    it('createOrUpdateIndex() is idempotent (calling twice does not throw)', async () => {
      await provider.createOrUpdateIndex(TEST_INDEX, BASE_SETTINGS);
      await provider.createOrUpdateIndex(TEST_INDEX, {
        ...BASE_SETTINGS,
        searchableFields: ['title', 'body', 'tags'],
      });
      const settings = await provider.getIndexSettings(TEST_INDEX);
      expect(settings).toBeDefined();
    });

    // --- indexDocuments ---

    it('indexDocuments() indexes a batch and returns task handle or void', async () => {
      await provider.createOrUpdateIndex(TEST_INDEX, BASE_SETTINGS);
      const docs = [
        {
          id: '1',
          title: 'Alpha',
          body: 'First doc',
          category: 'news',
          status: 'active',
          createdAt: '2024-01-01',
        },
        {
          id: '2',
          title: 'Beta',
          body: 'Second doc',
          category: 'tech',
          status: 'active',
          createdAt: '2024-01-02',
        },
      ];
      const result = await provider.indexDocuments(TEST_INDEX, docs, PRIMARY_KEY);
      // Result is either a task handle or void — both are valid
      if (result !== undefined) {
        expect(typeof result.taskId === 'string' || typeof result.taskId === 'number').toBe(true);
      }
    });

    // --- indexDocument ---

    it('indexDocument() indexes a single document', async () => {
      await provider.createOrUpdateIndex(TEST_INDEX, BASE_SETTINGS);
      await provider.indexDocument(
        TEST_INDEX,
        {
          id: 'single-1',
          title: 'Single doc',
          body: 'Content',
          category: 'news',
          status: 'active',
          createdAt: '2024-01-01',
        },
        'single-1',
      );
      const result = await provider.search(TEST_INDEX, { q: 'Single doc' });
      expect(result.totalHits).toBeGreaterThanOrEqual(1);
    });

    // --- deleteDocument ---

    it('deleteDocument() removes a document by ID', async () => {
      await provider.createOrUpdateIndex(TEST_INDEX, BASE_SETTINGS);
      await provider.indexDocument(
        TEST_INDEX,
        {
          id: 'del-1',
          title: 'ToDelete',
          body: 'going away',
          category: 'news',
          status: 'active',
          createdAt: '2024-01-01',
        },
        'del-1',
      );

      // Wait for external providers via task
      await provider.deleteDocument(TEST_INDEX, 'del-1');

      const result = await provider.search(TEST_INDEX, { q: 'ToDelete' });
      expect(result.hits.every(h => (h.document as Record<string, unknown>).id !== 'del-1')).toBe(
        true,
      );
    });

    // --- deleteDocuments ---

    it('deleteDocuments() removes a batch of documents', async () => {
      await provider.createOrUpdateIndex(TEST_INDEX, BASE_SETTINGS);
      const docs = [
        {
          id: 'batch-del-1',
          title: 'Batch One',
          body: 'x',
          category: 'news',
          status: 'active',
          createdAt: '2024-01-01',
        },
        {
          id: 'batch-del-2',
          title: 'Batch Two',
          body: 'y',
          category: 'tech',
          status: 'active',
          createdAt: '2024-01-02',
        },
      ];
      await provider.indexDocuments(TEST_INDEX, docs, PRIMARY_KEY);
      await provider.deleteDocuments(TEST_INDEX, ['batch-del-1', 'batch-del-2']);

      const result = await provider.search(TEST_INDEX, { q: 'Batch' });
      const remaining = result.hits.filter(h => {
        const id = (h.document as Record<string, unknown>).id;
        return id === 'batch-del-1' || id === 'batch-del-2';
      });
      expect(remaining.length).toBe(0);
    });

    // --- search ---

    it('search() full-text query returns matching hits with id and document', async () => {
      await provider.createOrUpdateIndex(TEST_INDEX, BASE_SETTINGS);
      await provider.indexDocuments(
        TEST_INDEX,
        [
          {
            id: 'ft-1',
            title: 'Avocado toast recipe',
            body: 'How to make toast',
            category: 'food',
            status: 'active',
            createdAt: '2024-01-01',
          },
          {
            id: 'ft-2',
            title: 'TypeScript tips',
            body: 'Advanced TS patterns',
            category: 'tech',
            status: 'active',
            createdAt: '2024-01-02',
          },
        ],
        PRIMARY_KEY,
      );

      const result = await provider.search(TEST_INDEX, { q: 'Avocado' });
      expect(result.hits.length).toBeGreaterThanOrEqual(1);
      const hit = result.hits[0];
      expect(hit.document).toBeDefined();
      expect((hit.document as Record<string, unknown>).id).toBe('ft-1');
    });

    it('search() with empty query returns results without crashing', async () => {
      await provider.createOrUpdateIndex(TEST_INDEX, BASE_SETTINGS);
      await provider.indexDocuments(
        TEST_INDEX,
        [
          {
            id: 'empty-1',
            title: 'Some doc',
            body: 'content',
            category: 'news',
            status: 'active',
            createdAt: '2024-01-01',
          },
        ],
        PRIMARY_KEY,
      );

      const result = await provider.search(TEST_INDEX, { q: '' });
      expect(result).toBeDefined();
      expect(Array.isArray(result.hits)).toBe(true);
    });

    it('search() with filter narrows results', async () => {
      await provider.createOrUpdateIndex(TEST_INDEX, BASE_SETTINGS);
      await provider.indexDocuments(
        TEST_INDEX,
        [
          {
            id: 'f-1',
            title: 'Article one',
            body: 'content',
            category: 'news',
            status: 'active',
            createdAt: '2024-01-01',
          },
          {
            id: 'f-2',
            title: 'Article two',
            body: 'content',
            category: 'tech',
            status: 'active',
            createdAt: '2024-01-02',
          },
          {
            id: 'f-3',
            title: 'Article three',
            body: 'content',
            category: 'news',
            status: 'archived',
            createdAt: '2024-01-03',
          },
        ],
        PRIMARY_KEY,
      );

      const result = await provider.search(TEST_INDEX, {
        q: '',
        filter: { field: 'category', op: '=', value: 'news' },
      });

      const categories = result.hits.map(h => (h.document as Record<string, unknown>).category);
      expect(categories.every(c => c === 'news')).toBe(true);
    });

    it('search() limit/offset pagination returns the right window', async () => {
      await provider.createOrUpdateIndex(TEST_INDEX, BASE_SETTINGS);
      const docs = Array.from({ length: 5 }, (_, i) => ({
        id: `page-${i + 1}`,
        title: `Page doc ${i + 1}`,
        body: 'pagination test',
        category: 'news',
        status: 'active',
        createdAt: `2024-01-0${i + 1}`,
      }));
      await provider.indexDocuments(TEST_INDEX, docs, PRIMARY_KEY);

      const page1 = await provider.search(TEST_INDEX, { q: 'pagination', limit: 2, offset: 0 });
      const page2 = await provider.search(TEST_INDEX, { q: 'pagination', limit: 2, offset: 2 });

      expect(page1.hits.length).toBe(2);
      expect(page2.hits.length).toBe(2);

      // Pages should not overlap
      const page1Ids = page1.hits.map(h => (h.document as Record<string, unknown>).id);
      const page2Ids = page2.hits.map(h => (h.document as Record<string, unknown>).id);
      const overlap = page1Ids.filter(id => page2Ids.includes(id));
      expect(overlap.length).toBe(0);
    });

    // --- suggest ---

    it('suggest() returns completion suggestions', async () => {
      await provider.createOrUpdateIndex(TEST_INDEX, BASE_SETTINGS);
      await provider.indexDocuments(
        TEST_INDEX,
        [
          {
            id: 'sug-1',
            title: 'JavaScript frameworks',
            body: 'React Angular Vue',
            category: 'tech',
            status: 'active',
            createdAt: '2024-01-01',
          },
          {
            id: 'sug-2',
            title: 'Java programming',
            body: 'Spring Boot',
            category: 'tech',
            status: 'active',
            createdAt: '2024-01-02',
          },
        ],
        PRIMARY_KEY,
      );

      const result = await provider.suggest(TEST_INDEX, { q: 'Java', limit: 5 });
      expect(result.suggestions).toBeDefined();
      expect(Array.isArray(result.suggestions)).toBe(true);
      // At least one suggestion should contain "Java"
      expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
      expect(result.suggestions.every(s => typeof s.text === 'string')).toBe(true);
    });

    // --- health ---

    it('healthCheck() returns { healthy: true } when connected', async () => {
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(typeof health.provider).toBe('string');
      expect(typeof health.latencyMs).toBe('number');
    });

    // --- teardown ---

    it('teardown() does not throw', async () => {
      await provider.createOrUpdateIndex(TEST_INDEX, BASE_SETTINGS);
      await expect(provider.teardown()).resolves.toBeUndefined();
    });

    it('teardown() can be called multiple times without throwing', async () => {
      await provider.teardown();
      await expect(provider.teardown()).resolves.toBeUndefined();
    });
  });
}
