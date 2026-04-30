/**
 * Central search orchestrator.
 *
 * Created by the search plugin via `createSearchManager()`. Manages provider
 * lifecycle, index creation/update, entity search clients, federated search,
 * and reindex operations. All state is closure-owned — no singletons.
 */
import type {
  GeoSearchConfig,
  Logger,
  MetricsEmitter,
  ResolvedEntityConfig,
} from '@lastshotlabs/slingshot-core';
import { createNoopMetricsEmitter, noopLogger } from '@lastshotlabs/slingshot-core';
import { applyGeoTransform } from './geoTransform';
import { deriveIndexSettings } from './indexSettings';
import { createAlgoliaProvider } from './providers/algolia';
import { createDbNativeProvider } from './providers/dbNative';
import { createElasticsearchProvider } from './providers/elasticsearch';
import { createMeilisearchProvider } from './providers/meilisearch';
import { createTypesenseProvider } from './providers/typesense';
import { withRetry } from './retry';
import { type SearchCircuitBreaker, createSearchCircuitBreaker } from './searchCircuitBreaker';
import type { SearchTransformRegistry } from './transformRegistry';
import type { SearchPluginConfig } from './types/config';
import type { SearchProvider } from './types/provider';
import type { SearchHealthResult, SearchIndexSettings } from './types/provider';
import type { FederatedSearchQuery, SearchQuery, SuggestQuery } from './types/query';
import type {
  FederatedSearchHit,
  FederatedSearchResponse,
  SearchResponse,
  SuggestResponse,
} from './types/response';

// ============================================================================
// Public interfaces
// ============================================================================

/**
 * Optional tenant context passed to search, suggest, and index operations.
 *
 * When provided, the search manager applies tenant isolation automatically:
 * - `'filtered'` mode — injects a `tenantField = tenantId` filter into every
 *   query so documents from other tenants are never returned.
 * - `'index-per-tenant'` mode — routes operations to a per-tenant index named
 *   `<baseIndex>__tenant_<tenantId>`, creating it lazily if needed.
 */
export interface TenantContext {
  readonly tenantId?: string;
}

/**
 * Typed search client scoped to a single entity type.
 *
 * Obtained via `SearchManager.getSearchClient(entityStorageName)`. Handles
 * document transformation (via the registered transform function), geo
 * transformation, and tenant isolation automatically.
 *
 * @typeParam Entity - The entity shape. Defaults to `Record<string, unknown>`.
 *
 * @example
 * ```ts
 * const client = searchManager.getSearchClient('community_threads');
 * const results = await client.search({ q: 'hello' });
 * await client.indexDocument(threadEntity);
 * await client.removeDocument(threadId);
 * ```
 */
export interface EntitySearchClient<Entity = Record<string, unknown>> {
  /**
   * Execute a full-text search query.
   *
   * @param query - Search parameters including query string, filters, sort, and pagination.
   * @param opts - Optional tenant context for multi-tenant isolation.
   * @returns A `SearchResponse` with matched hits and pagination metadata.
   */
  search(query: SearchQuery, opts?: TenantContext): Promise<SearchResponse<Entity>>;
  /**
   * Execute an autocomplete suggestion query.
   *
   * @param query - Suggestion parameters including prefix string and field list.
   * @param opts - Optional tenant context.
   * @returns A `SuggestResponse` with ordered candidate strings.
   */
  suggest(query: SuggestQuery, opts?: TenantContext): Promise<SuggestResponse>;
  /**
   * Index (upsert) a single entity document.
   *
   * The document is run through the entity's registered transform function
   * and geo transform (if configured) before being sent to the provider.
   *
   * @param entity - The entity to index.
   * @param opts - Optional tenant context.
   */
  indexDocument(entity: Entity, opts?: TenantContext): Promise<void>;
  /**
   * Index (upsert) a batch of entity documents.
   *
   * @param entities - The entities to index.
   * @param opts - Optional tenant context.
   */
  indexDocuments(entities: ReadonlyArray<Entity>, opts?: TenantContext): Promise<void>;
  /**
   * Remove a document from the search index by its primary key.
   *
   * @param id - The document's primary key value.
   * @param opts - Optional tenant context.
   */
  removeDocument(id: string | number, opts?: TenantContext): Promise<void>;
}

/**
 * Central orchestrator for the slingshot search subsystem.
 *
 * Manages provider lifecycle, index creation and settings synchronisation,
 * entity search clients, federated (multi-index) search, full reindex
 * operations, and health checks. All state is closure-owned — each
 * `createSearchManager()` call creates an independent instance.
 *
 * Obtain via `createSearchManager(config)`. The search plugin creates this
 * internally and exposes it through `SlingshotContext.pluginState`.
 */
export interface SearchManager {
  /**
   * Initialize all providers and create/update indexes for every entity that
   * has a search configuration.
   *
   * Called once during the plugin's `setupPost` phase. Subsequent calls are
   * no-ops (guarded by an `initialized` flag).
   *
   * @param entities - The full list of resolved entity configs from the entity registry.
   */
  initialize(entities: ReadonlyArray<ResolvedEntityConfig>): Promise<void>;

