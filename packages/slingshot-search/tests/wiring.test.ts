/**
 * P0.2 — Verify Reflect symbol wiring end-to-end.
 *
 * Tests that the three framework injection symbols
 * (REGISTER_ENTITY, RESOLVE_SEARCH_SYNC, RESOLVE_SEARCH_CLIENT)
 * wire entity adapters to the search plugin runtime correctly.
 *
 * Bootstrap approach: build a minimal FrameworkStoreInfra stub that
 * implements the three Reflect symbol hooks, backed by a real
 * SearchManager (db-native provider) — no full app bootstrap required.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createEntityRegistry,
  defineEntity,
  field,
  resolveRepo,
} from '@lastshotlabs/slingshot-core';
import type {
  EntityRegistry,
  SearchClientLike,
  SearchPluginRuntime,
} from '@lastshotlabs/slingshot-core';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import {
  type FrameworkStoreInfra,
  REGISTER_ENTITY,
  RESOLVE_SEARCH_CLIENT,
  RESOLVE_SEARCH_SYNC,
  type ResolvedSearchSync,
} from '../../../src/framework/persistence/internalRepoResolution';
import { replyFactories, threadFactories } from '../../slingshot-community/src/entities/factories';
import { Reply } from '../../slingshot-community/src/entities/reply';
import { Thread } from '../../slingshot-community/src/entities/thread';
import { createSearchManager } from '../src/searchManager';
import type { SearchManager } from '../src/searchManager';
import { createSearchTransformRegistry } from '../src/transformRegistry';

// ============================================================================
// Test bootstrap helpers
// ============================================================================

/**
 * Create a FrameworkStoreInfra backed by a real SearchManager (db-native),
 * wired through the Reflect symbol pattern.
 *
 * This mirrors what createContextStoreInfra does in production — the
 * only difference is that InfrastructureResult is omitted (memory store only).
 */
function createTestInfra(options: {
  entityRegistry: EntityRegistry;
  searchManager: SearchManager;
  pluginState: Map<string, unknown>;
}): FrameworkStoreInfra {
  const { entityRegistry, searchManager, pluginState } = options;
  const registeredEntities = new Set<string>();

  function getSearchPluginRuntime(): SearchPluginRuntime | null {
    const value = pluginState.get('slingshot-search');
    if (typeof value !== 'object' || value === null) return null;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.ensureConfigEntity !== 'function' ||
      typeof candidate.getSearchClient !== 'function'
    ) {
      return null;
    }
    return value as unknown as SearchPluginRuntime;
  }

  function resolveSearchSyncForConfig(
    config: ResolvedEntityConfig,
  ): ResolvedSearchSync | undefined {
    if (!config.search) return undefined;
    const syncMode = config.search.syncMode ?? 'write-through';
    if (syncMode === 'manual') {
      return { syncMode, ensureReady: async () => {} };
    }
    const runtime = getSearchPluginRuntime();
    if (!runtime) return undefined;

    const ensureReady = async (): Promise<void> => {
      await runtime.ensureConfigEntity(config);
    };

    if (syncMode === 'write-through') {
      return {
        syncMode,
        ensureReady,
        indexDocument: async entity => {
          await runtime.ensureConfigEntity(config);
          const client = runtime.getSearchClient(config._storageName);
          if (!client) return;
          await client.indexDocument(entity);
        },
        deleteDocument: async id => {
          await runtime.ensureConfigEntity(config);
          const client = runtime.getSearchClient(config._storageName);
          if (!client) return;
          await client.removeDocument(id);
        },
      };
    }

    return undefined;
  }

  return {
    appName: 'test',
    getRedis: () => {
      throw new Error('[test] Redis not configured');
    },
    getMongo: () => {
      throw new Error('[test] Mongo not configured');
    },
    getSqliteDb: () => {
      throw new Error('[test] SQLite not configured');
    },
    getPostgres: () => {
      throw new Error('[test] Postgres not configured');
    },

    [REGISTER_ENTITY](config: ResolvedEntityConfig): void {
      if (registeredEntities.has(config._storageName)) return;
      entityRegistry.register(config);
      registeredEntities.add(config._storageName);
      // Best-effort: trigger ensureConfigEntity if search plugin is loaded
      if (config.search) {
        const runtime = getSearchPluginRuntime();
        if (runtime) {
          void runtime.ensureConfigEntity(config).catch(err => {
            console.error(
              `[test-infra] ensureConfigEntity failed for '${config._storageName}':`,
              err,
            );
          });
        }
      }
    },

    [RESOLVE_SEARCH_SYNC](config: ResolvedEntityConfig): ResolvedSearchSync | undefined {
      return resolveSearchSyncForConfig(config);
    },

    [RESOLVE_SEARCH_CLIENT](config: ResolvedEntityConfig): SearchClientLike | null {
      if (!config.search) return null;
      const runtime = getSearchPluginRuntime();
      if (!runtime) return null;
      return runtime.getSearchClient(config._storageName);
    },
  };
}

