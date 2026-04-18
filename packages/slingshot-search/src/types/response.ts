/**
 * Search response types — structured results from search, suggest,
 * and federated search operations.
 */

// ============================================================================
// Search response
// ============================================================================

/**
 * The top-level response from a search operation.
 *
 * `@typeParam T` — the document type. Defaults to `Record<string, unknown>`.
 * Consumers can pass a concrete entity type for typed `hit.document` access.
 */
export interface SearchResponse<T = Record<string, unknown>> {
  /** Matched documents with optional score, highlights, and snippets. */
  readonly hits: ReadonlyArray<SearchHit<T>>;
  /** Total matching documents (may be estimated for large result sets). */
  readonly totalHits: number;
  /** Whether `totalHits` is exact or an estimate. */
  readonly totalHitsRelation: 'exact' | 'estimated';
  /** Facet value counts keyed by field name, then value. */
  readonly facetDistribution?: Record<string, Record<string, number>>;
  /** Numeric stats (min, max, avg, sum, count) for facetable numeric fields. */
  readonly facetStats?: Record<string, FacetStats>;
  /** The query string used for this search. */
  readonly query: string;
  /** Provider-side processing time in milliseconds. */
  readonly processingTimeMs: number;

  // Page-based pagination
  /** Current page number (1-indexed). */
  readonly page?: number;
  /** Total number of pages. */
  readonly totalPages?: number;
  /** Number of hits per page. */
  readonly hitsPerPage?: number;

  // Offset-based pagination
  /** Offset used for this page. */
  readonly offset?: number;
  /** Limit used for this page. */
  readonly limit?: number;

  /** Index that produced these results. */
  readonly indexName: string;
  /** Estimated total hits (some providers always use estimation). */
  readonly estimatedTotalHits?: number;
}

/**
 * A single search result hit.
 *
 * `@typeParam T` — the document type. Defaults to `Record<string, unknown>`.
 */
export interface SearchHit<T = Record<string, unknown>> {
  /** The matched document. */
  readonly document: T;
  /** Relevance score (0–1 or provider-specific scale). */
  readonly score?: number;
  /** HTML-highlighted field snippets for each matched field. */
  readonly highlights?: Record<string, string>;
  /** Extracted context snippets for each requested field. */
  readonly snippets?: Record<string, string>;
  /** Character-level match positions keyed by field name. */
  readonly matchesPosition?: Record<
    string,
    ReadonlyArray<{ readonly start: number; readonly length: number }>
  >;
  /** Distance from the geo-sort point in meters (when sorting by geo). */
  readonly geoDistanceMeters?: number;
  /** Provider-specific breakdown of ranking score components. */
  readonly rankingScoreDetails?: Record<string, unknown>;
}

/**
 * Numeric statistics for a facetable numeric field.
 */
export interface FacetStats {
  /** Minimum value across all matching documents. */
  readonly min: number;
  /** Maximum value across all matching documents. */
  readonly max: number;
  /** Average value across all matching documents. */
  readonly avg: number;
  /** Sum of all values across all matching documents. */
  readonly sum: number;
  /** Number of matching documents with this field present. */
  readonly count: number;
}

// ============================================================================
// Suggest response
// ============================================================================

/**
 * Response from a suggest/autocomplete operation.
 *
 * The `suggestions` array is ordered by relevance score descending. Each
 * entry contains the matched text and, when highlight was requested, an
 * HTML-annotated version of that text.
 */
export interface SuggestResponse {
  /** Ordered list of suggestion candidates (most relevant first). */
  readonly suggestions: ReadonlyArray<{
    /** The matched suggestion text (plain, unhighlighted). */
    readonly text: string;
    /** HTML-highlighted version of `text` with matched terms wrapped in tags. */
    readonly highlight?: string;
    /** Provider relevance score (provider-specific scale). */
    readonly score?: number;
    /** Document field that the suggestion text was derived from. */
    readonly field?: string;
  }>;
  /** Provider-side processing time in milliseconds. */
  readonly processingTimeMs: number;
}

// ============================================================================
// Federated search response
// ============================================================================

/**
 * Response from a federated (multi-index) search operation.
 *
 * Combines hits from multiple indexes according to the configured merge strategy.
 * Per-index stats are available in `indexes`.
 */
export interface FederatedSearchResponse {
  /** Merged hits from all queried indexes. */
  readonly hits: ReadonlyArray<FederatedSearchHit>;
  /** Total hits across all indexes. */
  readonly totalHits: number;
  /** Overall processing time including merging in milliseconds. */
  readonly processingTimeMs: number;
  /** Per-index statistics keyed by index name. */
  readonly indexes: Record<
    string,
    {
      readonly totalHits: number;
      readonly processingTimeMs: number;
      readonly facetDistribution?: Record<string, Record<string, number>>;
    }
  >;
}

/**
 * A single hit from a federated search operation.
 *
 * Extends `SearchHit` with the source index name and score details needed
 * for weighted merge strategies.
 */
export interface FederatedSearchHit<T = Record<string, unknown>> extends SearchHit<T> {
  /** The index this hit originated from. */
  readonly indexName: string;
  /** Raw relevance score from the provider before weight application. */
  readonly rawScore?: number;
  /** Score after applying the per-index weight multiplier. */
  readonly weightedScore?: number;
}