  /**
   * Lazily ensure that a single config-driven entity has an initialized index
   * and provider state.
   *
   * Used by the write-through sync path when an entity is encountered after
   * initial startup (e.g. dynamically registered entities). Concurrent calls
   * for the same entity are deduplicated via a pending-initialization map.
   *
   * @param entity - The resolved entity config to initialise.
   */
  ensureConfigEntity(entity: ResolvedEntityConfig): Promise<void>;

  /**
   * Return a typed search client scoped to a single entity.
   *
   * The client handles document transformation, geo transforms, and tenant
   * isolation transparently. Accepts either the entity's storage name (e.g.
   * `'community_threads'`) or its entity name (e.g. `'Thread'`).
   *
   * @param entityStorageName - Entity storage name or entity class name.
   * @returns A fully-configured `EntitySearchClient`.
   * @throws {Error} If no search config has been registered for the entity.
   */
  getSearchClient(entityStorageName: string): EntitySearchClient;

  /**
   * Execute a federated (multi-index) search and merge results.
   *
   * Queries multiple indexes in parallel (grouped by provider for efficiency)
   * and merges the results according to the `merge` strategy in the query:
   * - `'interleave'` (default) — round-robin by weighted score
   * - `'weighted'` — merge all hits sorted by `score × weight`
   * - `'concat'` — concatenate results per-index in declaration order
   *
   * @param query - Federated query including per-index entries and merge strategy.
   * @returns Combined hits and per-index statistics.
   * @throws {Error} If an index name in `query.queries` has not been registered.
   */
  federatedSearch(query: FederatedSearchQuery): Promise<FederatedSearchResponse>;

  /**
   * Full reindex an entity from an async iterable data source.
   *
   * Clears the index, then streams all documents through the entity's
   * registered transform, batches them into groups of 500, and sends each
   * batch to the provider. Uses `waitForTask` when the provider supports it
   * (Meilisearch, Algolia) to ensure each batch is fully indexed before
   * the next batch starts.
   *
   * @param entityStorageName - Entity storage name or entity class name.
   * @param source - Async iterable that yields raw entity documents. Typically
   *   a database cursor.
   * @returns The total number of documents indexed and the wall-clock duration.
   * @throws {Error} If no search config exists for the entity.
   */
  reindex(
    entityStorageName: string,
    source: AsyncIterable<Record<string, unknown>>,
  ): Promise<{ documentsIndexed: number; durationMs: number }>;

  /**
   * Run health checks on all configured providers.
   *
   * @returns A map of provider config key → `SearchHealthResult`. Each entry
   *   includes `healthy`, `latencyMs`, and optional `version`/`error`.
   */
  healthCheck(): Promise<Record<string, SearchHealthResult>>;

  /**
   * Return the resolved index name for an entity (including any configured prefix).
   *
   * @param entityStorageName - Entity storage name or entity class name.
   * @returns The full index name, or `undefined` if the entity is not registered.
   */
  getIndexName(entityStorageName: string): string | undefined;

  /**
   * Return the derived `SearchIndexSettings` that were applied when the entity's
   * index was created.
   *
   * @param entityStorageName - Entity storage name or entity class name.
   * @returns The index settings, or `undefined` if the entity is not registered.
   */
  getIndexSettings(entityStorageName: string): SearchIndexSettings | undefined;

  /**
   * Return the `SearchProvider` instance handling a specific entity's index.
   *
   * Useful for advanced operations that require direct provider access.
   *
   * @param entityStorageName - Entity storage name or entity class name.
   * @returns The provider instance, or `undefined` if the entity is not registered.
   */
  getProvider(entityStorageName: string): SearchProvider | undefined;

  /**
   * Return a provider instance by its config key (e.g. `'default'`).
   *
   * @param providerKey - The key used in `SearchPluginConfig.providers`.
   * @returns The provider instance, or `undefined` if it has not been initialised yet.
   */
  getProviderByKey(providerKey: string): SearchProvider | undefined;

  /**
   * Return the tenant isolation configuration for an entity.
   *
   * @param entityStorageName - Entity storage name or entity class name.
   * @returns The tenant isolation mode and field name, or `undefined` if the
   *   entity has no tenant isolation configured.
   */
  getEntityTenantConfig(
    entityStorageName: string,
  ): { tenantIsolation: 'filtered' | 'index-per-tenant'; tenantField: string } | undefined;

  /**
   * Resolve an entity name or class name to its canonical storage name.
   *
   * Accepts either the entity's storage name (e.g. `'community_threads'`) or
   * its class name (e.g. `'Thread'`) and returns the canonical storage name.
   *
   * @param nameOrStorageName - Entity storage name or class name.
   * @returns The canonical storage name, or `null` if the entity is not
   *   registered with the search manager.
   */
  resolveStorageName(nameOrStorageName: string): string | null;

