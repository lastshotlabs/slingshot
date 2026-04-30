import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { createDbNativeProvider } from '../../src/providers/dbNative';
import type { SearchProvider, SearchIndexSettings } from '../../src/types/provider';

let provider: ReturnType<typeof createDbNativeProvider>;

beforeAll(() => {
  provider = createDbNativeProvider();
});

afterAll(async () => {
  await provider.teardown();
});

const DEFAULT_SETTINGS: SearchIndexSettings = {
  primaryKey: 'id',
  searchableFields: ['title', 'status', 'tags'],
};

async function seedTestData(
  provider: ReturnType<typeof createDbNativeProvider>,
  indexName: string,
) {
  await provider.createOrUpdateIndex(indexName, DEFAULT_SETTINGS);
  await provider.indexDocuments(indexName, [
    { id: '1', title: 'Getting Started', status: 'published', score: 10, tags: ['docs'] },
    { id: '2', title: 'Advanced Configuration', status: 'published', score: 8, tags: ['docs', 'config'] },
    { id: '3', title: 'API Reference', status: 'draft', score: 6, tags: ['api'] },
    { id: '4', title: 'Deployment Guide', status: 'published', score: 9, tags: ['ops'] },
    { id: '5', title: 'Configuration Reference', status: 'draft', score: 5, tags: ['config', 'docs'] },
  ], 'id');
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('dbNative provider lifecycle', () => {
  it('connects without error', async () => {
    await expect(provider.connect()).resolves.toBeUndefined();
  });

  it('reports healthy after connect', async () => {
    const health = await provider.healthCheck();
    expect(health.status).toBe('ok');
  });

  it('teardown is safe to call multiple times', async () => {
    const p = createDbNativeProvider();
    await p.connect();
    await p.teardown();
    await p.teardown(); // double teardown should not throw
  });
});

// ---------------------------------------------------------------------------
// Index management
// ---------------------------------------------------------------------------

describe('dbNative index management', () => {
  const indexName = 'test_index_mgmt';

  afterAll(async () => {
    try { await provider.deleteIndex(indexName); } catch {}
  });

  it('creates an index', async () => {
    await provider.createOrUpdateIndex(indexName, { primaryKey: 'id' });
    const indexes = await provider.listIndexes();
    expect(indexes).toContain(indexName);
  });

  it('retrieves index settings', async () => {
    const settings = await provider.getIndexSettings(indexName);
    expect(settings.primaryKey).toBe('id');
  });

  it('throws SearchIndexNotFoundError for a non-existent index', async () => {
    await expect(provider.getIndexSettings('nonexistent_index'))
      .rejects.toThrow('Index');
  });

  it('deletes an index', async () => {
    await provider.createOrUpdateIndex(`${indexName}_to_delete`, { primaryKey: 'id' });
    await provider.deleteIndex(`${indexName}_to_delete`);
    const indexes = await provider.listIndexes();
    expect(indexes).not.toContain(`${indexName}_to_delete`);
  });

  it('listIndexes includes the created index', async () => {
    const indexes = await provider.listIndexes();
    expect(Array.isArray(indexes)).toBe(true);
    expect(indexes).toContain(indexName);
  });
});

// ---------------------------------------------------------------------------
// Document CRUD
// ---------------------------------------------------------------------------

describe('dbNative document operations', () => {
  const indexName = 'test_docs';

  beforeAll(async () => {
    await provider.createOrUpdateIndex(indexName, { primaryKey: 'id' });
  });

  afterAll(async () => {
    await provider.deleteIndex(indexName);
  });

  it('indexes a single document', async () => {
    await provider.indexDocument(indexName, { id: 'doc1', title: 'Hello World' });
    const results = await provider.search(indexName, { q: 'Hello' });
    expect(results.hits.length).toBeGreaterThan(0);
    expect(results.hits[0]?.document?.title).toBe('Hello World');
  });

  it('indexes multiple documents', async () => {
    await provider.indexDocuments(indexName, [
      { id: 'batch1', title: 'Batch One' },
      { id: 'batch2', title: 'Batch Two' },
    ]);
    const results = await provider.search(indexName, { q: 'Batch' });
    expect(results.hits.length).toBeGreaterThanOrEqual(2);
  });

  it('deletes a single document', async () => {
    await provider.indexDocument(indexName, { id: 'del1', title: 'To Delete' });
    await provider.deleteDocument(indexName, 'del1');
    const results = await provider.search(indexName, { q: 'Delete' });
    expect(results.hits.find(h => h.document?.id === 'del1')).toBeUndefined();
  });

  it('deletes multiple documents', async () => {
    await provider.indexDocuments(indexName, [
      { id: 'del-batch-1', title: 'DB1' },
      { id: 'del-batch-2', title: 'DB2' },
    ]);
    await provider.deleteDocuments(indexName, ['del-batch-1', 'del-batch-2']);
    const results = await provider.search(indexName, { q: 'DB' });
    expect(results.hits).toHaveLength(0);
  });

  it('clears the index', async () => {
    await provider.indexDocument(indexName, { id: 'clear1', title: 'Clear Me' });
    await provider.clearIndex(indexName);
    const results = await provider.search(indexName, { q: 'Clear' });
    expect(results.hits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('dbNative search', () => {
  const indexName = 'test_search';

  beforeAll(async () => {
    await seedTestData(provider, indexName);
  });

  afterAll(async () => {
    await provider.deleteIndex(indexName);
  });

  it('returns all documents on empty query', async () => {
    const results = await provider.search(indexName, {});
    expect(results.hits.length).toBeGreaterThanOrEqual(5);
  });

  it('searches by text', async () => {
    const results = await provider.search(indexName, { q: 'Configuration' });
    expect(results.hits.length).toBeGreaterThanOrEqual(2);
    const titles = results.hits.map(h => h.document?.title);
    expect(titles).toContain('Advanced Configuration');
  });

  it('supports pagination with limit and offset', async () => {
    const page1 = await provider.search(indexName, { limit: 2, offset: 0 });
    expect(page1.hits).toHaveLength(2);
    const page2 = await provider.search(indexName, { limit: 2, offset: 2 });
    expect(page2.hits).toHaveLength(2);
    // Different documents on different pages
    const ids1 = page1.hits.map(h => h.document?.id).sort();
    const ids2 = page2.hits.map(h => h.document?.id).sort();
    const overlap = ids1.filter(id => ids2.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it('throws SearchPaginationError for offset exceeding safe max', async () => {
    // dbNative has a MAX_DB_NATIVE_OFFSET; default when not configured is very high
    const hugeOffset = 10_000_000;
    await expect(provider.search(indexName, { offset: hugeOffset }))
      .rejects.toThrow('offset');
  });

  it('filters by field equality', async () => {
    const results = await provider.search(indexName, {
      filter: { field: 'status', op: '=', value: 'published' },
    });
    expect(results.hits.length).toBeGreaterThanOrEqual(3);
    for (const hit of results.hits) {
      expect(hit.document?.status).toBe('published');
    }
  });

  it('supports $and compound filters', async () => {
    const results = await provider.search(indexName, {
      filter: {
        $and: [
          { field: 'status', op: '=', value: 'published' },
          { field: 'score', op: '>=', value: 9 },
        ],
      },
    });
    expect(results.hits.length).toBeGreaterThanOrEqual(2);
    for (const hit of results.hits) {
      expect(hit.document?.status).toBe('published');
      expect(hit.document?.score).toBeGreaterThanOrEqual(9);
    }
  });

  it('supports $or compound filters', async () => {
    const results = await provider.search(indexName, {
      filter: {
        $or: [
          { field: 'status', op: '=', value: 'draft' },
          { field: 'score', op: '>=', value: 9 },
        ],
      },
    });
    expect(results.hits.length).toBeGreaterThanOrEqual(3);
  });

  it('supports sorting by field', async () => {
    const results = await provider.search(indexName, {
      sort: [{ field: 'score', direction: 'desc' }],
    });
    expect(results.hits.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < results.hits.length - 1; i++) {
      expect(results.hits[i]!.document!.score)
        .toBeGreaterThanOrEqual(results.hits[i + 1]!.document!.score as number);
    }
  });

  it('returns facet stats when requested', async () => {
    const results = await provider.search(indexName, { facets: ['status', 'tags'] });
    expect(results.facets).toBeDefined();
    expect(results.facets?.status).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Suggest
// ---------------------------------------------------------------------------

describe('dbNative suggest', () => {
  const indexName = 'test_suggest';

  beforeAll(async () => {
    await seedTestData(provider, indexName);
  });

  afterAll(async () => {
    await provider.deleteIndex(indexName);
  });

  it('returns suggestions for a prefix query', async () => {
    const results = await provider.suggest(indexName, { q: 'Con', field: 'title' });
    expect(results.suggestions?.length).toBeGreaterThan(0);
  });

  it('returns empty suggestions for unmatched prefix', async () => {
    const results = await provider.suggest(indexName, { q: 'ZZZZZZZ', field: 'title' });
    expect(results.suggestions?.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('dbNative edge cases', () => {
  const indexName = 'test_edges';

  beforeAll(async () => {
    await provider.createOrUpdateIndex(indexName, { primaryKey: 'id' });
  });

  afterAll(async () => {
    await provider.deleteIndex(indexName);
  });

  it('search on empty index returns zero hits', async () => {
    const emptyIndex = 'empty_test_idx';
    await provider.createOrUpdateIndex(emptyIndex, { primaryKey: 'id' });
    const results = await provider.search(emptyIndex, { q: 'anything' });
    expect(results.hits).toHaveLength(0);
    await provider.deleteIndex(emptyIndex);
  });

  it('deleteDocument on non-existent ID does not throw', async () => {
    await expect(provider.deleteDocument(indexName, 'no-such-id')).resolves.toBeUndefined();
  });

  it('waitForTask is a no-op', async () => {
    await expect(provider.waitForTask(indexName, 12345)).resolves.toBeUndefined();
  });

  it('handles documents with extra fields gracefully', async () => {
    await provider.indexDocument(indexName, {
      id: 'extra-fields',
      title: 'Extra',
      unknownField: true,
      nested: { deep: 'value' },
    });
    const results = await provider.search(indexName, { q: 'Extra' });
    expect(results.hits.length).toBe(1);
    expect(results.hits[0]?.document?.nested).toEqual({ deep: 'value' });
  });

  it('search with no matches returns empty hits', async () => {
    const results = await provider.search(indexName, {
      q: 'thisdoesnotmatchanythingatall',
    });
    expect(results.hits).toHaveLength(0);
  });

  it('search returns estimatedTotalHits', async () => {
    const results = await provider.search(indexName, { q: 'Extra' });
    expect(typeof results.estimatedTotalHits).toBe('number');
  });

  it('handles highlighting requests', async () => {
    await provider.indexDocument(indexName, { id: 'hl-test', title: 'Highlight Test', body: 'Some search content here' });
    const results = await provider.search(indexName, { q: 'search', attributesToHighlight: ['body'] });
    expect(results.hits.length).toBeGreaterThan(0);
    // Highlighting is applied when attributesToHighlight is set
    const hit = results.hits.find(h => h.document?.id === 'hl-test');
    expect(hit).toBeDefined();
  });
});
