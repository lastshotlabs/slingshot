import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ResolvedEntityConfig, SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { createEventSyncManager } from '../../../packages/slingshot-search/src/eventSync';
import type { EventSyncManager } from '../../../packages/slingshot-search/src/eventSync';
import type { SearchManager } from '../../../packages/slingshot-search/src/searchManager';
import type { SearchTransformRegistry } from '../../../packages/slingshot-search/src/transformRegistry';
import type { SearchPluginConfig } from '../../../packages/slingshot-search/src/types/config';
import type { SearchProvider } from '../../../packages/slingshot-search/src/types/provider';

// ============================================================================
// Mock factories
// ============================================================================

type DynamicListener = (payload: unknown) => void | Promise<void>;

function createMockBus() {
  const listeners = new Map<string, Set<DynamicListener>>();

  const bus = {
    emit: mock((event: string, payload: unknown) => {
      const set = listeners.get(event);
      if (set) {
        for (const fn of set) fn(payload);
      }
    }),
    on: mock((event: string, listener: DynamicListener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    }),
    off: mock((event: string, listener: DynamicListener) => {
      listeners.get(event)?.delete(listener);
    }),
    clientSafeKeys: new Set<string>(),
    registerClientSafeEvents: mock(() => {}),
    _listeners: listeners,
  };

  return bus as unknown as SlingshotEventBus & {
    _listeners: Map<string, Set<DynamicListener>>;
  };
}

function createMockProvider(): SearchProvider {
  return {
    name: 'mock',
    connect: mock(async () => {}),
    healthCheck: mock(async () => ({
      healthy: true,
      provider: 'mock',
      latencyMs: 0,
    })),
    teardown: mock(async () => {}),
    createOrUpdateIndex: mock(async () => undefined),
    deleteIndex: mock(async () => undefined),
    listIndexes: mock(async () => []),
    getIndexSettings: mock(async () => ({
      searchableFields: [],
      filterableFields: [],
      sortableFields: [],
      facetableFields: [],
    })),
    indexDocument: mock(async () => undefined),
    deleteDocument: mock(async () => undefined),
    indexDocuments: mock(async () => undefined),
    deleteDocuments: mock(async () => undefined),
    clearIndex: mock(async () => undefined),
    search: mock(async () => ({
      hits: [],
      totalHits: 0,
      totalHitsRelation: 'exact' as const,
      query: '',
      processingTimeMs: 0,
      indexName: '',
    })),
    multiSearch: mock(async () => []),
    suggest: mock(async () => ({ suggestions: [], processingTimeMs: 0 })),
  };
}

function createMockSearchManager(provider: SearchProvider): SearchManager {
  return {
    initialize: mock(async () => {}),
    ensureConfigEntity: mock(async () => {}),
    getSearchClient: mock(() => {
      throw new Error('not implemented in mock');
    }),
    federatedSearch: mock(async () => ({
      hits: [],
      totalHits: 0,
      processingTimeMs: 0,
      indexes: {},
    })),
    reindex: mock(async () => ({ documentsIndexed: 0, durationMs: 0 })),
    healthCheck: mock(async () => ({})),
    getIndexName: mock((storageName: string) => `test_${storageName}`),
    getIndexSettings: mock(() => undefined),
    getProvider: mock(() => provider),
    getProviderByKey: mock(() => provider),
    getEntityTenantConfig: mock(() => undefined),
    resolveStorageName: mock((_name: string) => null),
    teardown: mock(async () => {}),
  };
}

function createMockTransformRegistry(): SearchTransformRegistry {
  const identity = (doc: Record<string, unknown>) => doc;
  return {
    register: mock(() => {}),
    resolve: mock(() => identity),
    has: mock(() => false),
    names: mock(() => []),
  };
}

function createTestEntity(overrides?: Partial<ResolvedEntityConfig>): ResolvedEntityConfig {
  return {
    name: 'Article',
    fields: {},
    _pkField: 'id',
    _storageName: 'articles',
    search: {
      syncMode: 'event-bus',
      fields: {
        title: { searchable: true },
        body: { searchable: true },
      },
    },
    ...overrides,
  } as ResolvedEntityConfig;
}

const basePluginConfig: SearchPluginConfig = {
  providers: { default: { provider: 'db-native' } },
};

// ============================================================================
// Tests
// ============================================================================

