/**
 * Full search provider interface and provider-specific configurations.
 *
 * `SearchProvider` extends the minimal `SearchProviderContract` from core
 * with lifecycle, index management, search, suggest, and task monitoring.
 */
import type { SearchProviderContract } from '@lastshotlabs/slingshot-core';
import type { SearchQuery, SuggestQuery } from './query';
import type { SearchResponse, SuggestResponse } from './response';

// ============================================================================
// Index settings
// ============================================================================

/**
 * Index configuration settings passed to `SearchProvider.createOrUpdateIndex()`.
 *
 * Describes which fields are searchable, filterable, sortable, and facetable,
 * plus optional ranking, typo tolerance, synonyms, and language configuration.
 * Provider implementations map these settings to provider-specific index configs.
 */
export interface SearchIndexSettings {
  /** Fields the full-text search query is applied to. */
  readonly searchableFields: ReadonlyArray<string>;
  /** Fields that can be used in `SearchFilter` conditions. */
  readonly filterableFields: ReadonlyArray<string>;
  /** Fields that can be used in `SearchSort` clauses. */
  readonly sortableFields: ReadonlyArray<string>;
  /** Fields for which facet counts are computed in `SearchResponse.facetDistribution`. */
  readonly facetableFields: ReadonlyArray<string>;
  /** Fields to include in search results. When omitted, all fields are included. */
  readonly displayedFields?: ReadonlyArray<string>;
  /** Fields to strip from search results. */
  readonly excludedFields?: ReadonlyArray<string>;
  /** The document field used as the unique identifier. Default: `'id'`. */
  readonly primaryKey?: string;
  /** Field for deduplication — only the best-scoring document per value is returned. */
  readonly distinctField?: string;
  /** Custom relevance ranking rule order. */
  readonly ranking?: SearchRankingConfig;
  /** Typo tolerance settings. */
  readonly typoTolerance?: TypoToleranceConfig;
  /** Words to ignore during indexing and search. */
  readonly stopWords?: ReadonlyArray<string>;
  /** Synonym definitions for query expansion. */
  readonly synonyms?: ReadonlyArray<SynonymDefinition>;
  /** Language and dictionary configuration. */
  readonly language?: LanguageConfig;
  /** Characters treated as word separators. */
  readonly separatorTokens?: ReadonlyArray<string>;
  /** Characters that should NOT be treated as word separators. */
  readonly nonSeparatorTokens?: ReadonlyArray<string>;
  /** Pagination limits. */
  readonly pagination?: { readonly maxTotalHits?: number };
  /** Proximity precision level. `'byAttribute'` is faster; `'byWord'` is more accurate. */
  readonly proximityPrecision?: 'byWord' | 'byAttribute';
}

/**
 * Custom relevance ranking configuration.
 *
 * Defines the ordered list of ranking criteria applied during search scoring.
 */
export interface SearchRankingConfig {
  /** Ordered ranking criteria. Later entries are tie-breakers. */
  readonly rules: ReadonlyArray<SearchRankingRule>;
}

/**
 * A single ranking criterion.
 *
 * Built-in rules: `'words'`, `'typo'`, `'proximity'`, `'attribute'`, `'sort'`,
 * `'exactness'`. Custom rules specify a field and direction.
 */
export type SearchRankingRule =
  | 'words'
  | 'typo'
  | 'proximity'
  | 'attribute'
  | 'sort'
  | 'exactness'
  | { readonly field: string; readonly direction: 'asc' | 'desc' };

/**
 * Typo tolerance configuration for fuzzy matching.
 */
export interface TypoToleranceConfig {
  /** Whether typo tolerance is enabled. Default: `true`. */
  readonly enabled?: boolean;
  /** Minimum word length to allow one typo. Default: 5. */
  readonly minWordSizeForOneTypo?: number;
  /** Minimum word length to allow two typos. Default: 9. */
  readonly minWordSizeForTwoTypos?: number;
  /** Fields on which typo tolerance is disabled. */
  readonly disableOnFields?: ReadonlyArray<string>;
  /** Disable typo tolerance for queries that look like numbers. Default: `false`. */
  readonly disableOnNumbers?: boolean;
}

/**
 * A synonym group definition for query expansion.
 */
