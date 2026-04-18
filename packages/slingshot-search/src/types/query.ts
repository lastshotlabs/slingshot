/**
 * Search query types — the full query API for enterprise search.
 *
 * Supports full-text search, faceted filtering, geo queries, highlighting,
 * snippets, federated (multi-index) search, and autocomplete suggestions.
 */

// ============================================================================
// Search filters
// ============================================================================

/**
 * Recursive search filter expression.
 *
 * Compose conditions with `$and`, `$or`, `$not`, geo-radius, and geo-bounding-box
 * operators. All leaves are `SearchFilterCondition` nodes.
 *
 * @example
 * ```ts
 * const filter: SearchFilter = {
 *   $and: [
 *     { field: 'status', op: '=', value: 'active' },
 *     { field: 'price', op: '<=', value: 100 },
 *   ],
 * };
 * ```
 */
export type SearchFilter =
  | SearchFilterCondition
  | SearchFilterAnd
  | SearchFilterOr
  | SearchFilterNot
  | SearchFilterGeoRadius
  | SearchFilterGeoBoundingBox;

/**
 * Logical AND combining multiple filter branches.
 * All branches must match for a document to be included.
 */
export interface SearchFilterAnd {
  readonly $and: ReadonlyArray<SearchFilter>;
}

/**
 * Logical OR combining multiple filter branches.
 * At least one branch must match for a document to be included.
 */
export interface SearchFilterOr {
  readonly $or: ReadonlyArray<SearchFilter>;
}

/**
 * Logical NOT inverting a single filter branch.
 * Documents matching the inner filter are excluded.
 */
export interface SearchFilterNot {
  readonly $not: SearchFilter;
}

/**
 * A single field-level filter condition.
 *
 * Applies `op` between `field` and `value`. For `BETWEEN`, `value` must be
 * a `[min, max]` tuple. For `IN` / `NOT_IN`, `value` must be an array.
 */
export interface SearchFilterCondition {
  /** Document field name. Must be in the index's `filterableFields`. */
  readonly field: string;
  /** Comparison operator. */
  readonly op: SearchFilterOp;
  /** Value to compare against. */
  readonly value: SearchFilterValue;
}

/**
 * Comparison operator for `SearchFilterCondition`.
 *
 * - `'='` / `'!='` — exact match / negation
 * - `'>'` / `'>='` / `'<'` / `'<='` — range comparisons
 * - `'IN'` / `'NOT_IN'` — set membership (value must be an array)
 * - `'EXISTS'` / `'NOT_EXISTS'` — field presence check
 * - `'CONTAINS'` — substring match
 * - `'BETWEEN'` — range (value must be `[min, max]` tuple)
 * - `'STARTS_WITH'` — prefix match
 * - `'IS_EMPTY'` / `'IS_NOT_EMPTY'` — null/empty check
 */
export type SearchFilterOp =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'IN'
  | 'NOT_IN'
  | 'EXISTS'
  | 'NOT_EXISTS'
  | 'CONTAINS'
  | 'BETWEEN'
  | 'STARTS_WITH'
  | 'IS_EMPTY'
  | 'IS_NOT_EMPTY';

/**
 * Value type accepted in `SearchFilterCondition.value`.
 *
 * `readonly [number, number]` is used with the `BETWEEN` operator.
 */
export type SearchFilterValue =
  | string
  | number
  | boolean
  | null
  | Date
  | ReadonlyArray<string | number | boolean>
  | readonly [number, number]; // BETWEEN

/**
 * Geo-radius filter — matches documents within a circular area.
 *
 * The document must have a geo-coordinate field (configured as filterable in
 * the index settings) named `_geo` or a provider-specific equivalent.
 */
export interface SearchFilterGeoRadius {
  readonly $geoRadius: {
    /** Center latitude. */
    readonly lat: number;
    /** Center longitude. */
    readonly lng: number;
    /** Radius in meters. */
    readonly radiusMeters: number;
  };
}

/**
 * Geo bounding box filter — matches documents within a rectangular area.
 */
export interface SearchFilterGeoBoundingBox {
  readonly $geoBoundingBox: {
    /** Top-left corner of the bounding box. */
    readonly topLeft: { readonly lat: number; readonly lng: number };
    /** Bottom-right corner of the bounding box. */
    readonly bottomRight: { readonly lat: number; readonly lng: number };
  };
}

// ============================================================================
// Sort
// ============================================================================

/**
 * Sort criterion for `SearchQuery.sort`.
 *
 * Either sort by a named field (ascending/descending) or by geo-distance from
 * a center point (ascending = nearest first).
 */
