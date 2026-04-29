import type { InfrastructureResult } from '@framework/createInfrastructure';
import type {
  EntityRegistry,
  PluginStateMap,
  ResolvedEntityConfig,
  SearchClientLike,
  SearchPluginRuntime,
  SlingshotEventBus,
} from '@lastshotlabs/slingshot-core';
import {
  RESOLVE_COMPOSITE_FACTORIES,
  RESOLVE_ENTITY_FACTORIES,
  RESOLVE_REINDEX_SOURCE,
  getSearchPluginRuntimeOrNull,
} from '@lastshotlabs/slingshot-core';
import { createCompositeFactories, createEntityFactories } from '@lastshotlabs/slingshot-entity';
import {
  type FrameworkStoreInfra,
  REGISTER_ENTITY,
  RESOLVE_SEARCH_CLIENT,
  RESOLVE_SEARCH_SYNC,
  type ResolvedSearchSync,
} from './internalRepoResolution';

interface CreateContextStoreInfraOptions {
  readonly appName: string;
  readonly infra: InfrastructureResult;
  readonly bus: SlingshotEventBus;
  readonly pluginState: PluginStateMap;
  readonly entityRegistry: EntityRegistry;
}

/**
 * Retrieve the `SearchPluginRuntime` object from the shared plugin state map,
 * validating its shape at the optional-dependency boundary.
 *
 * The search plugin stores its runtime under the `'slingshot-search'` key in
 * `SlingshotContext.pluginState`. Because values are typed as `unknown`, the
 * shape must be verified before use.
 *
 * @param pluginState - The per-app plugin state map from `SlingshotContext`.
 * @returns The `SearchPluginRuntime` if the search plugin is active and its
 *   state is well-formed, or `null` if the plugin is absent or the stored
 *   value does not satisfy the expected interface.
 */
function getSearchPluginRuntime(pluginState: PluginStateMap): SearchPluginRuntime | null {
  return getSearchPluginRuntimeOrNull(pluginState);
}

/**
 * Ensure the search plugin has registered the entity's index schema and is
 * ready to accept documents for the given entity config.
 *
 * Calls `SearchPluginRuntime.ensureConfigEntity()` which is idempotent — safe
 * to call multiple times for the same config. Returns the runtime so callers
 * can immediately proceed to index operations without a second lookup.
 *
 * @param config - The resolved entity configuration whose search index should
 *   be prepared.
 * @param pluginState - The per-app plugin state map from `SlingshotContext`.
 * @returns The active `SearchPluginRuntime` after the entity has been readied,
 *   or `null` if the search plugin is not installed.
 * @throws If `SearchPluginRuntime.ensureConfigEntity()` rejects (e.g. network
 *   failure reaching the search backend).
 */
async function ensureConfigEntityReady(
  config: ResolvedEntityConfig,
  pluginState: PluginStateMap,
): Promise<SearchPluginRuntime | null> {
  const searchRuntime = getSearchPluginRuntime(pluginState);
  if (!searchRuntime) return null;

  await searchRuntime.ensureConfigEntity(config);
  return searchRuntime;
}

/**
 * Fire-and-forget variant of `ensureConfigEntityReady`.
 *
 * Used during entity registration (`REGISTER_ENTITY`) which runs synchronously
 * inside adapter factory calls. Errors are caught and logged rather than
 * propagated — a transient search-backend failure must never prevent an entity
 * adapter from being created or a request from completing.
 *
 * Short-circuits when the entity config has no `search` block, so callers do
 * not need to guard the call.
 *
 * @param config - The resolved entity configuration to ready.
 * @param pluginState - The per-app plugin state map from `SlingshotContext`.
 * @returns `void` — errors are suppressed and written to `console.error`.
 */
function ensureConfigEntityBestEffort(
  config: ResolvedEntityConfig,
  pluginState: PluginStateMap,
): void {
  if (!config.search) return;

  void ensureConfigEntityReady(config, pluginState).catch((err: unknown) => {
    console.error(
      `[slingshot-search] Failed to initialize search runtime for '${config._storageName}':`,
      err,
    );
  });
}