/**
 * Create a SearchPluginRuntime backed by a SearchManager — the same shape
 * stored in pluginState by the real slingshot-search plugin's setupPost.
 */
function createSearchRuntime(searchManager: SearchManager): SearchPluginRuntime {
  return {
    async ensureConfigEntity(entity: ResolvedEntityConfig): Promise<void> {
      await searchManager.ensureConfigEntity(entity);
    },
    getSearchClient(entityStorageName: string): SearchClientLike | null {
      const indexName = searchManager.getIndexName(entityStorageName);
      if (!indexName) return null;
      return searchManager.getSearchClient(entityStorageName);
    },
  };
}

// ============================================================================
// Test 1: Write-through sync for a config-driven entity
// ============================================================================

describe('P0.2 — Test 1: write-through sync for a config-driven entity', () => {
  let searchManager: SearchManager;
  let pluginState: Map<string, unknown>;
  let entityRegistry: EntityRegistry;

  const Article = defineEntity('Article', {
    namespace: 'blog',
    fields: {
      id: field.string({ primary: true, default: 'uuid' }),
      title: field.string(),
    },
    search: {
      fields: {
        title: { searchable: true, weight: 2 },
      },
      syncMode: 'write-through',
    },
  });

  beforeEach(async () => {
    pluginState = new Map();
    entityRegistry = createEntityRegistry();
    searchManager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
        autoCreateIndexes: true,
      },
      transformRegistry: createSearchTransformRegistry(),
    });

    // Simulate setupPost: initialize manager with no pre-known entities,
    // then store runtime in pluginState
    await searchManager.initialize([]);
    pluginState.set('slingshot-search', createSearchRuntime(searchManager));
  });

  afterEach(async () => {
    await searchManager.teardown();
  });

  it('indexes a document on create', async () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    const adapter = resolveRepo(createEntityFactories(Article), 'memory', infra);

    const created = await adapter.create({ title: 'Hello Search' } as unknown as Parameters<
      typeof adapter.create
    >[0]);

    // Give async ensureReady a tick to complete
    await new Promise(r => setTimeout(r, 10));

    // Verify the document is findable via the search manager
    const client = searchManager.getSearchClient(Article._storageName);
    const results = await client.search({ q: 'Hello' });
    expect(results.hits).toHaveLength(1);
    expect(results.hits[0].document['id']).toBe(created.id);
  });

  it('re-indexes a document on update', async () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    const adapter = resolveRepo(createEntityFactories(Article), 'memory', infra);

    const created = await adapter.create({ title: 'Original Title' } as unknown as Parameters<
      typeof adapter.create
    >[0]);
    await new Promise(r => setTimeout(r, 10));

    await adapter.update(created.id, { title: 'Updated Title' });
    await new Promise(r => setTimeout(r, 10));

    const client = searchManager.getSearchClient(Article._storageName);
    const updatedResults = await client.search({ q: 'Updated' });
    expect(updatedResults.hits.some(h => h.document['id'] === created.id)).toBe(true);
  });

  it('removes a document on delete', async () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    const adapter = resolveRepo(createEntityFactories(Article), 'memory', infra);

    const created = await adapter.create({ title: 'Deletable Article' } as unknown as Parameters<
      typeof adapter.create
    >[0]);
    await new Promise(r => setTimeout(r, 10));

    // Verify it's indexed
    const client = searchManager.getSearchClient(Article._storageName);
    const beforeDelete = await client.search({ q: 'Deletable' });
    expect(beforeDelete.hits).toHaveLength(1);

    await adapter.delete(created.id);
    await new Promise(r => setTimeout(r, 10));

    const afterDelete = await client.search({ q: 'Deletable' });
    expect(afterDelete.hits).toHaveLength(0);
  });
});

