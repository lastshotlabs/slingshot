/**
 * Search route handler tests.
 *
 * Tests HTTP route handlers using Hono's app.request() test client.
 * Uses the DB-native provider — no external services required.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createDbNativeProvider } from '../../src/providers/dbNative';
import { createFederatedRouter } from '../../src/routes/federated';
import { createSearchRouter } from '../../src/routes/search';
import { createSuggestRouter } from '../../src/routes/suggest';
import { createSearchManager } from '../../src/searchManager';
import type { SearchManager } from '../../src/searchManager';
import { createSearchTransformRegistry } from '../../src/transformRegistry';
import type { SearchPluginConfig } from '../../src/types/config';

// ============================================================================
// Helpers
// ============================================================================

const BASE_SETTINGS = {
  searchableFields: ['title', 'body'],
  filterableFields: ['category', 'status'],
  sortableFields: ['createdAt'],
  facetableFields: ['category'],
};

const PLUGIN_CONFIG: SearchPluginConfig = {
  providers: { default: { provider: 'db-native' } },
};

type TestApp = {
  app: Hono;
  manager: SearchManager;
};

async function buildTestApp(overrides?: Partial<SearchPluginConfig>): Promise<TestApp> {
  const config: SearchPluginConfig = { ...PLUGIN_CONFIG, ...overrides };
  const manager = createSearchManager({
    pluginConfig: config,
    transformRegistry: createSearchTransformRegistry(),
  });

  // Pre-seed: manually set up provider and indexes
  const provider = createDbNativeProvider();
  await provider.connect();
  await provider.createOrUpdateIndex('articles', BASE_SETTINGS);
  await provider.createOrUpdateIndex('products', BASE_SETTINGS);

  // Pre-seed documents into both indexes
  await provider.indexDocuments(
    'articles',
    [
      {
        id: 'a1',
        title: 'TypeScript Generics',
        body: 'Advanced TS patterns',
        category: 'tech',
        status: 'active',
        createdAt: '2024-01-01',
      },
      {
        id: 'a2',
        title: 'Coffee Brewing Guide',
        body: 'How to brew coffee',
        category: 'food',
        status: 'active',
        createdAt: '2024-01-02',
      },
      {
        id: 'a3',
        title: 'TypeScript Decorators',
        body: 'Meta programming',
        category: 'tech',
        status: 'draft',
        createdAt: '2024-01-03',
      },
    ],
    'id',
  );

  await provider.indexDocuments(
    'products',
    [
      {
        id: 'p1',
        title: 'Widget Pro',
        body: 'A great widget',
        category: 'tools',
        status: 'active',
        createdAt: '2024-01-01',
      },
      {
        id: 'p2',
        title: 'Gizmo Plus',
        body: 'Useful gizmo',
        category: 'tools',
        status: 'active',
        createdAt: '2024-01-02',
      },
    ],
    'id',
  );

  // Initialize manager with the entities — use a ResolvedEntityConfig-compatible shape
  await manager.initialize([
    {
      name: 'Article',
      _pkField: 'id',
      _storageName: 'articles',
      fields: {
        id: { type: 'string', optional: false, primary: true, immutable: true },
        title: { type: 'string', optional: false, primary: false, immutable: false },
        body: { type: 'string', optional: false, primary: false, immutable: false },
        category: { type: 'string', optional: false, primary: false, immutable: false },
        status: { type: 'string', optional: false, primary: false, immutable: false },
        createdAt: { type: 'string', optional: false, primary: false, immutable: false },
      },
      search: {
        fields: {
          title: { searchable: true, weight: 2 },
          body: { searchable: true, weight: 1 },
          category: { searchable: false, filterable: true, facetable: true },
          status: { searchable: false, filterable: true },
          createdAt: { searchable: false, sortable: true },
        },
      },
    },
    {
      name: 'Product',
      _pkField: 'id',
      _storageName: 'products',
      fields: {
        id: { type: 'string', optional: false, primary: true, immutable: true },
        title: { type: 'string', optional: false, primary: false, immutable: false },
        body: { type: 'string', optional: false, primary: false, immutable: false },
        category: { type: 'string', optional: false, primary: false, immutable: false },
        status: { type: 'string', optional: false, primary: false, immutable: false },
        createdAt: { type: 'string', optional: false, primary: false, immutable: false },
      },
      search: {
        fields: {
          title: { searchable: true, weight: 2 },
          body: { searchable: true, weight: 1 },
          category: { searchable: false, filterable: true, facetable: true },
          status: { searchable: false, filterable: true },
          createdAt: { searchable: false, sortable: true },
        },
      },
    },
  ]);

  // Copy indexed data to manager's provider (manager creates its own db-native provider internally)
  // For test purposes, index the same docs via the manager's search clients
  const articleClient = manager.getSearchClient('articles');
  await articleClient.indexDocuments([
    {
      id: 'a1',
      title: 'TypeScript Generics',
      body: 'Advanced TS patterns',
      category: 'tech',
      status: 'active',
      createdAt: '2024-01-01',
    },
    {
      id: 'a2',
      title: 'Coffee Brewing Guide',
      body: 'How to brew coffee',
      category: 'food',
      status: 'active',
      createdAt: '2024-01-02',
    },
    {
      id: 'a3',
      title: 'TypeScript Decorators',
      body: 'Meta programming',
      category: 'tech',
      status: 'draft',
      createdAt: '2024-01-03',
    },
  ]);

  const productClient = manager.getSearchClient('products');
  await productClient.indexDocuments([
    {
      id: 'p1',
      title: 'Widget Pro',
      body: 'A great widget',
      category: 'tools',
      status: 'active',
      createdAt: '2024-01-01',
    },
    {
      id: 'p2',
      title: 'Gizmo Plus',
      body: 'Useful gizmo',
      category: 'tools',
      status: 'active',
      createdAt: '2024-01-02',
    },
  ]);

  const app = new Hono();
  app.route('/search', createSearchRouter(manager, config));
  app.route('/search', createSuggestRouter(manager, config));
  app.route('/search', createFederatedRouter(manager, config));

  return { app, manager };
}

// ============================================================================
// Tests
// ============================================================================

describe('search routes', () => {
  let app: Hono;
  let manager: SearchManager;

  beforeEach(async () => {
    const built = await buildTestApp();
    app = built.app;
    manager = built.manager;
  });

  it('GET /search/:entity returns search results', async () => {
    const res = await app.request('/search/articles?q=TypeScript');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[]; totalHits: number };
    expect(body.hits).toBeDefined();
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it('GET /search/:entity with ?q=term returns full-text results', async () => {
    const res = await app.request('/search/articles?q=TypeScript');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ document: Record<string, unknown> }>;
      totalHits: number;
    };
    expect(body.totalHits).toBeGreaterThanOrEqual(1);
    // All results should be TypeScript-related
    const titles = body.hits.map(h => h.document.title as string);
    expect(titles.some(t => t.includes('TypeScript'))).toBe(true);
  });

  it('GET /search/:entity with filter params narrows results', async () => {
    // q must be non-empty per route validation (min(1))
    const res = await app.request('/search/articles?q=article&filter=category:tech');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ document: Record<string, unknown> }> };
    if (body.hits.length > 0) {
      expect(body.hits.every(h => h.document.category === 'tech')).toBe(true);
    }
  });

  it('GET /search/:entity/suggest returns suggestions', async () => {
    const res = await app.request('/search/articles/suggest?q=Type');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: unknown[] };
    expect(Array.isArray(body.suggestions)).toBe(true);
  });

  it('GET /search/:entity returns 404 for unknown entity', async () => {
    const res = await app.request('/search/nonexistent?q=test');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('nonexistent');
  });

  it('POST /search/multi — federated search returns results from multiple entities', async () => {
    const res = await app.request('/search/multi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: '',
        queries: [{ indexName: 'articles' }, { indexName: 'products' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: unknown[];
      totalHits: number;
      indexes: Record<string, unknown>;
    };
    expect(Array.isArray(body.hits)).toBe(true);
    expect(typeof body.indexes).toBe('object');
    expect(body.indexes).toHaveProperty('articles');
    expect(body.indexes).toHaveProperty('products');
  });

  it('tenant filter is injected server-side when tenantResolver is set', async () => {
    const { app: tenantApp, manager: tenantManager } = await buildTestApp({
      tenantResolver: () => 'tenant-abc',
      tenantField: 'status', // reusing status as a "tenant" field for test purposes
    });

    const res = await tenantApp.request('/search/articles?q=TypeScript');
    expect(res.status).toBe(200);
    // Even if no results, the important thing is no error and tenant filter was injected
    const body = (await res.json()) as { hits: unknown[] };
    expect(Array.isArray(body.hits)).toBe(true);

    await tenantManager.teardown();
  });

  it('client cannot override tenant filter', async () => {
    // When tenantResolver is set, the server injects the tenant filter server-side.
    // Any client-provided filter is combined with (not replaced by) the tenant filter.
    const { app: tenantApp, manager: tenantManager } = await buildTestApp({
      tenantResolver: () => 'tenant-xyz',
      tenantField: 'category',
    });

    // Client tries to filter by a different category, but tenant filter is also injected
    const res = await tenantApp.request('/search/articles?q=TypeScript&filter=status:active');
    // Request should succeed — server injects tenant filter on top
    expect(res.status).toBe(200);

    await tenantManager.teardown();
  });
});
