/**
 * Timer-lifecycle tests for createEventSyncManager().
 *
 * Covers:
 *  - In-flight flush bails out cleanly after teardown — no provider writes
 *    are issued past the teardown boundary.
 *  - Dead-letter map is bounded and FIFO-evicts the oldest entry once
 *    `maxDeadLetterEntries` is exceeded; the eviction counter on getHealth()
 *    reflects the drops.
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

describe('event-sync timer lifecycle', () => {
  let bus: InProcessAdapter;
  let provider: ReturnType<typeof createDbNativeProvider>;
  let searchManager: ReturnType<typeof createSearchManager>;

  beforeEach(async () => {
    bus = new InProcessAdapter();
    provider = createDbNativeProvider();
    await provider.connect();
    await provider.createOrUpdateIndex('products', BASE_SETTINGS);
    await provider.createOrUpdateIndex('orders', BASE_SETTINGS);
    searchManager = createSearchManager({
      pluginConfig: PLUGIN_CONFIG,
      transformRegistry: createSearchTransformRegistry(),
    });
    await searchManager.initialize([makeEntityConfig('products'), makeEntityConfig('orders')]);
  });

  afterEach(async () => {
    await provider.teardown();
    await searchManager.teardown();
  });

  it('an in-flight flush does not continue processing the snapshot after teardown', async () => {
    // Arrange two indexes so the flush snapshot iterates more than once
    // across an async hop. We gate the FIRST `indexDocuments` call, fire
    // teardown while it's blocked, then release. The flush body should
    // detect `tornDown` after the first await returns and skip the second
    // index's provider call entirely.
    //
    // Both entities resolve to the same default db-native provider, so we
    // distinguish calls by the indexName argument rather than by spying on
    // separate provider instances.
    const productsEntity = makeEntityConfig('products');
    const ordersEntity = makeEntityConfig('orders');

    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60_000,
      flushThreshold: 100,
      maxFlushAttempts: 5,
    });
    mgr.subscribeConfigEntity(productsEntity);
    mgr.subscribeConfigEntity(ordersEntity);

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };
    dynamicBus.emit('entity:products.created', {
      id: 'tear-p-1',
      document: { id: 'tear-p-1', title: 'Product' },
    });
    dynamicBus.emit('entity:orders.created', {
      id: 'tear-o-1',
      document: { id: 'tear-o-1', title: 'Order' },
    });

    const sharedProvider = searchManager.getProvider('products');
    if (!sharedProvider) throw new Error('no provider');

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const callsByIndex: string[] = [];
    let firstSeen = false;
    const indexSpy = spyOn(sharedProvider, 'indexDocuments').mockImplementation(
      async (indexName: string) => {
        callsByIndex.push(indexName);
        if (!firstSeen) {
          firstSeen = true;
          await firstGate;
        }
        return { taskId: `${indexName}-flush`, status: 'enqueued', enqueuedAt: new Date() };
      },
    );

    const flushPromise = mgr.flush();
    // Yield so flush snapshots both pending maps and starts awaiting on
    // the first call.
    await new Promise(r => setTimeout(r, 5));

    // Start teardown while the flush is still mid-await on the first call.
    // The tornDown flag flips inside teardown before the gate releases.
    const teardownPromise = mgr.teardown();

    // Release the gate so the in-flight call returns. The flush body must
    // re-check `tornDown` after the await and bail before iterating to
    // the next snapshot index.
    releaseFirst?.();
    await flushPromise;
    await teardownPromise;

    expect(callsByIndex).toHaveLength(1);

    indexSpy.mockRestore();
  });

  it('evicts the oldest dead-letter entry past maxDeadLetterEntries and bumps the counter', async () => {
    const entity = makeEntityConfig('products');
    const mgr = createEventSyncManager({
      pluginConfig: PLUGIN_CONFIG,
      searchManager,
      transformRegistry: createSearchTransformRegistry(),
      bus,
      flushIntervalMs: 60_000,
      flushThreshold: 100_000,
      maxFlushAttempts: 1,
      maxDeadLetterEntries: 3,
    });
    mgr.subscribeConfigEntity(entity);

    const p = searchManager.getProvider('products');
    if (!p) throw new Error('no provider');
    spyOn(p, 'indexDocuments').mockRejectedValue(new Error('persistent failure'));
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    const dynamicBus = bus as unknown as { emit(event: string, payload: unknown): void };

    // Push 5 distinct docs through — each goes straight to DLQ since
    // maxFlushAttempts is 1 and indexDocuments always rejects.
    for (let i = 1; i <= 5; i++) {
      dynamicBus.emit('entity:products.created', {
        id: `dlq-${i}`,
        document: { id: `dlq-${i}`, title: `Doc ${i}` },
      });
      // Flush per-doc so each lands in the DLQ in order.
      await mgr.flush();
    }

    errSpy.mockRestore();

    const health = mgr.getHealth();
    // 5 inserted, 2 evicted, 3 retained.
    expect(health.deadLetterCount).toBe(3);
    expect(health.evictedFromDeadLetter).toBe(2);

    // The oldest two (`dlq-1`, `dlq-2`) should have been evicted.
    const surviving = mgr
      .getDeadLetters()
      .map(e => e.documentId)
      .sort();
    expect(surviving).toEqual(['dlq-3', 'dlq-4', 'dlq-5']);

    await mgr.teardown();
  });
});
