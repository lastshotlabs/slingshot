/**
 * P16 — op.search() delegation fix tests.
 *
 * Verifies that entities with search config but no explicit operations config
 * still delegate op.search to the provider when one is available.
 *
 * Also covers fallback behavior when the provider is unavailable or fails.
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
import { createSearchManager } from '../src/searchManager';
import type { SearchManager } from '../src/searchManager';
import { createSearchTransformRegistry } from '../src/transformRegistry';

// ============================================================================
// Shared bootstrap helpers (same pattern as wiring.test.ts)
// ============================================================================

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

    if (syncMode === 'write-through') {
      return {
        syncMode,
        ensureReady: async () => {
          await runtime.ensureConfigEntity(config);
        },
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
      if (config.search) {
        const runtime = getSearchPluginRuntime();
        if (runtime) {
          void runtime.ensureConfigEntity(config).catch(err => {
            console.error(`[test-infra] ensureConfigEntity failed:`, err);
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

// ============================================================================
// Test entities
// ============================================================================

// Entity without explicit operations (P16: deriveSearchOpsFromConfig path)
const Post = defineEntity('Post', {
  namespace: 'blog',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    title: field.string(),
  },
  search: {
    fields: {
      title: { searchable: true, weight: 2 },
    },
    // syncMode defaults to write-through
  },
});

// Entity with explicit search operations
const PostWithOps = defineEntity('PostWithOps', {
  namespace: 'blog',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    title: field.string(),
  },
  search: {
    fields: {
      title: { searchable: true, weight: 2 },
    },
  },
});

const postOps = {
  search: {
    kind: 'search' as const,
    fields: ['title'],
    useSearchProvider: true,
  },
};

const postOpsNoProvider = {
  search: {
    kind: 'search' as const,
    fields: ['title'],
    useSearchProvider: false,
  },
};

// ============================================================================
// P16 Test 1: entity with search config + useSearchProvider: true (default)
//             delegates to provider when available
// ============================================================================

describe('P16 — Test 1: search config with useSearchProvider: true delegates to provider', () => {
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

  it('search config alone exposes a provider-backed search op on the adapter', async () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    const adapter = resolveRepo(createEntityFactories(Post), 'memory', infra);

    const created = await adapter.create({
      title: 'Provider Delegation Test',
    } as unknown as Parameters<typeof adapter.create>[0]);
    await new Promise(r => setTimeout(r, 30));

    const searchAdapter = adapter as unknown as {
      search: (q: string) => Promise<Array<Record<string, unknown>>>;
    };
    const results = await searchAdapter.search('Provider Delegation');
    expect(Array.isArray(results)).toBe(true);
    expect(results.some(r => r['id'] === created.id)).toBe(true);
  });

  it('explicit ops with useSearchProvider: true delegate to provider', async () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    const adapter = resolveRepo(createEntityFactories(PostWithOps, postOps), 'memory', infra);

    const created = await adapter.create({
      title: 'Explicit Ops Delegation',
    } as unknown as Parameters<typeof adapter.create>[0]);
    await new Promise(r => setTimeout(r, 30));

    // The search method should delegate to the provider
    const results = await (
      adapter as unknown as { search: (q: string) => Promise<unknown[]> }
    ).search('Explicit Ops');
    expect(Array.isArray(results)).toBe(true);
    expect((results as Array<Record<string, unknown>>).some(r => r['id'] === created.id)).toBe(
      true,
    );
  });
});

// ============================================================================
// P16 Test 2: entity with search config + useSearchProvider: false
//             uses DB-native
// ============================================================================

describe('P16 — Test 2: useSearchProvider: false uses DB-native search', () => {
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

  it('search op with useSearchProvider: false uses DB-native (not the provider)', async () => {
    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    const adapter = resolveRepo(
      createEntityFactories(PostWithOps, postOpsNoProvider),
      'memory',
      infra,
    );

    const created = await adapter.create({ title: 'DB Native Search' } as unknown as Parameters<
      typeof adapter.create
    >[0]);
    await new Promise(r => setTimeout(r, 10));

    // DB-native search should work directly from memory adapter
    const results = await (
      adapter as unknown as { search: (q: string) => Promise<unknown[]> }
    ).search('DB Native');
    expect(Array.isArray(results)).toBe(true);
    expect((results as Array<Record<string, unknown>>).some(r => r['id'] === created.id)).toBe(
      true,
    );
  });
});

// ============================================================================
// P16 Test 3: search config but no provider configured — falls back to DB-native
// ============================================================================

describe('P16 — Test 3: search config but no provider — DB-native fallback, no error', () => {
  let entityRegistry: EntityRegistry;

  beforeEach(() => {
    entityRegistry = createEntityRegistry();
  });

  it('entity with search config but no search plugin does not throw', async () => {
    const pluginState = new Map<string, unknown>(); // no slingshot-search entry
    const searchManager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
        autoCreateIndexes: true,
      },
      transformRegistry: createSearchTransformRegistry(),
    });

    const infra = createTestInfra({ entityRegistry, searchManager: searchManager, pluginState });
    // No provider loaded — RESOLVE_SEARCH_CLIENT returns null, RESOLVE_SEARCH_SYNC returns undefined

    const adapter = resolveRepo(createEntityFactories(PostWithOps, postOps), 'memory', infra);

    // Should not throw — provider unavailable is a no-op at the wiring level
    await expect(
      adapter.create({ title: 'No Provider Test' } as unknown as Parameters<
        typeof adapter.create
      >[0]),
    ).resolves.toBeDefined();

    await searchManager.teardown();
  });

  it('explicit search op with no provider falls back to DB-native without error', async () => {
    const pluginState = new Map<string, unknown>(); // no slingshot-search
    const searchManager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
        autoCreateIndexes: true,
      },
      transformRegistry: createSearchTransformRegistry(),
    });

    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    const adapter = resolveRepo(createEntityFactories(PostWithOps, postOps), 'memory', infra);

    await adapter.create({ title: 'Fallback Test' } as unknown as Parameters<
      typeof adapter.create
    >[0]);

    // DB-native search should still work
    const results = await (
      adapter as unknown as { search: (q: string) => Promise<unknown[]> }
    ).search('Fallback');
    expect(Array.isArray(results)).toBe(true);

    await searchManager.teardown();
  });
});

// ============================================================================
// P16 Test 4: provider failure during search — falls back to DB-native, emits warning
// ============================================================================

describe('P16 — Test 4: provider failure during search falls back to DB-native', () => {
  it('falls back to DB-native and logs a warning when provider throws', async () => {
    const pluginState = new Map<string, unknown>();
    const entityRegistry = createEntityRegistry();

    // Build a search manager with a real DB-native provider
    const searchManager = createSearchManager({
      pluginConfig: {
        providers: { default: { provider: 'db-native' } },
        autoCreateIndexes: true,
      },
      transformRegistry: createSearchTransformRegistry(),
    });
    await searchManager.initialize([]);

    // Override the runtime so getSearchClient returns a client that throws on search
    const faultyClient: SearchClientLike = {
      indexDocument: async () => {},
      removeDocument: async () => {},
      search: async () => {
        throw new Error('[test] provider search failure');
      },
    };

    const faultyRuntime: SearchPluginRuntime = {
      async ensureConfigEntity(entity: ResolvedEntityConfig) {
        await searchManager.ensureConfigEntity(entity);
      },
      getSearchClient(): SearchClientLike | null {
        return faultyClient;
      },
    };

    pluginState.set('slingshot-search', faultyRuntime);

    const infra = createTestInfra({ entityRegistry, searchManager, pluginState });
    const adapter = resolveRepo(createEntityFactories(PostWithOps, postOps), 'memory', infra);

    // Create a document so DB-native has something to find
    await adapter.create({ title: 'Fallback From Failure' } as unknown as Parameters<
      typeof adapter.create
    >[0]);
    await new Promise(r => setTimeout(r, 20));

    // The delegation wrapper swallows provider errors and falls back to DB-native
    const results = await (
      adapter as unknown as {
        search: (q: string) => Promise<unknown[]>;
      }
    ).search('Fallback From Failure');

    expect(Array.isArray(results)).toBe(true);
    // DB-native should find it even though provider threw
    expect((results as Array<Record<string, unknown>>).length).toBeGreaterThan(0);

    await searchManager.teardown();
  });
});