/**
 * Build the `ResolvedSearchSync` descriptor for the given entity config.
 *
 * The descriptor's shape depends on the entity's configured `search.syncMode`:
 *
 * - `'write-through'` (default): Returns a descriptor whose `indexDocument` /
 *   `deleteDocument` methods call directly into the search client after each
 *   mutation. Returns `undefined` when the search plugin is absent.
 * - `'event-bus'`: Returns a descriptor that emits
 *   `entity:<storageName>.created|updated|deleted` events on the `SlingshotEventBus`.
 *   Returns `undefined` when the search plugin or event bus is unavailable.
 * - `'manual'`: Returns a descriptor with a no-op `ensureReady`. No sync
 *   adapter is attached; the consumer is responsible for indexing.
 *
 * Returns `undefined` when the entity has no `search` config at all, signalling
 * to `wrapWithSearchSync` that no wrapping is needed.
 *
 * @param config - Resolved entity configuration (must include `search` block for
 *   any non-`undefined` return value).
 * @param bus - The app-level `SlingshotEventBus`, used only for `'event-bus'` mode.
 * @param pluginState - The per-app plugin state map from `SlingshotContext`.
 * @returns A `ResolvedSearchSync` discriminated union, or `undefined` when sync
 *   is not applicable or the required runtime is unavailable.
 */
function resolveSearchSync(
  config: ResolvedEntityConfig,
  bus: SlingshotEventBus,
  pluginState: PluginStateMap,
): ResolvedSearchSync | undefined {
  if (!config.search) return undefined;

  const syncMode = config.search.syncMode ?? 'write-through';
  if (syncMode === 'manual') {
    return {
      syncMode,
      ensureReady: async () => {},
    };
  }

  const ensureReady = async (): Promise<void> => {
    await ensureConfigEntityReady(config, pluginState);
  };

  if (syncMode === 'event-bus') {
    const searchRuntime = getSearchPluginRuntime(pluginState);
    if (!searchRuntime || typeof bus.emit !== 'function') return undefined;
    return {
      syncMode,
      storageName: config._storageName,
      eventBus: bus,
      ensureReady,
    };
  }

  const searchRuntime = getSearchPluginRuntime(pluginState);
  if (!searchRuntime) return undefined;

  return {
    syncMode,
    ensureReady,
    indexDocument: async entity => {
      const runtime = await ensureConfigEntityReady(config, pluginState);
      const client = runtime?.getSearchClient(config._storageName);
      if (!client) return;
      await client.indexDocument(entity);
    },
    deleteDocument: async id => {
      const runtime = await ensureConfigEntityReady(config, pluginState);
      const client = runtime?.getSearchClient(config._storageName);
      if (!client) return;
      await client.removeDocument(id);
    },
  };
}

/**
 * Create the per-app `FrameworkStoreInfra` — the concrete `StoreInfra`
 * implementation that the framework bootstrap layer attaches to `SlingshotContext`
 * via `attachContextStoreInfra`.
 *
 * @remarks
 * **Reflect symbol injection (DI)**
 *
 * `FrameworkStoreInfra` extends `StoreInfra` with three well-known Symbols:
 *
 * - `REGISTER_ENTITY` — Called once per entity config the first time an
 *   adapter is created for that entity. Registers the config in the app's
 *   `EntityRegistry` and fires a best-effort search index initialization.
 * - `RESOLVE_SEARCH_SYNC` — Returns a `ResolvedSearchSync` descriptor for the
 *   entity, driving the `wrapWithSearchSync` decorator in the entity factory
 *   layer.
 * - `RESOLVE_SEARCH_CLIENT` — Returns the live `SearchClientLike` for the
 *   entity, enabling search-provider delegation in operation executors.
 *
 * These hooks are consumed via `Reflect.get(infra, SYMBOL)` inside the entity
 * factory layer (`createEntityFactories`). Plugins and packages never receive
 * them as function arguments — they are resolved at factory call time through
 * the infra object. This is the framework's primary DI mechanism for
 * cross-cutting concerns.
 *
 * **Lazy infra access**
 *
 * Each `getRedis()` / `getMongo()` / `getSqliteDb()` / `getPostgres()` accessor
 * throws immediately when the underlying infra connection was not configured for
 * this app. Errors surface at the first use site rather than at bootstrap time.
 *
 * @param options - App name, infrastructure connections, event bus, shared
 *   plugin state map, and the app's entity registry.
 * @returns A frozen-compatible `FrameworkStoreInfra` object ready to be
 *   attached to the app context.
 */