export interface SynonymDefinition {
  /** Words treated as synonyms. All are expanded unless `oneWay` is true. */
  readonly words: ReadonlyArray<string>;
  /** When `true`, only the first word expands to the others (one-directional). */
  readonly oneWay?: boolean;
}

/**
 * Language and dictionary configuration for tokenization.
 */
export interface LanguageConfig {
  /** Primary language code (e.g. `'en'`). */
  readonly primary?: string;
  /** Additional language codes for multi-language content. */
  readonly additional?: ReadonlyArray<string>;
  /** Custom dictionary words to recognize as tokens. */
  readonly dictionary?: ReadonlyArray<string>;
}

// ============================================================================
// Async task tracking
// ============================================================================

/**
 * Represents an asynchronous indexing task (Meilisearch, Algolia).
 *
 * Returned by mutating operations. Use `SearchProvider.waitForTask()` to
 * poll until the task completes.
 */
export interface SearchIndexTask {
  /** Provider-specific task identifier. */
  readonly taskId: string | number;
  /** Current task status. */
  readonly status: 'enqueued' | 'processing' | 'succeeded' | 'failed';
  /** When the task was enqueued. */
  readonly enqueuedAt: Date;
}

// ============================================================================
// Health check
// ============================================================================

/**
 * Result of `SearchProvider.healthCheck()`.
 */
export interface SearchHealthResult {
  /** Whether the provider is reachable and healthy. */
  readonly healthy: boolean;
  /** Provider name (e.g. `'meilisearch'`). */
  readonly provider: string;
  /** Round-trip latency in milliseconds. */
  readonly latencyMs: number;
  /** Provider version string (when available). */
  readonly version?: string;
  /** Error message when `healthy` is `false`. */
  readonly error?: string;
  /**
   * Provider-level circuit breaker state. Populated when the provider supports
   * an internal breaker (e.g. typesense). Omitted on providers that do not.
   */
  readonly circuitBreaker?: {
    readonly state: 'closed' | 'open' | 'half-open';
    readonly consecutiveFailures: number;
    readonly openedAt?: number;
    readonly nextProbeAt?: number;
  };
}

// ============================================================================
// Full search provider interface
// ============================================================================

/**
 * Full-featured search provider. Extends the minimal `SearchProviderContract`
 * (`indexDocument` + `deleteDocument`) with lifecycle, index management, batch
 * operations, search, suggest, and task monitoring.
 *
 * Each provider implementation (Meilisearch, Typesense, Elasticsearch, Algolia,
 * DB-native) implements this interface. Obtain instances via the factory
 * functions exported from the package (e.g. `createTypesenseProvider()`).
 *
 * @remarks
 * Providers must be registered in `SearchPluginConfig.providers` by name.
 * The search plugin calls `connect()` during `setupPost` and `teardown()`
 * on graceful shutdown.
 *
 * @example
 * ```ts
 * import { createTypesenseProvider } from '@lastshotlabs/slingshot-search';
 *
 * const provider: SearchProvider = createTypesenseProvider({
 *   provider: 'typesense',
 *   url: 'http://localhost:8108',
 *   apiKey: 'xyz',
 * });
 * await provider.connect();
 * await provider.createOrUpdateIndex('my_index', settings);
 * ```
 */
export interface SearchProvider extends SearchProviderContract {
  /** Provider identifier (e.g. `'meilisearch'`, `'typesense'`). */
  readonly name: string;

  // --- Lifecycle ---

  /** Open the connection to the provider. Called once during plugin `setupPost`. */
  connect(): Promise<void>;

  /**
   * Check whether the provider is reachable and return latency and version info.
   *
   * @returns A `SearchHealthResult` with `healthy`, `latencyMs`, and optional `version`.
   */
  healthCheck(): Promise<SearchHealthResult>;

  /** Flush pending operations and close the connection. Called during plugin teardown. */
  teardown(): Promise<void>;

  // --- Index Management ---

  /**
   * Create a new index (collection/alias) or update its settings.
   *
   * @param indexName - Logical index name (prefix applied by the search manager).
   * @param settings - Full index settings including searchable, filterable, and sortable fields.
   * @returns An async task handle for providers with deferred task queues (Meilisearch, Algolia),
   *   or `void` for synchronous providers (Typesense, Elasticsearch).
   */
  createOrUpdateIndex(
    indexName: string,
    settings: SearchIndexSettings,
  ): Promise<SearchIndexTask | undefined>;