// ============================================================================
// Test 2: Entity discovery from runtime registry
// ============================================================================

describe('P0.2 — Test 2: entity discovery from runtime registry', () => {
  let searchManager: SearchManager;
  let pluginState: Map<string, unknown>;
  let entityRegistry: EntityRegistry;

  const Product = defineEntity('Product', {
    namespace: 'catalog',
    fields: {
      id: field.string({ primary: true, default: 'uuid' }),
      name: field.string(),
    },
    search: {
      fields: {
        name: { searchable: true, weight: 2 },
      },
    },
  });

  beforeEach(async () => {
    pluginState = new Map();
    entityRegistry = createEntityRegistry();
    searchManager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
        autoCreateIndexes: true,
      },
      transformRegistry: createSearchTransformRegistry(),
    });

    await searchManager.initialize([]);
    pluginState.set('slingshot-search', createSearchRuntime(searchManager));
  });

  afterEach(async () => {
    await searchManager.teardown();
  });

  it('resolving a factory with FrameworkStoreInfra calls REGISTER_ENTITY and populates the registry', () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    expect(entityRegistry.getAll()).toHaveLength(0);

    resolveRepo(createEntityFactories(Product), 'memory', infra);

    const all = entityRegistry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]._storageName).toBe(Product._storageName);
    expect(all[0].search).toBeDefined();
  });

  it('second resolution is idempotent — entity registered exactly once', () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    const factories = createEntityFactories(Product);

    resolveRepo(factories, 'memory', infra);
    resolveRepo(factories, 'memory', infra);

    expect(entityRegistry.getAll()).toHaveLength(1);
  });

  it('entity is discoverable via registry.filter after factory resolution', () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    resolveRepo(createEntityFactories(Product), 'memory', infra);

    const searchable = entityRegistry.filter(e => !!e.search);
    expect(searchable).toHaveLength(1);
    expect(searchable[0].name).toBe('Product');
  });

  it('search plugin can find the entity by storage name after REGISTER_ENTITY', async () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    resolveRepo(createEntityFactories(Product), 'memory', infra);

    // Wait for async ensureConfigEntity triggered from REGISTER_ENTITY
    await new Promise(r => setTimeout(r, 20));

    // The search manager should now know about this entity
    const indexName = searchManager.getIndexName(Product._storageName);
    expect(indexName).toBeDefined();
    expect(typeof indexName).toBe('string');
  });
});

// ============================================================================
// Test 3: Community entities wired through (Thread/Reply)
// ============================================================================

