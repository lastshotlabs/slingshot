/**
 * Reindex tests.
 *
 * Tests the searchManager.reindex() operation — clearing the index,
 * processing in batches of 500, applying transforms/geo, and returning
 * { documentsIndexed, durationMs }.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { createSearchManager } from '../src/searchManager';
import type { SearchManager } from '../src/searchManager';
import { createSearchTransformRegistry } from '../src/transformRegistry';

// ============================================================================
// Helpers
// ============================================================================

function makeEntity(storageName: string): ResolvedEntityConfig {
  return {
    name: storageName,
    _pkField: 'id',
    _storageName: storageName,
    fields: {
      id: { type: 'string', optional: false, primary: true, immutable: true },
      title: { type: 'string', optional: false, primary: false, immutable: false },
      body: { type: 'string', optional: true, primary: false, immutable: false },
    },
    search: {
      fields: {
        title: { searchable: true },
        body: { searchable: true },
      },
    },
  };
}

function makeGeoEntity(storageName: string): ResolvedEntityConfig {
  return {
    name: storageName,
    _pkField: 'id',
    _storageName: storageName,
    fields: {
      id: { type: 'string', optional: false, primary: true, immutable: true },
      name: { type: 'string', optional: false, primary: false, immutable: false },
      latitude: { type: 'number', optional: false, primary: false, immutable: false },
      longitude: { type: 'number', optional: false, primary: false, immutable: false },
    },
    search: {
      fields: {
        name: { searchable: true },
        latitude: { searchable: false },
        longitude: { searchable: false },
      },
      geo: {
        latField: 'latitude',
        lngField: 'longitude',
      },
    },
  };
}

/** Create an async iterable from an array. */
async function* arrayIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('searchManager.reindex()', () => {
  let manager: SearchManager;

  beforeEach(async () => {
    manager = createSearchManager({
      pluginConfig: { providers: { default: { provider: 'db-native' } } },
      transformRegistry: createSearchTransformRegistry(),
    });
  });

  afterEach(async () => {
    await manager.teardown();
  });

  it('reindex from async iterable source indexes all documents', async () => {
    await manager.initialize([makeEntity('docs')]);

    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: `reindex-${i}`,
      title: `Document ${i}`,
      body: 'reindex content',
    }));

    const result = await manager.reindex('docs', arrayIterable(docs));
    expect(result.documentsIndexed).toBe(10);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const provider = manager.getProvider('docs');
    const searchResult = await provider!.search('docs', { q: 'reindex content' });
    expect(searchResult.totalHits).toBe(10);
  });

  it('reindex clears existing index data first', async () => {
    await manager.initialize([makeEntity('clearable')]);

    const client = manager.getSearchClient('clearable');
    // Pre-populate with old data
    await client.indexDocuments([
      { id: 'old-1', title: 'Old Document One', body: 'stale' },
      { id: 'old-2', title: 'Old Document Two', body: 'stale' },
    ]);

    // Reindex with fresh data
    const freshDocs = [{ id: 'new-1', title: 'Fresh Document', body: 'fresh content' }];

    await manager.reindex('clearable', arrayIterable(freshDocs));

    const provider = manager.getProvider('clearable');
    // Old documents should be gone
    const staleResult = await provider!.search('clearable', { q: 'Old Document' });
    expect(staleResult.totalHits).toBe(0);

    // New document should be present
    const freshResult = await provider!.search('clearable', { q: 'Fresh Document' });
    expect(freshResult.totalHits).toBeGreaterThanOrEqual(1);
  });

  it('reindex processes documents in batches of 500', async () => {
    await manager.initialize([makeEntity('bulk')]);

    // Create 1050 docs — should require 3 batches (500, 500, 50)
    const docs = Array.from({ length: 1050 }, (_, i) => ({
      id: `bulk-${i}`,
      title: `Bulk Doc ${i}`,
      body: 'bulk content',
    }));

    const result = await manager.reindex('bulk', arrayIterable(docs));
    expect(result.documentsIndexed).toBe(1050);

    const provider = manager.getProvider('bulk');
    const searchResult = await provider!.search('bulk', { q: '' });
    expect(searchResult.totalHits).toBe(1050);
  });

  it('reindex with transform applies transform before indexing', async () => {
    const registry = createSearchTransformRegistry();
    registry.register('titleUppercase', doc => ({
      ...doc,
      title: typeof doc.title === 'string' ? doc.title.toUpperCase() : doc.title,
    }));

    const transformManager = createSearchManager({
      pluginConfig: { providers: { default: { provider: 'db-native' } } },
      transformRegistry: registry,
    });

    const entity: ResolvedEntityConfig = {
      name: 'TransformedDocs',
      _pkField: 'id',
      _storageName: 'transformed_docs',
      fields: {
        id: { type: 'string', optional: false, primary: true, immutable: true },
        title: { type: 'string', optional: false, primary: false, immutable: false },
        body: { type: 'string', optional: true, primary: false, immutable: false },
      },
      search: {
        fields: {
          title: { searchable: true },
          body: { searchable: true },
        },
        transform: 'titleUppercase',
      },
    };

    await transformManager.initialize([entity]);

    const docs = [{ id: 'tf-1', title: 'lowercase title', body: 'content' }];
    await transformManager.reindex('transformed_docs', arrayIterable(docs));

    const provider = transformManager.getProvider('transformed_docs');
    // The transform uppercases the title, so we search for the uppercased version
    const result = await provider!.search('transformed_docs', { q: 'LOWERCASE TITLE' });
    expect(result.totalHits).toBeGreaterThanOrEqual(1);

    await transformManager.teardown();
  });

  it('reindex with geo config applies geo transform', async () => {
    await manager.initialize([makeGeoEntity('venues')]);

    const docs = [{ id: 'venue-1', name: 'Central Park', latitude: 40.7851, longitude: -73.9683 }];

    const result = await manager.reindex('venues', arrayIterable(docs));
    expect(result.documentsIndexed).toBe(1);

    const provider = manager.getProvider('venues');
    const searchResult = await provider!.search('venues', { q: 'Central Park' });
    expect(searchResult.totalHits).toBeGreaterThanOrEqual(1);
    // Geo transform should have added a _geo field
    const doc = searchResult.hits[0].document as Record<string, unknown>;
    expect(doc._geo).toBeDefined();
  });

  it('reindex returns { documentsIndexed, durationMs }', async () => {
    await manager.initialize([makeEntity('timed')]);

    const docs = [{ id: 'timed-1', title: 'Timed Doc', body: 'content' }];

    const result = await manager.reindex('timed', arrayIterable(docs));
    expect(result).toHaveProperty('documentsIndexed');
    expect(result).toHaveProperty('durationMs');
    expect(result.documentsIndexed).toBe(1);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