export type SearchSort =
  | { readonly field: string; readonly direction: 'asc' | 'desc' }
  | {
      readonly geoPoint: { readonly lat: number; readonly lng: number };
      readonly direction: 'asc' | 'desc';
    };

// ============================================================================
// Highlighting & snippets
// ============================================================================

/**
 * Configuration for in-result term highlighting.
 *
 * When present on a `SearchQuery`, the provider wraps matched query terms in
 * `preTag`/`postTag` HTML tags in the `highlights` map on each `SearchHit`.
 */
export interface HighlightConfig {
  /** Fields to highlight. Default: all searchable fields. */
  readonly fields?: ReadonlyArray<string>;
  /** Tag to insert before highlighted term. Default `'<mark>'`. */
  readonly preTag?: string;
  /** Tag to insert after highlighted term. Default `'</mark>'`. */
  readonly postTag?: string;
}

/**
 * Configuration for extracting contextual text snippets around matching terms.
 *
 * When present on a `SearchQuery`, the provider returns short passages from
 * each field in the `snippets` map on each `SearchHit`.
 */
export interface SnippetConfig {
  /** Fields to extract snippets from. */
  readonly fields: ReadonlyArray<string>;
  /** Maximum words to include in the snippet window. Default: 30. */
  readonly maxWords?: number;
  /** Tag to insert before a highlighted term within the snippet. */
  readonly preTag?: string;
  /** Tag to insert after a highlighted term within the snippet. */
  readonly postTag?: string;
}

/**
 * Per-facet display and sorting options for `SearchQuery.facetOptions`.
 *
 * Controls how many values are returned per facet and how they are ordered.
 */
export interface FacetOptions {
  /** Maximum number of distinct facet values to return. Default: 100. */
  readonly maxValues?: number;
  /** Sort facet values by occurrence count (`'count'`) or alphabetically (`'alpha'`). */
  readonly sortBy?: 'count' | 'alpha';
}

// ============================================================================
// Search query
// ============================================================================

/**
 * Full-featured search query passed to `SearchProvider.search()`.
 *
 * Supports full-text search, structured filters, multi-field sorting,
 * faceted aggregation, highlighting, snippets, pagination (page-based or
 * offset-based), and hybrid semantic/keyword search.
 *
 * @example
 * ```ts
 * import type { SearchQuery } from '@lastshotlabs/slingshot-search';
 *
 * const query: SearchQuery = {
 *   q: 'community guidelines',
 *   filter: { field: 'status', op: '=', value: 'published' },
 *   sort: [{ field: 'score', direction: 'desc' }],
 *   page: 1,
 *   hitsPerPage: 20,
 *   facets: ['containerId'],
 *   highlight: { preTag: '<b>', postTag: '</b>' },
 * };
 * ```
 */
export interface SearchQuery {
  /** Full-text search string. Empty string or `'*'` = browse mode (all documents). */
  readonly q: string;

  /** Structured filter applied before scoring. See `SearchFilter` for composition helpers. */
  readonly filter?: SearchFilter;

  /**
   * Sort order applied after filtering. Array of criteria for multi-field sort.
   * Omit to use provider-default relevance ordering.
   */
  readonly sort?: ReadonlyArray<SearchSort>;

  /** Fields for which facet value counts are computed. Must be `facetable` in index settings. */
  readonly facets?: ReadonlyArray<string>;

  /** Per-facet display options (max values returned, sort order). */
  readonly facetOptions?: Record<string, FacetOptions>;

  // --- Pagination (two modes, use one or the other) ---
  /** Page number (1-indexed) for page-based pagination. */
  readonly page?: number;
  /** Number of hits per page. Default: provider-specific (usually 20). */
  readonly hitsPerPage?: number;
  /** Zero-based document offset for offset-based pagination. */
  readonly offset?: number;
  /** Maximum number of hits to return for offset-based pagination. */
  readonly limit?: number;

  // --- Result enrichment ---
  /** Highlight matching terms in results. */
  readonly highlight?: HighlightConfig;
  /** Extract text snippets around matches. */
  readonly snippet?: SnippetConfig;
  /** Project to these fields only in the returned hit documents. */
  readonly fields?: ReadonlyArray<string>;
  /** Strip these fields from the returned hit documents. */
  readonly excludeFields?: ReadonlyArray<string>;