describe('P0.2 — Test 3: community Thread entity search wiring', () => {
  let searchManager: SearchManager;
  let pluginState: Map<string, unknown>;
  let entityRegistry: EntityRegistry;

  beforeEach(async () => {
    pluginState = new Map();
    entityRegistry = createEntityRegistry();
    searchManager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
        autoCreateIndexes: true,
      },
      transformRegistry: createSearchTransformRegistry(),
    });

    await searchManager.initialize([]);
    pluginState.set('slingshot-search', createSearchRuntime(searchManager));
  });

  afterEach(async () => {
    await searchManager.teardown();
  });

  it('Thread has search config with write-through syncMode', () => {
    expect(Thread.search).toBeDefined();
    expect(Thread.search?.syncMode).toBe('write-through');
    expect(Thread.search?.fields?.title).toBeDefined();
  });

  it('resolving threadFactories with FrameworkStoreInfra registers Thread', () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    resolveRepo(threadFactories, 'memory', infra);

    const all = entityRegistry.getAll();
    const threadEntry = all.find(e => e.name === 'Thread');
    expect(threadEntry).toBeDefined();
    expect(threadEntry?.search).toBeDefined();
  });

  it('Thread CRUD mutations are write-through synced to the search provider', async () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    const adapter = resolveRepo(threadFactories, 'memory', infra);

    const thread = await adapter.create({
      containerId: 'container-1',
      authorId: 'user-1',
      title: 'Search Test Thread',
      status: 'published' as const,
    } as unknown as Parameters<typeof adapter.create>[0]);

    // Wait for async write-through + ensureConfigEntity
    await new Promise(r => setTimeout(r, 30));

    // Retrieve client and verify indexing happened
    const client = searchManager.getSearchClient(Thread._storageName);
    const results = await client.search({ q: 'Search Test Thread' });
    expect(results.hits.length).toBeGreaterThan(0);
    expect(results.hits[0].document['id']).toBe(thread.id);

    // Update and verify re-index
    await adapter.update(thread.id, { title: 'Renamed Thread' });
    await new Promise(r => setTimeout(r, 20));

    const afterUpdate = await client.search({ q: 'Renamed Thread' });
    expect(afterUpdate.hits.some(h => h.document['id'] === thread.id)).toBe(true);

    // Delete and verify removal
    await adapter.delete(thread.id);
    await new Promise(r => setTimeout(r, 20));

    const afterDelete = await client.search({ q: 'Renamed Thread' });
    expect(afterDelete.hits.every(h => h.document['id'] !== thread.id)).toBe(true);
  });
});

// ============================================================================
// Test 4: Community Reply entity wired through
// ============================================================================

describe('P0.2 — Test 4: community Reply entity search wiring', () => {
  let searchManager: SearchManager;
  let pluginState: Map<string, unknown>;
  let entityRegistry: EntityRegistry;

  beforeEach(async () => {
    pluginState = new Map();
    entityRegistry = createEntityRegistry();
    searchManager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
        autoCreateIndexes: true,
      },
      transformRegistry: createSearchTransformRegistry(),
    });

    await searchManager.initialize([]);
    pluginState.set('slingshot-search', createSearchRuntime(searchManager));
  });

  afterEach(async () => {
    await searchManager.teardown();
  });

  it('Reply has search config with write-through syncMode', () => {
    expect(Reply.search).toBeDefined();
    expect(Reply.search?.syncMode).toBe('write-through');
    expect(Reply.search?.fields?.body).toBeDefined();
  });

  it('resolving replyFactories with FrameworkStoreInfra registers Reply', () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    resolveRepo(replyFactories, 'memory', infra);

    const all = entityRegistry.getAll();
    const replyEntry = all.find(e => e.name === 'Reply');
    expect(replyEntry).toBeDefined();
    expect(replyEntry?.search).toBeDefined();
  });

  it('Reply CRUD mutations are write-through synced to the search provider', async () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    const adapter = resolveRepo(replyFactories, 'memory', infra);

    const reply = await adapter.create({
      threadId: 'thread-1',
      authorId: 'user-1',
      body: 'Search Test Reply body',
      status: 'published' as const,
    } as unknown as Parameters<typeof adapter.create>[0]);

    // Wait for async write-through + ensureConfigEntity
    await new Promise(r => setTimeout(r, 30));

    // Retrieve client and verify indexing happened
    const client = searchManager.getSearchClient(Reply._storageName);
    const results = await client.search({ q: 'Search Test Reply' });
    expect(results.hits.length).toBeGreaterThan(0);
    expect(results.hits[0].document['id']).toBe(reply.id);

    // Delete and verify removal
    await adapter.delete(reply.id);
    await new Promise(r => setTimeout(r, 20));

    const afterDelete = await client.search({ q: 'Search Test Reply' });
    expect(afterDelete.hits.every(h => h.document['id'] !== reply.id)).toBe(true);
  });
});
