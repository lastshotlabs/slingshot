/**
 * Event-bus sync manager tests.
 *
 * Tests createEventSyncManager() behavior using a mock provider that records
 * calls and a real InProcessAdapter event bus.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { createEventSyncManager } from '../src/eventSync';
import { createDbNativeProvider } from '../src/providers/dbNative';
import { createSearchManager } from '../src/searchManager';
import { createSearchTransformRegistry } from '../src/transformRegistry';
import type { SearchPluginConfig } from '../src/types/config';
import type { SearchIndexSettings } from '../src/types/provider';

// ============================================================================
// Test helpers
// ============================================================================

/** Create a minimal ResolvedEntityConfig for an event-bus synced entity. */
function makeEntityConfig(
  storageName: string,
  pkField = 'id',
  syncMode: 'event-bus' | 'write-through' | 'manual' = 'event-bus',
): ResolvedEntityConfig {
  return {
    name: storageName,
    _pkField: pkField,
    _storageName: storageName,
    fields: {
      [pkField]: { type: 'string', optional: false, primary: true, immutable: true },
      title: { type: 'string', optional: false, primary: false, immutable: false },
    },
    search: {
      fields: { title: { searchable: true } },
      syncMode,
    },
  } as unknown as ResolvedEntityConfig;
}

const BASE_SETTINGS: SearchIndexSettings = {
  searchableFields: ['title'],
  filterableFields: [],
  sortableFields: [],
  facetableFields: [],
};

const PLUGIN_CONFIG: SearchPluginConfig = {
  providers: { default: { provider: 'db-native' } },
};

// ============================================================================
// Tests
// ============================================================================

