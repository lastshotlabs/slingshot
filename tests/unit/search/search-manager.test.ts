import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { createSearchManager } from '../../../packages/slingshot-search/src/searchManager';
import type { SearchManager } from '../../../packages/slingshot-search/src/searchManager';
import { createSearchTransformRegistry } from '../../../packages/slingshot-search/src/transformRegistry';
import type { SearchTransformRegistry } from '../../../packages/slingshot-search/src/transformRegistry';
import type { SearchPluginConfig } from '../../../packages/slingshot-search/src/types/config';

// ============================================================================
// Helpers
// ============================================================================

function makeEntity(overrides?: Partial<ResolvedEntityConfig>): ResolvedEntityConfig {
  return {
    name: 'Article',
    fields: {},
    _pkField: 'id',
    _storageName: 'articles',
    search: {
      fields: {
        title: { searchable: true, weight: 10 },
        body: { searchable: true, weight: 1 },
        status: { filterable: true },
        category: { filterable: true, facetable: true },
      },
    },
    ...overrides,
  } as ResolvedEntityConfig;
}

function makePluginConfig(overrides?: Partial<SearchPluginConfig>): SearchPluginConfig {
  return {
    providers: {
      default: { provider: 'db-native' },
    },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('SearchManager (db-native)', () => {
  let manager: SearchManager;
  let transformRegistry: SearchTransformRegistry;

  beforeEach(() => {
    transformRegistry = createSearchTransformRegistry();
  });

  afterEach(async () => {
    if (manager) await manager.teardown();
  });

  // --------------------------------------------------------------------------
  // initialize
  // --------------------------------------------------------------------------

  describe('initialize', () => {
    test('initializes with config-driven entities', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });

      const entity = makeEntity();
      await manager.initialize([entity]);

      expect(manager.getIndexName('articles')).toBe('articles');
      expect(manager.getProvider('articles')).toBeDefined();
    });

    test('applies indexPrefix to index names', async () => {
      const pluginConfig = makePluginConfig({ indexPrefix: 'test_' });
      manager = createSearchManager({ pluginConfig, transformRegistry });

      await manager.initialize([makeEntity()]);
      expect(manager.getIndexName('articles')).toBe('test_articles');
    });

    test('initialize is idempotent', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });

      const entity = makeEntity();
      await manager.initialize([entity]);
      await manager.initialize([entity]);

      expect(manager.getIndexName('articles')).toBe('articles');
    });
  });

  // --------------------------------------------------------------------------
  // ensureConfigEntity
  // --------------------------------------------------------------------------

  describe('ensureConfigEntity', () => {
    test('lazily initializes a single entity', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });

      const entity = makeEntity();
      await manager.ensureConfigEntity(entity);

      expect(manager.getIndexName('articles')).toBe('articles');
      expect(manager.getProvider('articles')).toBeDefined();
    });

    test('skips entities without search config', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });

      const entity = makeEntity({ search: undefined });
      await manager.ensureConfigEntity(entity);

      expect(manager.getIndexName('articles')).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // getSearchClient
  // --------------------------------------------------------------------------

  describe('getSearchClient', () => {
    test('returns a client that can search', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });
      await manager.initialize([makeEntity()]);

      const client = manager.getSearchClient('articles');
      await client.indexDocument({ id: '1', title: 'Hello world', body: 'Content' });

      const result = await client.search({ q: 'Hello' });
      expect(result.totalHits).toBe(1);
      expect(result.hits[0].document.title).toBe('Hello world');
    });

    test('throws for unknown entity', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });
      await manager.initialize([]);

      expect(() => manager.getSearchClient('nonexistent')).toThrow();
    });

    test('client can index and remove documents', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });
      await manager.initialize([makeEntity()]);

      const client = manager.getSearchClient('articles');
      await client.indexDocument({ id: '1', title: 'Test', body: '' });
      await client.removeDocument('1');

      const result = await client.search({ q: '' });
      expect(result.totalHits).toBe(0);
    });

    test('client can batch-index documents', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });
      await manager.initialize([makeEntity()]);

      const client = manager.getSearchClient('articles');
      await client.indexDocuments([
        { id: '1', title: 'One', body: '' },
        { id: '2', title: 'Two', body: '' },
      ]);

      const result = await client.search({ q: '' });
      expect(result.totalHits).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // getIndexName / getIndexSettings / getProvider
  // --------------------------------------------------------------------------

  describe('accessors', () => {
    test('getIndexName returns undefined for unknown entity', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });
      await manager.initialize([]);
      expect(manager.getIndexName('unknown')).toBeUndefined();
    });

    test('getIndexSettings returns derived settings', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });
      await manager.initialize([makeEntity()]);

      const settings = manager.getIndexSettings('articles');
      expect(settings).toBeDefined();
      expect(settings!.searchableFields).toContain('title');
      expect(settings!.searchableFields).toContain('body');
      expect(settings!.filterableFields).toContain('status');
    });

    test('getProvider returns the provider instance for an entity', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });
      await manager.initialize([makeEntity()]);

      const provider = manager.getProvider('articles');
      expect(provider).toBeDefined();
      expect(provider!.name).toBe('db-native');
    });

    test('getProvider returns undefined for unknown entity', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });
      await manager.initialize([]);
      expect(manager.getProvider('unknown')).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // teardown
  // --------------------------------------------------------------------------

  describe('teardown', () => {
    test('clears all state', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });
      await manager.initialize([makeEntity()]);

      await manager.teardown();

      expect(manager.getIndexName('articles')).toBeUndefined();
      expect(manager.getProvider('articles')).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Federated search
  // --------------------------------------------------------------------------

  describe('federatedSearch', () => {
    test('searches across multiple indexes', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });

      const articles = makeEntity();
      const posts = makeEntity({
        name: 'Post',
        _storageName: 'posts',
        search: {
          fields: {
            title: { searchable: true },
            content: { searchable: true },
          },
        },
      });

      await manager.initialize([articles, posts]);

      const articleClient = manager.getSearchClient('articles');
      const postClient = manager.getSearchClient('posts');

      await articleClient.indexDocument({ id: '1', title: 'Shared keyword alpha', body: '' });
      await postClient.indexDocument({ id: '1', title: 'Shared keyword alpha', content: '' });

      const result = await manager.federatedSearch({
        q: 'alpha',
        queries: [{ indexName: 'articles' }, { indexName: 'posts' }],
      });

      expect(result.totalHits).toBe(2);
      expect(result.hits).toHaveLength(2);
      expect(result.indexes).toHaveProperty('articles');
      expect(result.indexes).toHaveProperty('posts');
    });

    test('respects per-index weight in weighted merge', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });

      const articles = makeEntity();
      const posts = makeEntity({
        name: 'Post',
        _storageName: 'posts',
        search: {
          fields: { title: { searchable: true }, content: { searchable: true } },
        },
      });

      await manager.initialize([articles, posts]);

      const articleClient = manager.getSearchClient('articles');
      const postClient = manager.getSearchClient('posts');

      await articleClient.indexDocument({ id: '1', title: 'Keyword', body: '' });
      await postClient.indexDocument({ id: '1', title: 'Keyword', content: '' });

      const result = await manager.federatedSearch({
        q: 'Keyword',
        queries: [
          { indexName: 'articles', weight: 2 },
          { indexName: 'posts', weight: 1 },
        ],
        merge: 'weighted',
      });

      expect(result.hits).toHaveLength(2);
      expect(result.hits[0].indexName).toBe('articles');
    });
  });

  // --------------------------------------------------------------------------
  // Custom primaryKey
  // --------------------------------------------------------------------------

  describe('custom primaryKey', () => {
    test('entity with non-id pkField gets primaryKey in settings', async () => {
      const pluginConfig = makePluginConfig();
      manager = createSearchManager({ pluginConfig, transformRegistry });

      const entity = makeEntity({ _pkField: 'slug' });
      await manager.initialize([entity]);

      const settings = manager.getIndexSettings('articles');
      expect(settings!.primaryKey).toBe('slug');
    });
  });
});