  /**
   * Delete an index and all its documents.
   *
   * @param indexName - Name of the index to remove.
   */
  deleteIndex(indexName: string): Promise<void>;

  /**
   * List all indexes known to the provider.
   *
   * @returns Metadata for each index: name, document count, and last-updated timestamp.
   */
  listIndexes(): Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly documentCount: number;
      readonly updatedAt: Date;
    }>
  >;

  /**
   * Retrieve the current settings of an index.
   *
   * @param indexName - Name of the index to inspect.
   * @returns The current `SearchIndexSettings` as reported by the provider.
   */
  getIndexSettings(indexName: string): Promise<SearchIndexSettings>;

  // --- Document Operations (batch) ---

  /**
   * Index (upsert) a batch of documents.
   *
   * @param indexName - Target index name.
   * @param documents - Documents to upsert. Each must contain `primaryKey`.
   * @param primaryKey - The document field used as the unique identifier.
   */
  indexDocuments(
    indexName: string,
    documents: ReadonlyArray<Record<string, unknown>>,
    primaryKey: string,
  ): Promise<SearchIndexTask | undefined>;

  /**
   * Delete a batch of documents by their IDs.
   *
   * @param indexName - Index from which to delete.
   * @param documentIds - IDs of documents to remove.
   */
  deleteDocuments(
    indexName: string,
    documentIds: ReadonlyArray<string>,
  ): Promise<SearchIndexTask | undefined>;

  /**
   * Remove all documents from an index without deleting the index itself.
   *
   * @param indexName - Index to clear.
   */
  clearIndex(indexName: string): Promise<SearchIndexTask | undefined>;

  // --- Search ---

  /**
   * Execute a full-text search query against an index.
   *
   * @param indexName - Index to search.
   * @param query - Search parameters including `q`, filters, sort, facets, and pagination.
   * @returns A `SearchResponse` with matched hits, facet counts, and pagination metadata.
   */
  search(indexName: string, query: SearchQuery): Promise<SearchResponse>;

  /**
   * Execute multiple search queries in a single round-trip.
   *
   * @param queries - Array of `{ indexName, query }` pairs.
   * @returns One `SearchResponse` per query in the same order.
   */
  multiSearch(
    queries: ReadonlyArray<{ readonly indexName: string; readonly query: SearchQuery }>,
  ): Promise<ReadonlyArray<SearchResponse>>;

  // --- Suggest ---

  /**
   * Execute an autocomplete/suggestion query.
   *
   * @param indexName - Index to query for suggestions.
   * @param query - Suggestion parameters including prefix `q`, fields, and limit.
   * @returns A `SuggestResponse` with ordered candidate strings.
   */
  suggest(indexName: string, query: SuggestQuery): Promise<SuggestResponse>;

  // --- Task Monitoring (async providers only) ---

  /**
   * Retrieve the current status of an async task (Meilisearch, Algolia only).
   *
   * @param taskId - Provider-issued task ID returned by a mutating operation.
   */
  getTask?(taskId: string | number): Promise<SearchIndexTask>;

  /**
   * Poll until an async task completes or times out (Meilisearch, Algolia only).
   *
   * @param taskId - Provider-issued task ID to wait for.
   * @param timeoutMs - Maximum wait time in milliseconds. Default: provider-specific.
   */
  waitForTask?(taskId: string | number, timeoutMs?: number): Promise<SearchIndexTask>;
}

// ============================================================================
// Provider configurations
// ============================================================================

/**
 * Base configuration shared by all search provider configs.
 *
 * Extended by each provider-specific config with required credentials.
 */
export interface SearchProviderBaseConfig {
  /** Provider type discriminant. */
  readonly provider: string;
  /** Provider base URL (where applicable). */
  readonly url?: string;
  /** API key for authentication. */
  readonly apiKey?: string;
  /** Request timeout in milliseconds. Default: 5000. */
  readonly timeoutMs?: number;
  /** Maximum retries for transient HTTP failures. Default: 3. */
  readonly retries?: number;
  /** Delay between retry attempts in milliseconds. Default: 200. */
  readonly retryDelayMs?: number;
}

