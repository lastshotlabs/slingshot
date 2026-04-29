// --- Events (module augmentation — imported for side effects) ---
import './events';

// --- Plugin ---
/** Build the search plugin that discovers searchable entities, mounts routes, and wires indexing. */
export { createSearchPlugin } from './plugin';

// --- Event-sync manager (used by package tests and operators wiring custom DLQ stores) ---
/**
 * Dead-letter queue contracts and event-sync manager health/configuration types.
 */
export type {
  DlqStore,
  EventSyncHealth,
  EventSyncManager,
  EventSyncManagerConfig,
  FlushDeadLetterEntry,
} from './eventSync';
/**
 * Create the event-sync manager used to index entity events and flush dead letters.
 */
export { createEventSyncManager } from './eventSync';

// --- Provider factories ---
/** First-party provider factories for external and hosted search backends. */
export { createTypesenseProvider, ProviderUnavailableError } from './providers/typesense';
/**
 * Circuit-breaker health payload exposed by hosted search providers.
 */
export type { CircuitBreakerHealth } from './providers/typesense';
/**
 * Create an Elasticsearch-backed search provider.
 */
export { createElasticsearchProvider } from './providers/elasticsearch';
/**
 * Create an Algolia-backed search provider.
 */
export { createAlgoliaProvider } from './providers/algolia';

// --- Route constants ---
/** Canonical route ids for the HTTP surface mounted by `createSearchPlugin()`. */
export { SEARCH_ROUTES } from './routes/index';
/**
 * Route identifiers mounted by the search plugin.
 */
export type { SearchRoute } from './routes/index';

// --- Rate limiting ---
/**
 * Create in-memory rate-limit storage and middleware for search routes.
 */
export { createInMemoryRateLimitStore, createRateLimitMiddleware } from './routes/rateLimiter';
/**
 * Rate-limit options and store contract for search routes.
 */
export type { RateLimitOptions, RateLimitStore } from './routes/rateLimiter';

// --- Config types ---
/** Plugin config and admin-gating types for configuring the search runtime. */
export type { SearchPluginConfig, SearchAdminGate } from './types/config';

// --- Provider types ---
/** Provider contracts and provider-specific config types used by the search runtime. */
export type {
  SearchProvider,
  SearchIndexSettings,
  SearchRankingConfig,
  SearchRankingRule,
  TypoToleranceConfig,
  SynonymDefinition,
  LanguageConfig,
  SearchIndexTask,
  SearchHealthResult,
  SearchProviderBaseConfig,
  MeilisearchProviderConfig,
  TypesenseProviderConfig,
  ElasticsearchProviderConfig,
  AlgoliaProviderConfig,
  DbNativeProviderConfig,
  AnySearchProviderConfig,
} from './types/provider';

// --- Query types ---
/** Query DSL types for search, suggest, filtering, faceting, and federated search requests. */
export type {
  SearchQuery,
  SuggestQuery,
  SearchFilter,
  SearchFilterCondition,
  SearchFilterAnd,
  SearchFilterOr,
  SearchFilterNot,
  SearchFilterOp,
  SearchFilterValue,
  SearchFilterGeoRadius,
  SearchFilterGeoBoundingBox,
  SearchSort,
  HighlightConfig,
  SnippetConfig,
  FacetOptions,
  FederatedSearchQuery,
  FederatedSearchEntry,
} from './types/query';

// --- Response types ---
/** Response payload types returned by search, suggest, and federated search endpoints. */
export type {
  SearchResponse,
  SearchHit,
  FacetStats,
  SuggestResponse,
  FederatedSearchResponse,
  FederatedSearchHit,
} from './types/response';
