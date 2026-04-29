/**
 * Write-through sync tests.
 *
 * Tests EntitySearchClient (the WriteThroughSearchSync interface) via the
 * search manager's getSearchClient() method. Uses the DB-native provider.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Logger, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { createSearchManager } from '../src/searchManager';
import type { SearchManager } from '../src/searchManager';
import { createSearchTransformRegistry } from '../src/transformRegistry';
import type { SearchPluginConfig } from '../src/types/config';

// ============================================================================
// Helpers
// ============================================================================

const PLUGIN_CONFIG: SearchPluginConfig = {
  providers: { default: { provider: 'db-native' } },
};

function makeEntity(storageName: string): ResolvedEntityConfig {
  return {
    name: storageName,
    _pkField: 'id',
    _storageName: storageName,
    fields: {
      id: { type: 'string', optional: false, primary: true, immutable: true },
      title: { type: 'string', optional: false, primary: false, immutable: false },
      category: { type: 'string', optional: false, primary: false, immutable: false },
    },
    search: {
      fields: {
        title: { searchable: true },
        category: { searchable: false, filterable: true },
      },
    },
  } as unknown as ResolvedEntityConfig;
}

// ============================================================================
// Tests
// ============================================================================

describe('write-through sync (EntitySearchClient)', () => {
  let manager: SearchManager;

  beforeEach(async () => {
    manager = createSearchManager({
      pluginConfig: PLUGIN_CONFIG,
      transformRegistry: createSearchTransformRegistry(),
    });
    await manager.initialize([makeEntity('widgets')]);
  });

  afterEach(async () => {
    await manager.teardown();
  });

  it('indexDocument() calls provider indexDocument — document is findable after indexing', async () => {
    const client = manager.getSearchClient('widgets');
    await client.indexDocument({ id: 'w1', title: 'Blue Widget', category: 'tools' });

    const provider = manager.getProvider('widgets');
    expect(provider).toBeDefined();
    const result = await provider!.search('widgets', { q: 'Blue Widget' });
    expect(result.totalHits).toBeGreaterThanOrEqual(1);
    expect((result.hits[0].document as Record<string, unknown>).id).toBe('w1');
  });

  it('deleteDocument() removes document from index', async () => {
    const client = manager.getSearchClient('widgets');
    await client.indexDocument({ id: 'w-del', title: 'Remove Me', category: 'tools' });
    await client.removeDocument('w-del');

    const provider = manager.getProvider('widgets');
    expect(provider).toBeDefined();
    const result = await provider!.search('widgets', { q: 'Remove Me' });
    const found = result.hits.find(h => (h.document as Record<string, unknown>).id === 'w-del');
    expect(found).toBeUndefined();
  });

  it('ensureReady() — index is initialized on manager.initialize, no double-init error', async () => {
    // The search manager initializes indexes on startup (ensureConfigEntity / initialize).
    // Calling initialize again should be idempotent.
    await manager.initialize([makeEntity('widgets')]);
    // Should not throw — already initialized
    const client = manager.getSearchClient('widgets');
    await client.indexDocument({ id: 'ready-1', title: 'Ready Test', category: 'tools' });

    const provider = manager.getProvider('widgets');
    const result = await provider!.search('widgets', { q: 'Ready Test' });
    expect(result.totalHits).toBeGreaterThanOrEqual(1);
  });

  it('indexDocuments() indexes a batch', async () => {
    const client = manager.getSearchClient('widgets');
    await client.indexDocuments([
      { id: 'batch-1', title: 'First Batch Item', category: 'tools' },
      { id: 'batch-2', title: 'Second Batch Item', category: 'tools' },
    ]);

    const provider = manager.getProvider('widgets');
    const result = await provider!.search('widgets', { q: 'Batch Item' });
    expect(result.totalHits).toBe(2);
  });

  it('indexDocument() logs error and does not propagate when transform throws', async () => {
    const errors: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error(msg: string) {
        errors.push(msg);
      },
      child() {
        return logger;
      },
    };
    const registry = createSearchTransformRegistry();
    registry.register('failing-transform', () => {
      throw new Error('transform crash');
    });
    const failManager = createSearchManager({
      pluginConfig: PLUGIN_CONFIG,
      transformRegistry: registry,
      logger,
    });
    const entity: ResolvedEntityConfig = {
      ...makeEntity('transform_widgets'),
      search: {
        ...makeEntity('transform_widgets').search!,
        transform: 'failing-transform',
      },
    };
    await failManager.initialize([entity]);

    const client = failManager.getSearchClient('transform_widgets');
    await expect(
      client.indexDocument({ id: 'err-1', title: 'Bad Doc', category: 'test' }),
    ).resolves.toBeUndefined();

    expect(errors.some(m => m.includes('[slingshot-search] Transform error'))).toBe(true);
    expect(errors.some(m => m.includes('err-1'))).toBe(true);

    await failManager.teardown();
  });

  it('indexDocuments() skips failing documents but indexes successful ones', async () => {
    const errors: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error(msg: string) {
        errors.push(msg);
      },
      child() {
        return logger;
      },
    };
    const registry = createSearchTransformRegistry();
    registry.register('selective-fail', doc => {
      if ((doc as { title?: string }).title === 'BAD') {
        throw new Error('bad document');
      }
      return doc;
    });
    const batchManager = createSearchManager({
      pluginConfig: PLUGIN_CONFIG,
      transformRegistry: registry,
      logger,
    });
    const entity: ResolvedEntityConfig = {
      ...makeEntity('batch_widgets'),
      search: {
        ...makeEntity('batch_widgets').search!,
        transform: 'selective-fail',
      },
    };
    await batchManager.initialize([entity]);

    const client = batchManager.getSearchClient('batch_widgets');
    await expect(
      client.indexDocuments([
        { id: 'ok-1', title: 'Good Doc', category: 'test' },
        { id: 'bad-1', title: 'BAD', category: 'test' },
        { id: 'ok-2', title: 'Another Good Doc', category: 'test' },
      ]),
    ).resolves.toBeUndefined();

    const provider = batchManager.getProvider('batch_widgets');
    const result = await provider!.search('batch_widgets', { q: '' });
    const ids = result.hits.map(h => (h.document as Record<string, unknown>).id);
    expect(ids).toContain('ok-1');
    expect(ids).toContain('ok-2');
    expect(ids).not.toContain('bad-1');

    expect(errors.some(m => m.includes('[slingshot-search] Transform error'))).toBe(true);

    await batchManager.teardown();
  });

  it('provider failure — indexDocument throws with a descriptive error', async () => {
    const failingManager = createSearchManager({
      pluginConfig: PLUGIN_CONFIG,
      transformRegistry: createSearchTransformRegistry(),
    });

    const entity = makeEntity('fail_widgets');
    await failingManager.initialize([entity]);

    // Force a failure by deleting the underlying index, then trying to index
    const failProvider = failingManager.getProvider('fail_widgets');
    if (failProvider) {
      await failProvider.deleteIndex('fail_widgets');
    }

    // Indexing to a non-existent index should throw
    const failClient = failingManager.getSearchClient('fail_widgets');
    await expect(
      failClient.indexDocument({ id: 'err-1', title: 'Error Doc', category: 'test' }),
    ).rejects.toThrow();

    await failingManager.teardown();
  });
});
