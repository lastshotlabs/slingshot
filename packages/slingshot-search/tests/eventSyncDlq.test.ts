/**
 * Event-sync dead-letter and restore-pending ordering tests.
 *
 * Exercises:
 *  - flush DLQ promotion at `maxFlushAttempts`
 *  - per-doc `writeTs` ordering during restore-pending so an in-flight flush
 *    failure cannot clobber a newer pending write
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { type FlushDeadLetterEntry, createEventSyncManager } from '../src/eventSync';
import { createDbNativeProvider } from '../src/providers/dbNative';
import { createSearchManager } from '../src/searchManager';
import { createSearchTransformRegistry } from '../src/transformRegistry';
import type { SearchPluginConfig } from '../src/types/config';
import type { SearchIndexSettings } from '../src/types/provider';

function makeEntityConfig(storageName: string, pkField = 'id'): ResolvedEntityConfig {
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
      syncMode: 'event-bus',
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

describe('event-sync DLQ + restore ordering', () => {
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
    await searchManager.initialize([makeEntityConfig('products')]);
  });

  afterEach(async () => {
    await provider.teardown();
    await searchManager.teardown();
  });

  it('moves a doc to dead-letter after exceeding maxFlushAttempts', async () => {
    const entity = makeEntityConfig('products');
    const dead: FlushDeadLetterEntry[] = [];

    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60_000,
      flushThreshold: 100,
      maxFlushAttempts: 3,
      onFlushDeadLetter: entry => dead.push(entry),
    });

    mgr.subscribeConfigEntity(entity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };
    dynamicBus.emit('entity:products.created', {
      id: 'dlq-1',
      document: { id: 'dlq-1', title: 'Will Fail' },
    });

    const p = searchManager.getProvider('products');
    if (!p) throw new Error('no provider');
    // Force every indexDocuments call to fail.
    spyOn(p, 'indexDocuments').mockRejectedValue(new Error('persistent failure'));
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    // Each flush bumps `attempts` by 1 — once it reaches 3 the doc is DLQ'd.
    for (let i = 0; i < 5; i++) {
      await mgr.flush();
    }

    errSpy.mockRestore();

    expect(dead.length).toBe(1);
    expect(dead[0]).toMatchObject({
      documentId: 'dlq-1',
      indexName: 'products',
      operation: 'index',
      attempts: 3,
    });

    const health = mgr.getEventSyncHealth();
    expect(health.deadLetterCount).toBe(1);
    expect(health.pendingCount).toBe(0);

    const snapshot = mgr.getDeadLetters();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].documentId).toBe('dlq-1');

    await mgr.teardown();
  });

  it('does not restore an older snapshot op over a newer pending op (writeTs ordering)', async () => {
    const entity = makeEntityConfig('products');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60_000,
      flushThreshold: 100,
      maxFlushAttempts: 5,
    });

    mgr.subscribeConfigEntity(entity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };

    // Initial create — writeTs=1
    dynamicBus.emit('entity:products.created', {
      id: 'race-1',
      document: { id: 'race-1', title: 'OldVersion' },
    });

    const p = searchManager.getProvider('products');
    if (!p) throw new Error('no provider');

    // Make the first indexDocuments call hang until released. While it is in
    // flight we emit a NEWER update that lands in `pending`. When the in-flight
    // call ultimately fails, the restore-pending logic must NOT clobber the
    // newer entry.
    let releaseIndex: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      releaseIndex = resolve;
    });
    const indexSpy = spyOn(p, 'indexDocuments').mockImplementationOnce(async () => {
      await gate;
      throw new Error('flush failed');
    });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    const flushPromise = mgr.flush();
    // Yield so `flush` snapshots the queue and starts awaiting the spy.
    await new Promise(r => setTimeout(r, 5));

    // Newer write — writeTs=2 — lands in pending while the older op is in flight.
    dynamicBus.emit('entity:products.updated', {
      id: 'race-1',
      document: { id: 'race-1', title: 'NewVersion' },
    });

    // Release the in-flight call so it fails. Restore-pending must keep the
    // newer entry (writeTs=2) and discard the older one (writeTs=1).
    releaseIndex?.();
    await flushPromise;
    indexSpy.mockRestore();

    // Second flush should index the NEWER version.
    await mgr.flush();
    errSpy.mockRestore();
    await mgr.teardown();

    const result = await p.search('products', { q: 'NewVersion' });
    expect(result.totalHits).toBeGreaterThanOrEqual(1);
    const oldHits = await p.search('products', { q: 'OldVersion' });
    expect(oldHits.totalHits).toBe(0);
  });
});
