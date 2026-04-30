import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createDbNativeProvider } from '../../src/providers/dbNative';
import type { SearchIndexSettings } from '../../src/types/provider';

let provider: ReturnType<typeof createDbNativeProvider>;

beforeAll(async () => {
  provider = createDbNativeProvider();
  await provider.connect();
});

afterAll(async () => {
  await provider.teardown();
});

const DEFAULT_SETTINGS: SearchIndexSettings = {
  primaryKey: 'id',
  searchableFields: ['title', 'status', 'tags'],
  filterableFields: ['status', 'score', 'tags'],
  sortableFields: ['score'],
  facetableFields: ['status', 'tags'],
};

async function indexDoc(indexName: string, doc: Record<string, unknown>): Promise<void> {
  await provider.indexDocument(indexName, doc, String(doc['id']));
}

async function seedTestData(
  provider: ReturnType<typeof createDbNativeProvider>,
  indexName: string,
) {
  await provider.createOrUpdateIndex(indexName, DEFAULT_SETTINGS);
  await provider.indexDocuments(
    indexName,
    [
      { id: '1', title: 'Getting Started', status: 'published', score: 10, tags: ['docs'] },
      {
        id: '2',
        title: 'Advanced Configuration',
        status: 'published',
        score: 8,
        tags: ['docs', 'config'],
      },
      { id: '3', title: 'API Reference', status: 'draft', score: 6, tags: ['api'] },
      { id: '4', title: 'Deployment Guide', status: 'published', score: 9, tags: ['ops'] },
      {
        id: '5',
        title: 'Configuration Reference',
        status: 'draft',
        score: 5,
        tags: ['config', 'docs'],
      },
    ],
    'id',
  );
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
    expect(health.healthy).toBe(true);
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
    try {
      await provider.deleteIndex(indexName);
    } catch {
      // Index cleanup is best-effort across independently ordered tests.
    }
  });

  it('creates an index', async () => {
    await provider.createOrUpdateIndex(indexName, DEFAULT_SETTINGS);
    const indexes = await provider.listIndexes();
    expect(indexes.some(i => i.name === indexName)).toBe(true);
  });

  it('retrieves index settings', async () => {
    const settings = await provider.getIndexSettings(indexName);
    expect(settings.primaryKey).toBe('id');
  });

  it('throws SearchIndexNotFoundError for a non-existent index', async () => {
    await expect(provider.getIndexSettings('nonexistent_index')).rejects.toThrow('Index');
  });

  it('deletes an index', async () => {
    await provider.createOrUpdateIndex(`${indexName}_to_delete`, DEFAULT_SETTINGS);
    await provider.deleteIndex(`${indexName}_to_delete`);
    const indexes = await provider.listIndexes();
    expect(indexes.some(i => i.name === `${indexName}_to_delete`)).toBe(false);
  });

  it('listIndexes includes the created index', async () => {
    const indexes = await provider.listIndexes();
    expect(Array.isArray(indexes)).toBe(true);
    expect(indexes.some(i => i.name === indexName)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Document CRUD
// ---------------------------------------------------------------------------

describe('dbNative document operations', () => {
  const indexName = 'test_docs';

  beforeAll(async () => {
    await provider.createOrUpdateIndex(indexName, DEFAULT_SETTINGS);
  });

  afterAll(async () => {
    await provider.deleteIndex(indexName);
  });

  it('indexes a single document', async () => {
    await provider.indexDocument(indexName, { id: 'doc1', title: 'Hello World' }, 'doc1');
    const results = await provider.search(indexName, { q: 'Hello' });
    expect(results.hits.length).toBeGreaterThan(0);
  });

  it('indexes multiple documents', async () => {
    await provider.indexDocuments(
      indexName,
      [
        { id: 'batch1', title: 'Batch One' },
        { id: 'batch2', title: 'Batch Two' },
      ],
      'id',
    );
    const results = await provider.search(indexName, { q: 'Batch' });
    expect(results.hits.length).toBeGreaterThanOrEqual(2);
  });

  it('deletes a single document', async () => {
    await provider.indexDocument(indexName, { id: 'del1', title: 'To Delete' }, 'del1');
    await provider.deleteDocument(indexName, 'del1');
    const results = await provider.search(indexName, { q: 'Delete' });
    expect(results.hits.find(h => h.document?.id === 'del1')).toBeUndefined();
  });

  it('deletes multiple documents', async () => {
    await provider.indexDocuments(
      indexName,
      [
        { id: 'del-batch-1', title: 'DB1' },
        { id: 'del-batch-2', title: 'DB2' },
      ],
      'id',
    );
    await provider.deleteDocuments(indexName, ['del-batch-1', 'del-batch-2']);
    const results = await provider.search(indexName, { q: 'DB' });
    expect(results.hits).toHaveLength(0);
  });

  it('clears the index', async () => {
    await provider.indexDocument(indexName, { id: 'clear1', title: 'Clear Me' }, 'clear1');
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
    const results = await provider.search(indexName, { q: '' });
    expect(results.hits.length).toBeGreaterThanOrEqual(5);
  });

  it('searches by text', async () => {
    const results = await provider.search(indexName, { q: 'Configuration' });
    expect(results.hits.length).toBeGreaterThanOrEqual(2);
    const titles = results.hits.map(h => h.document?.title);
    expect(titles).toContain('Advanced Configuration');
  });

  it('supports pagination with limit and offset', async () => {
    const page1 = await provider.search(indexName, { q: '', limit: 2, offset: 0 });
    expect(page1.hits).toHaveLength(2);
    const page2 = await provider.search(indexName, { q: '', limit: 2, offset: 2 });
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
    await expect(provider.search(indexName, { q: '', offset: hugeOffset })).rejects.toThrow(
      'offset',
    );
  });

  it('filters by field equality', async () => {
    const results = await provider.search(indexName, {
      q: '',
      filter: { field: 'status', op: '=', value: 'published' },
    });
    expect(results.hits.length).toBeGreaterThanOrEqual(3);
    for (const hit of results.hits) {
      expect(hit.document?.status).toBe('published');
    }
  });

  it('supports $and compound filters', async () => {
    const results = await provider.search(indexName, {
      q: '',
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
      q: '',
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
      q: '',
      sort: [{ field: 'score', direction: 'desc' }],
    });
    expect(results.hits.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < results.hits.length - 1; i++) {
      expect(results.hits[i]!.document!.score).toBeGreaterThanOrEqual(
        results.hits[i + 1]!.document!.score as number,
      );
    }
  });

  it('returns facet stats when requested', async () => {
    const results = await provider.search(indexName, { q: '', facets: ['status', 'tags'] });
    expect(results.facetDistribution).toBeDefined();
    expect(results.facetDistribution?.status).toBeDefined();
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
    const results = await provider.suggest(indexName, { q: 'Con', fields: ['title'] });
    expect(results.suggestions?.length).toBeGreaterThan(0);
  });

  it('returns empty suggestions for unmatched prefix', async () => {
    const results = await provider.suggest(indexName, { q: 'ZZZZZZZ', fields: ['title'] });
    expect(results.suggestions?.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('dbNative edge cases', () => {
  const indexName = 'test_edges';

  beforeAll(async () => {
    await provider.createOrUpdateIndex(indexName, DEFAULT_SETTINGS);
  });

  afterAll(async () => {
    await provider.deleteIndex(indexName);
  });

  it('search on empty index returns zero hits', async () => {
    const emptyIndex = 'empty_test_idx';
    await provider.createOrUpdateIndex(emptyIndex, DEFAULT_SETTINGS);
    const results = await provider.search(emptyIndex, { q: 'anything' });
    expect(results.hits).toHaveLength(0);
    await provider.deleteIndex(emptyIndex);
  });

  it('deleteDocument on non-existent ID does not throw', async () => {
    await expect(provider.deleteDocument(indexName, 'no-such-id')).resolves.toBeUndefined();
  });

  it('dbNative has no async tasks so waitForTask is not exposed', () => {
    expect('waitForTask' in provider).toBe(false);
  });

  it('handles documents with extra fields gracefully', async () => {
    await indexDoc(indexName, {
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
    expect(typeof results.totalHits).toBe('number');
  });

  it('returns highlights for matching documents', async () => {
    await indexDoc(indexName, {
      id: 'hl-test',
      title: 'Highlight Test',
      body: 'Some search content here',
    });
    const results = await provider.search(indexName, {
      q: 'Highlight',
      highlight: { fields: ['title'] },
    });
    expect(results.hits.length).toBeGreaterThan(0);
    const hit = results.hits.find(h => h.document?.id === 'hl-test');
    expect(hit).toBeDefined();
  });
});