/**
 * Configuration for the Meilisearch provider.
 *
 * @example
 * ```ts
 * const config: MeilisearchProviderConfig = {
 *   provider: 'meilisearch',
 *   url: 'http://localhost:7700',
 *   apiKey: 'myMasterKey',
 * };
 * ```
 */
export interface MeilisearchProviderConfig extends SearchProviderBaseConfig {
  readonly provider: 'meilisearch';
  /** Meilisearch base URL. */
  readonly url: string;
  /** API key (search or admin). */
  readonly apiKey: string;
  /** Master key (used when managing API keys). */
  readonly masterKey?: string;
}

/**
 * Configuration for the Typesense provider.
 *
 * @example
 * ```ts
 * const config: TypesenseProviderConfig = {
 *   provider: 'typesense',
 *   url: 'http://localhost:8108',
 *   apiKey: 'xyz',
 * };
 * ```
 */
export interface TypesenseProviderConfig extends SearchProviderBaseConfig {
  readonly provider: 'typesense';
  /** Typesense node base URL. */
  readonly url: string;
  /** API key. */
  readonly apiKey: string;
  /** Additional Typesense cluster nodes for load balancing. */
  readonly nodes?: ReadonlyArray<{
    readonly host: string;
    readonly port: number;
    readonly protocol: 'http' | 'https';
  }>;
  /** Nearest node for latency optimization. */
  readonly nearestNode?: {
    readonly host: string;
    readonly port: number;
    readonly protocol: 'http' | 'https';
  };
  /**
   * Consecutive request failures (after retries) at which the circuit
   * breaker opens and starts failing fast. Default: `5`.
   */
  readonly circuitBreakerThreshold?: number;
  /**
   * How long the circuit breaker stays open before letting a single probe
   * through (half-open). Default: `30000` (30s).
   */
  readonly circuitBreakerCooldownMs?: number;
  /**
   * Clock source for breaker cooldown calculations. Default: `Date.now`.
   * Override in tests to drive the breaker deterministically.
   */
  readonly now?: () => number;
}

/**
 * Configuration for the Elasticsearch/OpenSearch provider.
 *
 * @example
 * ```ts
 * const config: ElasticsearchProviderConfig = {
 *   provider: 'elasticsearch',
 *   url: 'http://localhost:9200',
 *   auth: { username: 'elastic', password: 'changeme' },
 * };
 * ```
 */
export interface ElasticsearchProviderConfig extends SearchProviderBaseConfig {
  readonly provider: 'elasticsearch';
  /** Elasticsearch cluster URL. */
  readonly url: string;
  /** HTTP authentication (basic or bearer token). */
  readonly auth?:
    | { readonly username: string; readonly password: string }
    | { readonly bearer: string };
  /** Elastic Cloud deployment ID (alternative to `url`). */
  readonly cloudId?: string;
  /** TLS certificate fingerprint for self-signed certs. */
  readonly caFingerprint?: string;
}

/**
 * Configuration for the Algolia provider.
 *
 * @example
 * ```ts
 * const config: AlgoliaProviderConfig = {
 *   provider: 'algolia',
 *   applicationId: 'YourAppId',
 *   apiKey: 'yourSearchOnlyApiKey',
 *   adminApiKey: 'yourAdminApiKey',
 * };
 * ```
 */
export interface AlgoliaProviderConfig extends SearchProviderBaseConfig {
  readonly provider: 'algolia';
  /** Algolia application ID. */
  readonly applicationId: string;
  /** Search-only API key (safe to expose in client-side code). */
  readonly apiKey: string;
  /** Admin API key for index management operations. */
  readonly adminApiKey?: string;
}

/**
 * Configuration for the DB-native provider.
 *
 * Uses the app's existing database (LIKE/ILIKE/full-text queries). No external
 * service required. Recommended for development and low-traffic apps.
 */
export interface DbNativeProviderConfig extends SearchProviderBaseConfig {
  readonly provider: 'db-native';
}

/**
 * Discriminated union of all supported search provider configs.
 *
 * Used as the value type in `SearchPluginConfig.providers`.
 */
export type AnySearchProviderConfig =
  | MeilisearchProviderConfig
  | TypesenseProviderConfig
  | ElasticsearchProviderConfig
  | AlgoliaProviderConfig
  | DbNativeProviderConfig;