describe('createEventSyncManager', () => {
  let bus: InProcessAdapter;
  let provider: ReturnType<typeof createDbNativeProvider>;
  let searchManager: ReturnType<typeof createSearchManager>;

  beforeEach(async () => {
    bus = new InProcessAdapter();
    provider = createDbNativeProvider();
    await provider.connect();
    await provider.createOrUpdateIndex('products', BASE_SETTINGS);

    searchManager = createSearchManager({
      pluginConfig: PLUGIN_CONFIG,
      transformRegistry: createSearchTransformRegistry(),
    });

    // Manually pre-seed the search manager by initializing with a products entity
    const productEntity = makeEntityConfig('products');
    await searchManager.initialize([productEntity]);
  });

  afterEach(async () => {
    await provider.teardown();
    await searchManager.teardown();
  });

  it('create event causes document to be indexed', async () => {
    const entity = makeEntityConfig('products');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 100,
      flushThreshold: 100,
    });

    mgr.subscribeConfigEntity(entity);

    // Emit a create event
    (bus as unknown as { emit(event: string, payload: unknown): void }).emit(
      'entity:products.created',
      { id: 'prod-1', document: { id: 'prod-1', title: 'Widget' } },
    );

    // Flush immediately
    await mgr.flush();
    await mgr.teardown();

    // Verify document was indexed in the search manager's provider
    const provider2 = searchManager.getProvider('products');
    if (provider2) {
      const result = await provider2.search('products', { q: 'Widget' });
      expect(result.totalHits).toBeGreaterThanOrEqual(1);
    }
  });

  it('update event causes document to be re-indexed', async () => {
    const entity = makeEntityConfig('products');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 100,
      flushThreshold: 100,
    });

    mgr.subscribeConfigEntity(entity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };

    // Create first
    dynamicBus.emit('entity:products.created', {
      id: 'prod-update-1',
      document: { id: 'prod-update-1', title: 'OldTitle' },
    });
    await mgr.flush();

    // Then update
    dynamicBus.emit('entity:products.updated', {
      id: 'prod-update-1',
      document: { id: 'prod-update-1', title: 'NewTitle' },
    });
    await mgr.flush();
    await mgr.teardown();

    const p = searchManager.getProvider('products');
    if (p) {
      const result = await p.search('products', { q: 'NewTitle' });
      expect(result.totalHits).toBeGreaterThanOrEqual(1);
    }
  });

  it('delete event causes document to be removed', async () => {
    const entity = makeEntityConfig('products');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 100,
      flushThreshold: 100,
    });

    mgr.subscribeConfigEntity(entity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };

    // Index a document first
    dynamicBus.emit('entity:products.created', {
      id: 'prod-del-1',
      document: { id: 'prod-del-1', title: 'ToBeDeleted' },
    });
    await mgr.flush();

    // Then delete it
    dynamicBus.emit('entity:products.deleted', { id: 'prod-del-1' });
    // Deletions flush immediately, but give micro-tasks a tick to settle
    await new Promise(r => setTimeout(r, 20));
    await mgr.teardown();

    const p = searchManager.getProvider('products');
    if (p) {
      const result = await p.search('products', { q: 'ToBeDeleted' });
      expect(
        result.hits.every(h => (h.document as Record<string, unknown>).id !== 'prod-del-1'),
      ).toBe(true);
    }
  });

  it('events for non-searchable entities (wrong syncMode) are ignored', async () => {
    const manualEntity = makeEntityConfig('products', 'id', 'manual');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 100,
      flushThreshold: 100,
    });

    // subscribeConfigEntity should silently skip non-event-bus entities
    mgr.subscribeConfigEntity(manualEntity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };
    dynamicBus.emit('entity:products.created', {
      id: 'ignored-1',
      document: { id: 'ignored-1', title: 'ShouldBeIgnored' },
    });
    await mgr.flush();
    await mgr.teardown();

    const p = searchManager.getProvider('products');
    if (p) {
      const result = await p.search('products', { q: 'ShouldBeIgnored' });
      // Should not be indexed since entity is manual sync
      expect(result.totalHits).toBe(0);
    }
  });

  it('batch flush triggers when queue exceeds threshold', async () => {
    const entity = makeEntityConfig('products');
    // Set a low threshold to trigger batch flush
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60000, // won't trigger by timer
      flushThreshold: 3, // trigger after 3 documents
    });

    mgr.subscribeConfigEntity(entity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };

    // Index 3 docs to trigger threshold flush
    for (let i = 0; i < 3; i++) {
      dynamicBus.emit('entity:products.created', {
        id: `thresh-${i}`,
        document: { id: `thresh-${i}`, title: `Threshold Doc ${i}` },
      });
    }

    // Allow micro-tasks from threshold flush to settle
    await new Promise(r => setTimeout(r, 50));
    await mgr.teardown();

    const p = searchManager.getProvider('products');
    if (p) {
      const result = await p.search('products', { q: 'Threshold Doc' });
      // At least some docs should be indexed
      expect(result.totalHits).toBeGreaterThanOrEqual(1);
    }
  });

  it('batch flush triggers when flush interval elapses', async () => {
    const entity = makeEntityConfig('products');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 80, // short interval — triggers after 80ms
      flushThreshold: 1000, // won't trigger by threshold
    });

    mgr.subscribeConfigEntity(entity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };
    dynamicBus.emit('entity:products.created', {
      id: 'interval-flush-1',
      document: { id: 'interval-flush-1', title: 'Interval Flush Test' },
    });

    // Wait longer than flushIntervalMs — interval should fire the flush
    await new Promise(r => setTimeout(r, 200));
    await mgr.teardown();

    const p = searchManager.getProvider('products');
    if (p) {
      const result = await p.search('products', { q: 'Interval Flush Test' });
      expect(result.totalHits).toBeGreaterThanOrEqual(1);
    }
  });

  it('restores pending documents when indexDocuments fails so the next flush retries them', async () => {
    const entity = makeEntityConfig('products');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60000,
      flushThreshold: 100,
    });

    mgr.subscribeConfigEntity(entity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };
    dynamicBus.emit('entity:products.created', {
      id: 'retry-doc-1',
      document: { id: 'retry-doc-1', title: 'Retry Me' },
    });

    // Make the first indexDocuments call fail
    const p = searchManager.getProvider('products');
    if (!p) throw new Error('no provider');
    const spy = spyOn(p, 'indexDocuments').mockRejectedValueOnce(
      new Error('transient indexing failure'),
    );

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    await mgr.flush();
    errorSpy.mockRestore();

    // Document was not indexed — provider threw
    spy.mockRestore();
    const afterFail = await p.search('products', { q: 'Retry Me' });
    expect(afterFail.totalHits).toBe(0);

    // Second flush should succeed because the document was restored to pending
    await mgr.flush();
    await mgr.teardown();

    const afterRetry = await p.search('products', { q: 'Retry Me' });
    expect(afterRetry.totalHits).toBeGreaterThanOrEqual(1);
  });

  it('schedules a follow-up flush when a delete arrives during an in-flight flush', async () => {
    const entity = makeEntityConfig('products');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60000,
      flushThreshold: 100,
    });

    mgr.subscribeConfigEntity(entity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };
    dynamicBus.emit('entity:products.created', {
      id: 'overlap-doc-1',
      document: { id: 'overlap-doc-1', title: 'Overlap Doc' },
    });

    const p = searchManager.getProvider('products');
    if (!p) throw new Error('no provider');

    const originalIndexDocuments = p.indexDocuments.bind(p);
    let releaseIndex: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      releaseIndex = resolve;
    });
    const indexSpy = spyOn(p, 'indexDocuments').mockImplementationOnce(async (...args) => {
      await gate;
      return originalIndexDocuments(...args);
    });

    const flushPromise = mgr.flush();
    await new Promise(r => setTimeout(r, 10));

    dynamicBus.emit('entity:products.deleted', { id: 'overlap-doc-1' });
    releaseIndex?.();
    await flushPromise;
    await new Promise(r => setTimeout(r, 20));
    indexSpy.mockRestore();
    await mgr.teardown();

    const after = await p.search('products', { q: 'Overlap Doc' });
    expect(after.totalHits).toBe(0);
  });

  it('teardown flushes pending operations before stopping', async () => {
    const entity = makeEntityConfig('products');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60000, // won't trigger by timer
      flushThreshold: 100, // won't trigger by threshold
    });

    mgr.subscribeConfigEntity(entity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };
    dynamicBus.emit('entity:products.created', {
      id: 'teardown-flush-1',
      document: { id: 'teardown-flush-1', title: 'Teardown Flush Test' },
    });

    // Teardown should flush before stopping
    await mgr.teardown();

    const p = searchManager.getProvider('products');
    if (p) {
      const result = await p.search('products', { q: 'Teardown Flush Test' });
      expect(result.totalHits).toBeGreaterThanOrEqual(1);
    }
  });
});