export function createContextStoreInfra(
  options: CreateContextStoreInfraOptions,
): FrameworkStoreInfra {
  const { appName, infra, bus, pluginState, entityRegistry } = options;
  const registeredEntities = new Set<string>();
  const storeInfra: FrameworkStoreInfra = {
    appName,
    getRedis: () => {
      if (!infra.redis) throw new Error('[slingshot] Redis is not configured for this app');
      return infra.redis;
    },
    getMongo: () => {
      if (!infra.mongo?.app) throw new Error('[slingshot] Mongo app connection is not configured');
      return { conn: infra.mongo.app, mg: infra.mongo.mongoose };
    },
    getSqliteDb: () => {
      if (!infra.sqliteDb) throw new Error('[slingshot] SQLite is not configured for this app');
      return infra.sqliteDb;
    },
    getPostgres: () => {
      if (!infra.postgres) throw new Error('[slingshot] Postgres is not configured for this app');
      return infra.postgres;
    },
    [REGISTER_ENTITY](config: ResolvedEntityConfig): void {
      if (registeredEntities.has(config._storageName)) return;
      entityRegistry.register(config);
      registeredEntities.add(config._storageName);
      ensureConfigEntityBestEffort(config, pluginState);
    },
    [RESOLVE_SEARCH_SYNC](config: ResolvedEntityConfig): ResolvedSearchSync | undefined {
      return resolveSearchSync(config, bus, pluginState);
    },
    [RESOLVE_SEARCH_CLIENT](config: ResolvedEntityConfig): SearchClientLike | null {
      if (!config.search) return null;
      const searchRuntime = getSearchPluginRuntime(pluginState);
      if (!searchRuntime) return null;
      return searchRuntime.getSearchClient(config._storageName);
    },
    // Inject createEntityFactories / createCompositeFactories so packages/slingshot-entity
    // can create RepoFactories<T> at setupRoutes time without a direct import
    // from the root app (CLAUDE.md Rule 16).
    [RESOLVE_ENTITY_FACTORIES]: createEntityFactories,
    [RESOLVE_COMPOSITE_FACTORIES]: createCompositeFactories,
    // Default no-op. Overwritten by the entity plugin during setupPost once
    // adapters are resolved. The search admin rebuild route reads this slot.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    [RESOLVE_REINDEX_SOURCE](_storageName: string): null {
      return null;
    },
  };

  for (const key of [
    'appName',
    'getRedis',
    'getMongo',
    'getSqliteDb',
    'getPostgres',
    REGISTER_ENTITY,
    RESOLVE_SEARCH_SYNC,
    RESOLVE_SEARCH_CLIENT,
    RESOLVE_ENTITY_FACTORIES,
    RESOLVE_COMPOSITE_FACTORIES,
  ] as const) {
    Object.defineProperty(storeInfra, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: storeInfra[key],
    });
  }

  Object.defineProperty(storeInfra, RESOLVE_REINDEX_SOURCE, {
    configurable: false,
    enumerable: true,
    writable: true,
    value: storeInfra[RESOLVE_REINDEX_SOURCE],
  });

  return Object.preventExtensions(storeInfra);
}
