/**
 * Search plugin runtime contract.
 *
 * Defines the shape stored in `pluginState` by `slingshot-search` and consumed
 * by framework-internal code (`createContextStoreInfra`) for write-through
 * sync and late entity initialization.
 *
 * Lives in `slingshot-core` because both sides (framework and search plugin)
 * depend on core — same rationale as `SearchProviderContract`.
 */
import type { ResolvedEntityConfig } from './entityConfig';
import type { PluginStateCarrier, PluginStateMap } from './pluginState';
import { getPluginStateOrNull } from './pluginState';

/** Stable plugin-state key published by `slingshot-search`. */
export const SEARCH_PLUGIN_STATE_KEY = 'slingshot-search' as const;

/**
 * Per-entity search client interface resolved by the search plugin at runtime.
 *
 * Wraps a provider-specific index and provides entity-level document operations.
 * Retrieved via `SearchPluginRuntime.getSearchClient(entityStorageName)`.
 */
export interface SearchClientLike {
  /**
   * Index (upsert) a document for the entity this client is bound to.
   * @param entity - The entity record to index (key-value map).
   *
   * @remarks
   * Consistency semantics are provider-specific:
   * - Meilisearch: eventual — the document enters a task queue and is searchable after
   *   the task completes (typically within milliseconds but not atomically with the call).
   * - Typesense: near-immediate — documents are usually searchable within ~1 second.
   *
   * Do not assert searchability in the same request that triggers indexing unless you
   * wait for the provider's task queue to drain (see provider-specific task APIs).
   */
  indexDocument(entity: Record<string, unknown>): Promise<void>;
  /**
   * Remove a document by its entity primary key.
   * @param id - The entity's primary key value.
   *
   * @remarks
   * This is a no-op (not an error) if the document ID does not exist in the index.
   * Providers silently ignore deletion of non-existent documents. Like `indexDocument`,
   * deletion is eventual — the document may still appear in search results for a brief
   * window after this call returns.
   */
  removeDocument(id: string | number): Promise<void>;
  /**
   * Run a full-text search query.
   * Optional — only available when the provider supports search (not just indexing).
   */
  search?(query: SearchQueryLike): Promise<SearchResponseLike>;
}

/**
 * Minimal search query shape used by `op.search` delegation to a search provider.
 * Provider-specific query features (facets, geo, grouping) are passed via `filter` and `sort`.
 */
export interface SearchQueryLike {
  /** The full-text search string. */
  readonly q: string;
  /**
   * Provider-specific filter expression.
   *
   * @remarks
   * The shape and syntax are entirely provider-defined — there is no cross-provider
   * abstraction here. For Meilisearch this is a filter string (e.g.
   * `'status = "published"'`); for Typesense it is a `filter_by` string
   * (e.g. `'status:=published'`). The framework passes this value through opaquely.
   */
  readonly filter?: unknown;
  /** Maximum number of hits to return. */
  readonly limit?: number;
  /** Number of hits to skip (offset pagination). */
  readonly offset?: number;
  /**
   * Provider-specific sort expression.
   *
   * @remarks
   * Like `filter`, the shape is provider-defined. For Meilisearch this is an array of
   * sort strings (e.g. `['createdAt:desc']`); for Typesense it is a `sort_by` string
   * (e.g. `'createdAt:desc'`). The framework passes this value through opaquely.
   */
  readonly sort?: unknown;
}

/**
 * Minimal search response shape returned by `SearchClientLike.search()`.
 * Provider adapters normalise their native response to this shape.
 */
export interface SearchResponseLike {
  /**
   * The matching documents for the query.
   *
   * @remarks
   * Ordering is determined by the provider and the query:
   * - When a non-empty `q` is provided, hits are ordered by relevance score (provider-specific
   *   BM25 or vector ranking), highest relevance first.
   * - When `q` is an empty string `''` and `sort` is specified, hits follow the sort order.
   * - When neither `q` nor `sort` are specified, the order is provider-defined and should
   *   not be relied upon — use explicit `sort` for deterministic ordering.
   */
  readonly hits: ReadonlyArray<{ readonly document: Record<string, unknown> }>;
  /** Total number of matching documents (before limit/offset). */
  readonly totalHits: number;
}

/**
 * Runtime interface for the `slingshot-search` plugin, stored in `ctx.pluginState`.
 *
 * Consumed by the framework's `createContextStoreInfra` to:
 * - Register entity indexes at startup via `ensureConfigEntity`
 * - Obtain per-entity search clients for `op.search` and write-through sync via `getSearchClient`
 */
export interface SearchPluginRuntime {
  /**
   * Ensure an index exists for the given entity config, creating it if necessary.
   * Called during server startup for every entity with a `search` config.
   * @param config - The resolved entity configuration.
   *
   * @remarks
   * This method is idempotent — calling it multiple times with the same `config` is safe.
   * If the index already exists with compatible settings it is left unchanged; only missing
   * indexes or indexes with stale settings are updated. This makes it safe to call on
   * every startup without risk of data loss or reindexing.
   */
  ensureConfigEntity(config: ResolvedEntityConfig): Promise<void>;
  /**
   * Retrieve the search client bound to a specific entity's storage name.
   * @param entityStorageName - The entity's `_storageName` (e.g. `'chat_messages'`).
   * @returns The `SearchClientLike` for this entity, or `null` if not registered.
   */
  getSearchClient(entityStorageName: string): SearchClientLike | null;
}

/**
 * Retrieve the search plugin runtime from plugin state.
 */
export function getSearchPluginRuntime(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): SearchPluginRuntime {
  const runtime = getSearchPluginRuntimeOrNull(input);
  if (!runtime) {
    throw new Error('[slingshot-search] search runtime is not available in pluginState');
  }
  return runtime;
}

/**
 * Retrieve the search plugin runtime from plugin state when search is active.
 */
export function getSearchPluginRuntimeOrNull(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): SearchPluginRuntime | null {
  const pluginState = getPluginStateOrNull(input);
  const runtime = pluginState?.get(SEARCH_PLUGIN_STATE_KEY);
  if (typeof runtime !== 'object' || runtime === null) {
    return null;
  }

  const ensureConfigEntity = Reflect.get(runtime, 'ensureConfigEntity');
  const getSearchClient = Reflect.get(runtime, 'getSearchClient');
  if (typeof ensureConfigEntity !== 'function' || typeof getSearchClient !== 'function') {
    return null;
  }

  return runtime as SearchPluginRuntime;
}