describe('EventSyncManager', () => {
  let bus: ReturnType<typeof createMockBus>;
  let provider: SearchProvider;
  let searchManager: SearchManager;
  let transformRegistry: SearchTransformRegistry;
  let syncManager: EventSyncManager;

  beforeEach(() => {
    bus = createMockBus();
    provider = createMockProvider();
    searchManager = createMockSearchManager(provider);
    transformRegistry = createMockTransformRegistry();
  });

  afterEach(async () => {
    if (syncManager) await syncManager.teardown();
  });

  function createManager(overrides?: { flushIntervalMs?: number; flushThreshold?: number }) {
    syncManager = createEventSyncManager({
      pluginConfig: basePluginConfig,
      searchManager,
      transformRegistry,
      bus,
      flushIntervalMs: overrides?.flushIntervalMs ?? 60_000,
      flushThreshold: overrides?.flushThreshold ?? 100,
    });
    return syncManager;
  }

  // --------------------------------------------------------------------------
  // Config entity subscription
  // --------------------------------------------------------------------------

  describe('subscribeConfigEntity', () => {
    test('subscribes to created, updated, and deleted events', () => {
      const mgr = createManager();
      const entity = createTestEntity();
      mgr.subscribeConfigEntity(entity);

      const onCalls = (bus.on as ReturnType<typeof mock>).mock.calls;
      const subscribedEvents = onCalls.map((c: unknown[]) => c[0]);
      expect(subscribedEvents).toContain('entity:articles.created');
      expect(subscribedEvents).toContain('entity:articles.updated');
      expect(subscribedEvents).toContain('entity:articles.deleted');
    });

    test('skips entities without event-bus syncMode', () => {
      const mgr = createManager();
      const entity = createTestEntity({
        search: {
          syncMode: 'write-through',
          fields: { title: { searchable: true } },
        },
      });
      mgr.subscribeConfigEntity(entity);

      const onCalls = (bus.on as ReturnType<typeof mock>).mock.calls;
      expect(onCalls).toHaveLength(0);
    });

    test('does not subscribe the same entity twice', () => {
      const mgr = createManager();
      const entity = createTestEntity();
      mgr.subscribeConfigEntity(entity);
      mgr.subscribeConfigEntity(entity);

      const onCalls = (bus.on as ReturnType<typeof mock>).mock.calls;
      expect(onCalls).toHaveLength(3);
    });
  });

  // --------------------------------------------------------------------------
  // Batched indexing
  // --------------------------------------------------------------------------

  describe('batched indexing', () => {
    test('created event queues document and flushes on explicit flush', async () => {
      const mgr = createManager();
      const entity = createTestEntity();
      mgr.subscribeConfigEntity(entity);

      (bus as any).emit('entity:articles.created', {
        id: 'a1',
        document: { id: 'a1', title: 'Hello', body: 'World' },
      });

      await mgr.flush();

      expect(provider.indexDocuments).toHaveBeenCalled();
    });

    test('updated event queues document for indexing', async () => {
      const mgr = createManager();
      const entity = createTestEntity();
      mgr.subscribeConfigEntity(entity);

      (bus as any).emit('entity:articles.updated', {
        id: 'a1',
        document: { id: 'a1', title: 'Updated', body: 'Content' },
      });

      await mgr.flush();
      expect(provider.indexDocuments).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Immediate delete flush
  // --------------------------------------------------------------------------

  describe('immediate delete flush', () => {
    test('deleted event triggers immediate flush with deleteDocuments', async () => {
      const mgr = createManager();
      const entity = createTestEntity();
      mgr.subscribeConfigEntity(entity);

      (bus as any).emit('entity:articles.deleted', { id: 'a1' });

      // Allow microtask to resolve
      await new Promise(r => setTimeout(r, 10));

      expect(provider.deleteDocuments).toHaveBeenCalled();
      const calls = (provider.deleteDocuments as ReturnType<typeof mock>).mock.calls;
      expect(calls[0][1]).toContain('a1');
    });
  });

  // --------------------------------------------------------------------------
  // Threshold flush
  // --------------------------------------------------------------------------

  describe('threshold flush', () => {
    test('flushes when pending queue exceeds threshold', async () => {
      const mgr = createManager({ flushThreshold: 3 });
      const entity = createTestEntity();
      mgr.subscribeConfigEntity(entity);

      for (let i = 0; i < 3; i++) {
        (bus as any).emit('entity:articles.created', {
          id: `doc-${i}`,
          document: { id: `doc-${i}`, title: `Doc ${i}`, body: '' },
        });
      }

      // Allow microtask to resolve
      await new Promise(r => setTimeout(r, 10));

      expect(provider.indexDocuments).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Teardown
  // --------------------------------------------------------------------------

  describe('teardown', () => {
    test('flushes pending and unsubscribes all listeners', async () => {
      const mgr = createManager();
      const entity = createTestEntity();
      mgr.subscribeConfigEntity(entity);

      (bus as any).emit('entity:articles.created', {
        id: 'a1',
        document: { id: 'a1', title: 'Teardown test', body: '' },
      });

      await mgr.teardown();

      // Should have flushed pending
      expect(provider.indexDocuments).toHaveBeenCalled();

      // Should have called bus.off for all subscriptions
      const offCalls = (bus.off as ReturnType<typeof mock>).mock.calls;
      expect(offCalls.length).toBe(3);
    });

    test('teardown clears internal state', async () => {
      const mgr = createManager();
      const entity = createTestEntity();
      mgr.subscribeConfigEntity(entity);
      await mgr.teardown();

      // Re-subscribing after teardown should not throw
      mgr.subscribeConfigEntity(createTestEntity({ _storageName: 'posts' } as any));
    });
  });
});