  /**
   * Gracefully shut down all providers.
   *
   * Clears all closure-owned state (providers, entity states, tenant index
   * cache). After calling this the manager is inoperable — create a new
   * instance if the application needs to restart.
   */
  teardown(): Promise<void>;

  /**
   * Read-only counter metrics exposed for observability. Returns a snapshot —
   * the values are not live references, so callers can safely store and diff.
   */
  readonly metrics: SearchManagerMetrics;
}

// ============================================================================
// Internal types
// ============================================================================

interface EntitySearchState {
  readonly indexName: string;
  readonly provider: SearchProvider;
  /** Stable provider key (e.g. `'default'`) used as a metric label. */
  readonly providerKey: string;
  readonly settings: SearchIndexSettings;
  readonly pkField: string;
  readonly transformName?: string;
  readonly geoConfig?: GeoSearchConfig;
  readonly tenantIsolation?: 'filtered' | 'index-per-tenant';
  readonly tenantField?: string;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Reason codes passed to `onTenantIndexEvicted` so callers can distinguish
 * eviction triggers (currently only LRU capacity, but future capacity policies
 * could add more).
 */
export type TenantIndexEvictionReason = 'lru-capacity';

/**
 * Callback fired when a tenant index entry is evicted from the in-memory LRU
 * cache. Useful for emitting metrics, audit logs, or warming alerts.
 */
export type TenantIndexEvictedHandler = (event: {
  readonly tenantId: string;
  readonly indexName: string;
  readonly reason: TenantIndexEvictionReason;
}) => void;

/** Counter metrics exposed by the search manager. */
export interface SearchManagerMetrics {
  /** Cumulative number of tenant index entries evicted from the LRU cache. */
  readonly tenantIndexEvictions: number;
}

/** Configuration for `createSearchManager()`. */
export interface SearchManagerConfig {
  /** Plugin-level config including provider declarations and index prefix. */
  readonly pluginConfig: SearchPluginConfig;
  /** Registry of named document transform functions. */
  readonly transformRegistry: SearchTransformRegistry;
  /**
   * Maximum number of tenant indexes to track in the in-memory creation cache
   * before LRU eviction kicks in. Defaults to 10,000.
   */
  readonly tenantCacheCapacity?: number;
  /**
   * Optional callback invoked whenever a tenant index entry is evicted from
   * the LRU cache. Useful for telemetry — eviction implies the manager will
   * re-issue `createOrUpdateIndex` the next time that tenant is touched.
   */
  readonly onTenantIndexEvicted?: TenantIndexEvictedHandler;
  /**
   * Optional unified metrics emitter. When provided, the manager records
   * counters/gauges/timings on hot paths (`search.query.count`,
   * `search.query.duration`, `search.circuitBreaker.state`). Defaults to a
   * no-op emitter so callers can omit the field without a feature check.
   */
  readonly metrics?: MetricsEmitter;
  /**
   * Optional structured logger. When provided, the manager routes operational
   * messages (warnings, errors, tenant index eviction events) through this
   * logger instead of `console`. Defaults to a no-op logger.
   */
  readonly logger?: Logger;
}

/**
 * Create a search manager with fully closure-owned state.
 *
 * The manager is the single point of coordination for everything search-related
 * within one app instance:
 * - **Provider lifecycle** — resolves provider configs to `SearchProvider`
 *   instances on demand and connects them during `initialize()`.
 * - **Index management** — calls `createOrUpdateIndex()` for each entity that
 *   has a search config, optionally gated by `autoCreateIndexes`.
 * - **Entity search clients** — produces `EntitySearchClient` instances that
 *   handle transformation, geo transforms, and tenant isolation transparently.
 * - **Federated search** — fans out queries to multiple providers and merges
 *   results according to the configured strategy.
 * - **Reindex** — streams documents from a cursor through transforms and into
 *   the provider, waiting for async tasks on providers that queue writes.
 *
 * @param config - Plugin config and transform registry.
 * @returns A `SearchManager` instance. Call `initialize()` before using any
 *   search or index operations.
 *
 * @remarks
 * **Lazy provider creation** — provider instances are not created at
 * construction time. `resolveProviderInstance()` creates and caches them on
 * first use, so providers listed in the config but not used by any entity
 * never incur a connection.
 *
 * **Entity resolution** — both the entity's storage name (e.g.
 * `'community_threads'`) and its class name (e.g. `'Thread'`) are accepted by
 * all lookup methods. The manager maintains a `entityNameToStorageName` map
 * for the reverse lookup.
 *
 * **Thread safety** — `ensureConfigEntityInternal` deduplicates concurrent
 * initialization requests for the same entity using a `pendingEntityInitializations`
 * map, so parallel calls do not create the index twice.
 *
 * @example
 * ```ts
 * import { createSearchManager } from '@lastshotlabs/slingshot-search';
 *
 * const manager = createSearchManager({ pluginConfig, transformRegistry });
 * await manager.initialize(resolvedEntities);
 *
 * const client = manager.getSearchClient('community_threads');
 * const results = await client.search({ q: 'hello world' });
 *
 * // On graceful shutdown:
 * await manager.teardown();
 * ```
 */
export function createSearchManager(config: SearchManagerConfig): SearchManager {
  const { pluginConfig, transformRegistry, onTenantIndexEvicted } = config;
  const metrics: MetricsEmitter = config.metrics ?? createNoopMetricsEmitter();
  const logger: Logger = config.logger ?? noopLogger;

  // Closure-owned state
  const providers = new Map<string, SearchProvider>();
  const entityStates = new Map<string, EntitySearchState>();
  /** Maps entity name (e.g., "Thread") to storage name (e.g., "community_threads"). */
  const entityNameToStorageName = new Map<string, string>();
  const pendingEntityInitializations = new Map<string, Promise<void>>();
  /** Per-provider circuit breakers for manager-level fail-fast protection. */
  const providerBreakers = new Map<string, SearchCircuitBreaker>();
  /**
   * Tracks tenant indexes already created for index-per-tenant entities.
   * Key: `baseIndexName__tenant_{tenantId}`. Capped at MAX_TENANT_INDEXES_CACHE
   * entries with LRU eviction to prevent unbounded growth in high-tenancy deployments.
   */
  const DEFAULT_MAX_TENANT_INDEXES_CACHE = 10_000;
  const MAX_TENANT_INDEXES_CACHE =
    typeof config.tenantCacheCapacity === 'number' && config.tenantCacheCapacity > 0
      ? config.tenantCacheCapacity
      : DEFAULT_MAX_TENANT_INDEXES_CACHE;
  const createdTenantIndexes = new Map<string, boolean>();
  let tenantIndexEvictions = 0;
  let initialized = false;
  let providersConnected = false;

  /**
   * Publish a `search.circuitBreaker.state` gauge for a provider that
   * supports the optional `getCircuitBreakerState()` accessor. Mapping:
   * 0 = closed, 1 = open, 2 = half-open. Providers without a breaker are
   * silently skipped so the gauge stays interpretable for observers (a
   * missing series means "no breaker", not "closed").
   */
  function sampleCircuitBreaker(provider: SearchProvider, providerKey: string): void {
    if (typeof provider.getCircuitBreakerState !== 'function') return;
    const state = provider.getCircuitBreakerState();
    if (state === undefined) return;
    const value = state === 'closed' ? 0 : state === 'open' ? 1 : 2;
    metrics.gauge('search.circuitBreaker.state', value, { provider: providerKey });
  }

  /**
   * Parse a tenant-scoped index key (`<baseIndex>__tenant_<tenantId>`) into
   * its components. Returns `undefined` when the key does not match the
   * expected format — defensive in case future code introduces other key
   * shapes into the cache.
   */
  function parseTenantIndexKey(key: string): { indexName: string; tenantId: string } | undefined {
    const marker = '__tenant_';
    const idx = key.indexOf(marker);
    if (idx === -1) return undefined;
    return {
      indexName: key.slice(0, idx),
      tenantId: key.slice(idx + marker.length),
    };
  }

  // -------------------------------------------------------------------------
  // Provider resolution
  // -------------------------------------------------------------------------

  function resolveProviderInstance(providerKey: string): SearchProvider {
    const existing = providers.get(providerKey);
    if (existing) return existing;

    if (!(providerKey in pluginConfig.providers)) {
      throw new Error(
        `[slingshot-search] Provider '${providerKey}' not found in config. Available: [${Object.keys(pluginConfig.providers).join(', ')}]`,
      );
    }
    const providerConfig = pluginConfig.providers[providerKey];

    let provider: SearchProvider;

    switch (providerConfig.provider) {
      case 'db-native':
        provider = createDbNativeProvider();
        break;
      case 'meilisearch':
        provider = createMeilisearchProvider(providerConfig);
        break;
      case 'typesense':
        provider = createTypesenseProvider(providerConfig);
        break;
      case 'elasticsearch':
        provider = createElasticsearchProvider(providerConfig);
        break;
      case 'algolia':
        provider = createAlgoliaProvider(providerConfig);
        break;
      default: {
        const _exhaustive: never = providerConfig;
        throw new Error(
          `[slingshot-search] Unsupported provider type: '${(_exhaustive as { provider: string }).provider}'`,
        );
      }
    }

    providers.set(providerKey, provider);
    return provider;
  }

  async function ensureProvidersConnected(): Promise<void> {
    if (providersConnected) return;

    const providerKeys = Object.keys(pluginConfig.providers);
    for (const key of providerKeys) {
      const provider = resolveProviderInstance(key);
      await withProviderProtection(key, () => provider.connect());
    }
    providersConnected = true;
  }

  /**
   * Resolve (or create) the circuit breaker for `providerKey` and run `fn`
   * through it with transient-failure retry.
   *
   * The circuit breaker guards the entire retry envelope: a single provider
   * operation that fails transiently up to N times and succeeds on retry N+1
   * counts as ONE success for the breaker. Only after retries are exhausted
   * does the failure count toward tripping the breaker.
   */
  async function withProviderProtection<T>(providerKey: string, fn: () => Promise<T>): Promise<T> {
    let breaker = providerBreakers.get(providerKey);
    if (!breaker) {
      breaker = createSearchCircuitBreaker({ providerKey });
      providerBreakers.set(providerKey, breaker);
    }
    return breaker.guard(() => withRetry(fn));
  }

  async function cleanupAfterInitializationFailure(): Promise<void> {
    await Promise.allSettled([...providers.values()].map(provider => provider.teardown()));
    providers.clear();
    entityStates.clear();
    entityNameToStorageName.clear();
    pendingEntityInitializations.clear();
    createdTenantIndexes.clear();
    providersConnected = false;
    initialized = false;
  }

  async function registerConfigEntity(
    entity: ResolvedEntityConfig,
    autoCreate: boolean,
  ): Promise<void> {
    if (!entity.search || entityStates.has(entity._storageName)) return;

    const searchConfig = entity.search;
    const providerKey = searchConfig.provider ?? 'default';
    const provider = resolveProviderInstance(providerKey);
    const indexName = resolveIndexName(entity._storageName, searchConfig);
    const derivedSettings = deriveIndexSettings(searchConfig);
    const settings: SearchIndexSettings =
      entity._pkField !== 'id'
        ? { ...derivedSettings, primaryKey: entity._pkField }
        : derivedSettings;

    entityNameToStorageName.set(entity.name, entity._storageName);
    entityStates.set(entity._storageName, {
      indexName,
      provider,
      providerKey,
      settings,
      pkField: entity._pkField,
      transformName: searchConfig.transform,
      geoConfig: searchConfig.geo,
      tenantIsolation: searchConfig.tenantIsolation,
      tenantField: searchConfig.tenantField,
    });

    if (autoCreate) {
      await withProviderProtection(providerKey, () =>
        provider.createOrUpdateIndex(indexName, settings),
      );
    }
  }

  async function ensureConfigEntityInternal(entity: ResolvedEntityConfig): Promise<void> {
    if (!entity.search) return;
    if (entityStates.has(entity._storageName)) return;

    const pending = pendingEntityInitializations.get(entity._storageName);
    if (pending) {
      await pending;
      return;
    }

    const autoCreate = pluginConfig.autoCreateIndexes !== false;
    const initialization = (async () => {
      await ensureProvidersConnected();
      await registerConfigEntity(entity, autoCreate);
    })();

    pendingEntityInitializations.set(entity._storageName, initialization);
    try {
      await initialization;
    } finally {
      pendingEntityInitializations.delete(entity._storageName);
    }
  }

  /**
   * Resolve an entity identifier (storage name or entity name) to its storage name.
   * Tries direct storage name lookup first, then falls back to entity name lookup.
   */
  function resolveEntityKey(entityParam: string): string | undefined {
    if (entityStates.has(entityParam)) return entityParam;
    return entityNameToStorageName.get(entityParam);
  }

  function resolveIndexName(
    entityStorageName: string,
    entitySearchConfig?: { indexName?: string },
  ): string {
    const base = entitySearchConfig?.indexName ?? entityStorageName;
    return pluginConfig.indexPrefix ? `${pluginConfig.indexPrefix}${base}` : base;
  }

  // -------------------------------------------------------------------------
  // Manager implementation
  // -------------------------------------------------------------------------

  const manager: SearchManager = {
    async initialize(entities) {
      if (initialized) return;

      const autoCreate = pluginConfig.autoCreateIndexes !== false;

      try {
        await ensureProvidersConnected();

        for (const entity of entities) {
          await registerConfigEntity(entity, autoCreate);
        }

        initialized = true;
      } catch (error) {
        await cleanupAfterInitializationFailure();
        throw error;
      }
    },

    async ensureConfigEntity(entity) {
      await ensureConfigEntityInternal(entity);
    },

    getSearchClient(entityStorageName: string): EntitySearchClient {
      const key = resolveEntityKey(entityStorageName);
      const state = key ? entityStates.get(key) : undefined;
      if (!state) {
        throw new Error(
          `[slingshot-search] No search config for entity '${entityStorageName}'. ` +
            `Registered: [${[...entityStates.keys()].join(', ')}]`,
        );
      }

      const {
        indexName,
        provider,
        providerKey,
        pkField,
        transformName,
        geoConfig,
        tenantIsolation,
        tenantField,
        settings,
      } = state;
      const metricsLabels: Record<string, string> = { provider: providerKey };
      const transform = transformRegistry.resolve(transformName);

      function prepareDoc(entity: Record<string, unknown>): Record<string, unknown> {
        let doc = transform(entity);
        if (geoConfig) {
          doc = applyGeoTransform(doc, geoConfig);
        }
        return doc;
      }

      /** Resolve the target index name for a given tenant context. */
      function resolveTargetIndex(opts?: TenantContext): string {
        if (tenantIsolation === 'index-per-tenant' && opts?.tenantId) {
          return `${indexName}__tenant_${opts.tenantId}`;
        }
        return indexName;
      }

      /** Ensure a tenant-scoped index exists (lazy creation for index-per-tenant mode). */
      async function ensureTenantIndex(targetIndex: string): Promise<void> {
        if (tenantIsolation !== 'index-per-tenant') return;
        if (targetIndex === indexName) return; // base index, not tenant-scoped
        if (createdTenantIndexes.has(targetIndex)) return;

        // LRU eviction: remove the oldest entry when the cache is full.
        if (createdTenantIndexes.size >= MAX_TENANT_INDEXES_CACHE) {
          const oldest = createdTenantIndexes.keys().next().value;
          if (oldest !== undefined) {
            createdTenantIndexes.delete(oldest);
            tenantIndexEvictions++;
            const parsed = parseTenantIndexKey(oldest);
            const evictedIndexName = parsed?.indexName ?? oldest;
            const evictedTenantId = parsed?.tenantId ?? '';
            logger.info('[slingshot-search] tenant index cache evicted (lru-capacity)', {
              indexName: evictedIndexName,
              tenantId: evictedTenantId,
              cacheKey: oldest,
              reason: 'lru-capacity',
              capacity: MAX_TENANT_INDEXES_CACHE,
            });
            if (onTenantIndexEvicted) {
              try {
                onTenantIndexEvicted({
                  tenantId: evictedTenantId,
                  indexName: evictedIndexName,
                  reason: 'lru-capacity',
                });
              } catch (err) {
                logger.error('[slingshot-search] onTenantIndexEvicted callback threw', {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        }

        await withProviderProtection(providerKey, () =>
          provider.createOrUpdateIndex(targetIndex, settings),
        );
        createdTenantIndexes.set(targetIndex, true);
      }

      /** Inject tenant filter for filtered isolation mode. */
      function applyTenantFilter(
        filter: import('./types/query').SearchFilter | undefined,
        opts?: TenantContext,
      ): import('./types/query').SearchFilter | undefined {
        if (tenantIsolation !== 'filtered' || !tenantField || !opts?.tenantId) {
          return filter;
        }
        const tenantCondition: import('./types/query').SearchFilter = {
          field: tenantField,
          op: '=' as const,
          value: opts.tenantId,
        };
        return filter ? { $and: [tenantCondition, filter] } : tenantCondition;
      }

      return {
        async search(query: SearchQuery, opts?: TenantContext): Promise<SearchResponse> {
          const targetIndex = resolveTargetIndex(opts);
          if (tenantIsolation === 'index-per-tenant' && opts?.tenantId) {
            await ensureTenantIndex(targetIndex);
          }
          const decoratedQuery = { ...query, filter: applyTenantFilter(query.filter, opts) };
          // Metrics: count + duration on the search hot path. Counter increments
          // unconditionally (success or failure) so dashboards reflect total
          // attempts; duration is recorded only on success to keep latency
          // distributions free of error-path artefacts.
          metrics.counter('search.query.count', 1, metricsLabels);
          const start = performance.now();
          try {
            const response = await withProviderProtection(providerKey, () =>
              provider.search(targetIndex, decoratedQuery),
            );
            metrics.timing('search.query.duration', performance.now() - start, metricsLabels);
            sampleCircuitBreaker(provider, providerKey);
            return response;
          } catch (err) {
            sampleCircuitBreaker(provider, providerKey);
            throw err;
          }
        },

        async suggest(query: SuggestQuery, opts?: TenantContext): Promise<SuggestResponse> {
          const targetIndex = resolveTargetIndex(opts);
          if (tenantIsolation === 'index-per-tenant' && opts?.tenantId) {
            await ensureTenantIndex(targetIndex);
          }
          const decoratedQuery = { ...query, filter: applyTenantFilter(query.filter, opts) };
          metrics.counter('search.query.count', 1, metricsLabels);
          const start = performance.now();
          try {
            const response = await withProviderProtection(providerKey, () =>
              provider.suggest(targetIndex, decoratedQuery),
            );
            metrics.timing('search.query.duration', performance.now() - start, metricsLabels);
            sampleCircuitBreaker(provider, providerKey);
            return response;
          } catch (err) {
            sampleCircuitBreaker(provider, providerKey);
            throw err;
          }
        },

        async indexDocument(entity: Record<string, unknown>, opts?: TenantContext): Promise<void> {
          const targetIndex = resolveTargetIndex(opts);
          await ensureTenantIndex(targetIndex);
          let doc: Record<string, unknown>;
          try {
            doc = prepareDoc(entity);
          } catch (err) {
            const docId = entity[pkField];
            logger.error(
              `[slingshot-search] Transform error for document id="${String(docId)}" in index '${targetIndex}' — skipping document`,
              { error: err instanceof Error ? err.message : String(err), index: targetIndex },
            );
            return;
          }
          const id = String(entity[pkField]);
          await withProviderProtection(providerKey, () =>
            provider.indexDocument(targetIndex, doc, id),
          );
        },

        async indexDocuments(
          entities: ReadonlyArray<Record<string, unknown>>,
          opts?: TenantContext,
        ): Promise<void> {
          const targetIndex = resolveTargetIndex(opts);
          await ensureTenantIndex(targetIndex);
          const docs: Array<Record<string, unknown>> = [];
          for (const e of entities) {
            try {
              docs.push(prepareDoc(e));
            } catch (err) {
              const docId = e[pkField];
              logger.error(
                `[slingshot-search] Transform error for document id="${String(docId)}" in index '${targetIndex}' — skipping document`,
                { error: err instanceof Error ? err.message : String(err), index: targetIndex },
              );
            }
          }
          if (docs.length > 0) {
            await withProviderProtection(providerKey, () =>
              provider.indexDocuments(targetIndex, docs, pkField),
            );
          }
        },

        async removeDocument(id: string | number, opts?: TenantContext): Promise<void> {
          const targetIndex = resolveTargetIndex(opts);
          await withProviderProtection(providerKey, () =>
            provider.deleteDocument(targetIndex, String(id)),
          );
        },
      };
    },

    async federatedSearch(query: FederatedSearchQuery): Promise<FederatedSearchResponse> {
      const start = performance.now();

      // Build per-index queries
      const indexQueries = query.queries.map(entry => {
        // Find entity state by index name (could be entity storage name or index name)
        const state = [...entityStates.values()].find(s => s.indexName === entry.indexName);
        if (!state) {
          throw new Error(
            `[slingshot-search] Unknown index '${entry.indexName}' in federated search`,
          );
        }

        const searchQuery: SearchQuery = {
          q: entry.q ?? query.q,
          filter: entry.filter,
          sort: entry.sort,
          limit: entry.limit ?? query.limit ?? 20,
          highlight: query.highlight,
        };

        return { indexName: entry.indexName, query: searchQuery, weight: entry.weight ?? 1 };
      });

      // Group queries by provider for potential multiSearch optimization
      const providerGroups = new Map<
        SearchProvider,
        Array<{ indexName: string; query: SearchQuery; weight: number }>
      >();
      for (const iq of indexQueries) {
        const state = [...entityStates.values()].find(s => s.indexName === iq.indexName);
        if (!state) continue;
        const group = providerGroups.get(state.provider) ?? [];
        group.push(iq);
        providerGroups.set(state.provider, group);
      }

      // Execute searches
      const allResults: Array<{ indexName: string; response: SearchResponse; weight: number }> = [];

      for (const [provider, group] of providerGroups) {
        const responses = await provider.multiSearch(
          group.map(g => ({ indexName: g.indexName, query: g.query })),
        );
        for (let i = 0; i < group.length; i++) {
          allResults.push({
            indexName: group[i].indexName,
            response: responses[i],
            weight: group[i].weight,
          });
        }
      }

      // Merge results based on strategy
      const mergeStrategy = query.merge ?? 'interleave';
      let mergedHits: FederatedSearchHit[];

      switch (mergeStrategy) {
        case 'concat': {
          mergedHits = allResults.flatMap(({ indexName, response, weight }) =>
            response.hits.map(hit => ({
              ...hit,
              indexName,
              rawScore: hit.score,
              weightedScore: (hit.score ?? 0) * weight,
            })),
          );
          break;
        }

        case 'weighted': {
          mergedHits = allResults.flatMap(({ indexName, response, weight }) =>
            response.hits.map(hit => ({
              ...hit,
              indexName,
              rawScore: hit.score,
              weightedScore: (hit.score ?? 0) * weight,
            })),
          );
          mergedHits.sort((a, b) => (b.weightedScore ?? 0) - (a.weightedScore ?? 0));
          break;
        }

        case 'interleave':
        default: {
          // Round-robin interleave by score
          const queues = allResults.map(({ indexName, response, weight }) =>
            response.hits.map(hit => ({
              ...hit,
              indexName,
              rawScore: hit.score,
              weightedScore: (hit.score ?? 0) * weight,
            })),
          );

          mergedHits = [];
          const pointers = queues.map(() => 0);
          const totalLimit = query.limit ?? 20;

          while (mergedHits.length < totalLimit) {
            let bestIdx = -1;
            let bestScore = -Infinity;

            for (let i = 0; i < queues.length; i++) {
              if (pointers[i] >= queues[i].length) continue;
              const score = queues[i][pointers[i]].weightedScore;
              if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
              }
            }

            if (bestIdx === -1) break;
            mergedHits.push(queues[bestIdx][pointers[bestIdx]]);
            pointers[bestIdx]++;
          }
          break;
        }
      }

      // Apply global limit
      if (query.limit) {
        mergedHits = mergedHits.slice(0, query.limit);
      }

      // Build index-level stats
      const indexes: Record<
        string,
        {
          totalHits: number;
          processingTimeMs: number;
          facetDistribution?: Record<string, Record<string, number>>;
        }
      > = {};

      for (const { indexName, response } of allResults) {
        indexes[indexName] = {
          totalHits: response.totalHits,
          processingTimeMs: response.processingTimeMs,
          facetDistribution: response.facetDistribution,
        };
      }

      return {
        hits: mergedHits,
        totalHits: allResults.reduce((sum, r) => sum + r.response.totalHits, 0),
        processingTimeMs: Math.round(performance.now() - start),
        indexes,
      };
    },

    async reindex(entityStorageName, source) {
      const key = resolveEntityKey(entityStorageName);
      const state = key ? entityStates.get(key) : undefined;
      if (!state) {
        throw new Error(`[slingshot-search] No search config for entity '${entityStorageName}'`);
      }

      const { indexName, provider, pkField, transformName, geoConfig } = state;
      const transform = transformRegistry.resolve(transformName);
      const start = performance.now();
      let documentsIndexed = 0;
      const batchSize = 500;
      let batch: Array<Record<string, unknown>> = [];

      function prepareDoc(entity: Record<string, unknown>): Record<string, unknown> {
        let doc = transform(entity);
        if (geoConfig) {
          doc = applyGeoTransform(doc, geoConfig);
        }
        return doc;
      }

      // Clear existing index data — wait for completion if provider is async
      const clearTask = await provider.clearIndex(indexName);
      if (clearTask?.taskId && provider.waitForTask) {
        await provider.waitForTask(clearTask.taskId);
      }

      for await (const raw of source) {
        let doc: Record<string, unknown>;
        try {
          doc = prepareDoc(raw);
        } catch (err) {
          const docId = raw[pkField];
          logger.error(
            `[slingshot-search] Transform error for document id="${String(docId)}" in entity '${entityStorageName}' — skipping document`,
            { error: err instanceof Error ? err.message : String(err) },
          );
          continue;
        }
        batch.push(doc);

        if (batch.length >= batchSize) {
          const task = await provider.indexDocuments(indexName, batch, pkField);
          if (task?.taskId && provider.waitForTask) {
            await provider.waitForTask(task.taskId);
          }
          documentsIndexed += batch.length;
          batch = [];
        }
      }

      // Flush remaining
      if (batch.length > 0) {
        const task = await provider.indexDocuments(indexName, batch, pkField);
        if (task?.taskId && provider.waitForTask) {
          await provider.waitForTask(task.taskId);
        }
        documentsIndexed += batch.length;
      }

      const durationMs = Math.round(performance.now() - start);
      return { documentsIndexed, durationMs };
    },

    async healthCheck() {
      const results: Record<string, SearchHealthResult> = {};

      for (const [name, provider] of providers) {
        try {
          const providerResult = await provider.healthCheck();
          // Attach manager-level circuit breaker state if available
          const breaker = providerBreakers.get(name);
          results[name] = breaker
            ? { ...providerResult, managerBreaker: breaker.getHealth() }
            : providerResult;
        } catch (err) {
          const breaker = providerBreakers.get(name);
          results[name] = {
            healthy: false,
            provider: name,
            latencyMs: 0,
            error: err instanceof Error ? err.message : String(err),
            ...(breaker ? { managerBreaker: breaker.getHealth() } : {}),
          };
        }
      }

      // Include breakers for providers that are registered but not yet connected
      for (const [key, breaker] of providerBreakers) {
        if (!results[key]) {
          results[key] = {
            healthy: false,
            provider: key,
            latencyMs: 0,
            error: 'Provider not connected',
            managerBreaker: breaker.getHealth(),
          };
        }
      }

      return results;
    },

    getIndexName(entityStorageName) {
      const key = resolveEntityKey(entityStorageName);
      return key ? entityStates.get(key)?.indexName : undefined;
    },

    getIndexSettings(entityStorageName) {
      const key = resolveEntityKey(entityStorageName);
      return key ? entityStates.get(key)?.settings : undefined;
    },

    getProvider(entityStorageName) {
      const key = resolveEntityKey(entityStorageName);
      return key ? entityStates.get(key)?.provider : undefined;
    },

    getProviderByKey(providerKey) {
      return providers.get(providerKey);
    },

    getEntityTenantConfig(entityStorageName) {
      const key = resolveEntityKey(entityStorageName);
      const state = key ? entityStates.get(key) : undefined;
      if (!state || !state.tenantIsolation || !state.tenantField) return undefined;
      return { tenantIsolation: state.tenantIsolation, tenantField: state.tenantField };
    },

    resolveStorageName(nameOrStorageName) {
      return resolveEntityKey(nameOrStorageName) ?? null;
    },

    async teardown() {
      for (const [, provider] of providers) {
        await provider.teardown();
      }
      providers.clear();
      entityStates.clear();
      entityNameToStorageName.clear();
      pendingEntityInitializations.clear();
      createdTenantIndexes.clear();
      providerBreakers.clear();
      providersConnected = false;
      initialized = false;
    },

    get metrics(): SearchManagerMetrics {
      return { tenantIndexEvictions };
    },
  };

  return manager;
}