  // --- Matching behavior ---
  /**
   * Word-matching strategy for multi-word queries:
   * - `'all'`: all words must match (strict AND)
   * - `'last'`: all words except the last must match (search-as-you-type)
   * - `'frequency'`: most frequent words are required
   */
  readonly matchingStrategy?: 'all' | 'last' | 'frequency';
  /** Include character-level match positions in `SearchHit.matchesPosition`. */
  readonly showMatchesPosition?: boolean;
  /** Include provider relevance scores in `SearchHit.score`. */
  readonly showRankingScore?: boolean;
  /** Minimum relevance score (0–1). Hits below this threshold are excluded. */
  readonly rankingScoreThreshold?: number;
  /** Override the entity's configured `distinctField` for this query only. */
  readonly distinct?: string;

  /** `AbortSignal` for request cancellation. */
  readonly abortSignal?: AbortSignal;

  /**
   * Hybrid (keyword + semantic vector) search configuration.
   * Provider support varies — only Meilisearch v1.6+ fully implements this.
   */
  readonly hybrid?: {
    /** Weight of semantic results vs. keyword results (0.0–1.0). Default: 0.5. */
    readonly semanticRatio?: number;
    /** Named embedder to use for vector generation. */
    readonly embedder?: string;
  };
}

// ============================================================================
// Suggest / autocomplete
// ============================================================================

/**
 * Autocomplete/suggestion query passed to `SearchProvider.suggest()`.
 *
 * Returns a short ordered list of candidate strings matching the prefix `q`.
 * Typically used for real-time search-as-you-type UIs.
 *
 * @example
 * ```ts
 * import type { SuggestQuery } from '@lastshotlabs/slingshot-search';
 *
 * const query: SuggestQuery = {
 *   q: 'comm',
 *   limit: 8,
 *   fields: ['title'],
 *   highlight: true,
 * };
 * ```
 */
export interface SuggestQuery {
  /** Prefix string to auto-complete. */
  readonly q: string;
  /** Maximum number of suggestions to return. Default: 5. */
  readonly limit?: number;
  /** Fields to match against. Default: all searchable fields. */
  readonly fields?: ReadonlyArray<string>;
  /** Optional filter to scope suggestions (e.g. by status or tenantId). */
  readonly filter?: SearchFilter;
  /** Whether to HTML-highlight matched terms in suggestion strings. */
  readonly highlight?: boolean;
}

// ============================================================================
// Federated (multi-index) search
// ============================================================================

/**
 * Multi-index (federated) search query passed to `SearchProvider`-level
 * federated search endpoints.
 *
 * Queries multiple indexes simultaneously and merges results according to the
 * configured strategy. Useful for searching across entity types (e.g. threads
 * and users) in one request.
 *
 * @example
 * ```ts
 * import type { FederatedSearchQuery } from '@lastshotlabs/slingshot-search';
 *
 * const query: FederatedSearchQuery = {
 *   q: 'TypeScript',
 *   queries: [
 *     { indexName: 'community_threads', weight: 2 },
 *     { indexName: 'community_replies', weight: 1 },
 *   ],
 *   merge: 'weighted',
 *   limit: 30,
 * };
 * ```
 */
export interface FederatedSearchQuery {
  /** Shared query string applied to all indexes that do not override it. */
  readonly q: string;

  /** Per-index query entries, each targeting a specific index with optional overrides. */
  readonly queries: ReadonlyArray<FederatedSearchEntry>;

  /** Maximum total hits to return across all indexes. */
  readonly limit?: number;

  /**
   * Strategy for merging results from multiple indexes:
   * - `'interleave'`: round-robin by relevance score (default)
   * - `'concat'`: concatenate results per-index in declaration order
   * - `'weighted'`: multiply each hit's score by the per-index `weight` before merging
   */
  readonly merge?: 'interleave' | 'concat' | 'weighted';

  /** Highlight configuration applied to all indexes. */
  readonly highlight?: HighlightConfig;
}

/**
 * A single index entry within a `FederatedSearchQuery`.
 *
 * Inherits the shared query string from the parent `FederatedSearchQuery`
 * but can override it, add index-specific filters, and control the relevance
 * weight used in a `'weighted'` merge.
 */
export interface FederatedSearchEntry {
  /** Name of the search index to query. */
  readonly indexName: string;
  /** Override the shared query string for this index only. */
  readonly q?: string;
  /** Index-specific filter applied before scoring. */
  readonly filter?: SearchFilter;
  /** Relevance score multiplier for `'weighted'` merge mode. Default: 1.0. */
  readonly weight?: number;
  /** Maximum hits to return from this index. */
  readonly limit?: number;
  /** Sort criteria for this index (overrides global sort). */
  readonly sort?: ReadonlyArray<SearchSort>;
}
