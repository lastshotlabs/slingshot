/**
 * DB-native (in-memory) search provider.
 *
 * Fallback provider when no external search engine is configured. Maintains
 * an in-memory index and provides full-text search via substring matching,
 * filtering, faceting, highlighting, sorting, and pagination.
 *
 * Suitable for dev/test and small deployments. For production use with large
 * datasets, plug in Meilisearch, Typesense, Elasticsearch, or Algolia.
 */
import type { SearchProvider } from '../types/provider';
import type { SearchHealthResult, SearchIndexSettings } from '../types/provider';
import type { SearchQuery, SearchSort, SuggestQuery } from '../types/query';
import type { FacetStats, SearchHit, SearchResponse, SuggestResponse } from '../types/response';
import { computeFacets } from './facets';
import { SearchIndexNotFoundError, SearchPaginationError } from '../errors/searchErrors';
import { evaluateFilter, getNestedValue, haversineDistance } from './filterEval';
import { stringifyDocumentId, stringifySearchValue } from './stringify';
import {
  computeHighlights,
  computeMatchPositions,
  computeTextScore,
  highlightText,
  matchesQuery,
} from './textScoring';

// ============================================================================
// Internal types
// ============================================================================

interface IndexState {
  readonly settings: SearchIndexSettings;
  readonly documents: Map<string, Record<string, unknown>>;
  readonly primaryKey: string;
  readonly createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Sorting
// ============================================================================

/**
 * Sort a mutable array of scored documents in-place according to `sortRules`.
 *
 * When `sortRules` is empty or undefined, documents are sorted by score
 * descending (highest relevance first). Otherwise each rule is applied in
 * order; the next rule is only consulted when the current one produces a tie.
 * After all rules are exhausted, score descending is used as the final
 * tiebreaker.
 *
 * Supported rule shapes:
 * - **Field sort** — sorts by a named field via `getNestedValue`. Supports
 *   `number`, `string` (locale-aware), `Date`, and string-coerced fallback.
 *   `null` / `undefined` values sort to the end regardless of direction.
 * - **Geo sort** (`geoPoint`) — sorts by haversine distance to a reference
 *   coordinate. Requires the document to carry a `_geo: { lat, lng }` field;
 *   documents without it sort to the end (distance treated as `Infinity`).
 *
 * @param docs - The array to sort. Mutated in-place.
 * @param sortRules - Ordered sort rules. When `undefined` or empty, defaults to
 *   score-descending.
 */
function applySorting(
  docs: Array<{ doc: Record<string, unknown>; score: number }>,
  sortRules: ReadonlyArray<SearchSort> | undefined,
): void {
  if (!sortRules || sortRules.length === 0) {
    // Default: sort by score descending
    docs.sort((a, b) => b.score - a.score);
    return;
  }

  docs.sort((a, b) => {
    for (const rule of sortRules) {
      if ('geoPoint' in rule) {
        // Geo sort — requires _geo field
        const aGeo = a.doc._geo as { lat?: number; lng?: number } | undefined;
        const bGeo = b.doc._geo as { lat?: number; lng?: number } | undefined;
        const aDist =
          aGeo && typeof aGeo.lat === 'number' && typeof aGeo.lng === 'number'
            ? haversineDistance(aGeo.lat, aGeo.lng, rule.geoPoint.lat, rule.geoPoint.lng)
            : Infinity;
        const bDist =
          bGeo && typeof bGeo.lat === 'number' && typeof bGeo.lng === 'number'
            ? haversineDistance(bGeo.lat, bGeo.lng, rule.geoPoint.lat, rule.geoPoint.lng)
            : Infinity;
        const diff = rule.direction === 'asc' ? aDist - bDist : bDist - aDist;
        if (diff !== 0) return diff;
        continue;
      }

      const aVal = getNestedValue(a.doc, rule.field);
      const bVal = getNestedValue(b.doc, rule.field);

      const cmp =
        aVal === bVal
          ? 0
          : aVal === undefined || aVal === null
            ? 1
            : bVal === undefined || bVal === null
              ? -1
              : typeof aVal === 'number' && typeof bVal === 'number'
                ? aVal - bVal
                : typeof aVal === 'string' && typeof bVal === 'string'
                  ? aVal.localeCompare(bVal)
                  : aVal instanceof Date && bVal instanceof Date
                    ? aVal.getTime() - bVal.getTime()
                    : stringifySearchValue(aVal).localeCompare(stringifySearchValue(bVal));

      if (cmp !== 0) {
        return rule.direction === 'asc' ? cmp : -cmp;
      }
    }
    // Fall back to score
    return b.score - a.score;
  });
}

// ============================================================================
// Field projection
// ============================================================================

/**
 * Return a shallow projection of `doc` that includes or excludes specific fields.
 *
 * Priority order:
 * 1. If `includeFields` is non-empty, only those fields are included (an
 *    allow-list). Values are read via `getNestedValue`; absent fields are
 *    silently omitted.
 * 2. Otherwise if `excludeFields` is non-empty, all top-level keys except the
 *    excluded ones are included (a block-list). Only top-level keys are blocked;
 *    nested paths are not supported in the exclude mode.
 * 3. If both are absent/empty, a shallow copy of the entire document is
 *    returned.
 *
 * @param doc - The source document.
 * @param includeFields - Optional allow-list of dot-notation field paths.
 * @param excludeFields - Optional block-list of top-level field names.
 * @returns A new object containing the projected fields.
 *
 * @example
 * ```ts
 * const doc = { id: '1', title: 'Hello', secret: 'x' };
 * projectFields(doc, ['id', 'title']);          // { id: '1', title: 'Hello' }
 * projectFields(doc, undefined, ['secret']);     // { id: '1', title: 'Hello' }
 * projectFields(doc);                           // { id: '1', title: 'Hello', secret: 'x' }
 * ```
 */
function projectFields(
  doc: Record<string, unknown>,
  includeFields?: ReadonlyArray<string>,
  excludeFields?: ReadonlyArray<string>,
): Record<string, unknown> {
  if (includeFields && includeFields.length > 0) {
    const result: Record<string, unknown> = {};
    for (const field of includeFields) {
      const value = getNestedValue(doc, field);
      if (value !== undefined) {
        result[field] = value;
      }
    }
    return result;
  }

  if (excludeFields && excludeFields.length > 0) {
    const excluded = new Set(excludeFields);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc)) {
      if (!excluded.has(key)) {
        result[key] = value;
      }
    }
    return result;
  }

  return { ...doc };
}

// ============================================================================
// DB-native provider factory
// ============================================================================

/**
 * Create a DB-native (in-memory) search provider.
 *
 * Maintains a Map-based in-memory document store per index. Implements
 * full-text search via scored substring matching, with support for structured
 * filters, faceting, geo-distance sorting, highlighting, field projection,
 * distinct deduplication, and both page-based and offset-based pagination.
 *
 * No configuration is required — the provider accepts no arguments. It is the
 * automatic fallback when `provider: 'db-native'` is specified in the plugin
 * config, or as the default provider in development environments.
 *
 * @returns A `SearchProvider` with `name: 'db-native'`.
 *
 * @remarks
 * **Supported store types** — this provider is store-type agnostic. It does
 * not interact with any database — it is purely in-memory. It is compatible
 * with any slingshot store type (`memory`, `redis`, `sqlite`, `postgres`,
 * `mongo`) because it receives pre-transformed documents, not raw DB records.
 *
 * **Text scoring** — scoring uses a weighted substring match via
 * `computeTextScore()`. Each searchable field contributes a score proportional
 * to its `weight` (first field = highest weight, derived by position in the
 * `searchableFields` array). Matching the full field value scores higher than
 * a partial substring match. There is no BM25, TF-IDF, or edit-distance
 * ranking — this is deliberate for predictability in tests.
 *
 * **Matching strategy** — the `matchingStrategy` query option controls how
 * multi-word queries are evaluated: `'all'` requires every word to match;
 * `'last'` / `'frequency'` are handled by `matchesQuery()` in `textScoring.ts`.
 *
 * **Filters** — `SearchFilter` conditions are evaluated by `evaluateFilter()`
 * from `filterEval.ts`. All operators including `$geoRadius` and
 * `$geoBoundingBox` are supported in-memory via haversine distance calculation.
 *
 * **Facets** — computed by `computeFacets()` from `facets.ts` on the full
 * filtered result set before pagination (so counts reflect total matches, not
 * just the current page).
 *
 * **Geo sorting** — the `_geo: { lat, lng }` composite field is expected on
 * documents (applied by `applyGeoTransform()`). Geo sort rules use
 * `haversineDistance()` for in-memory distance calculation.
 *
 * **Limitations vs. dedicated providers** — this provider has no persistent
 * storage, no indexing pipeline, no inverted index, no tokenisation, and no
 * language-aware stemming or typo tolerance. All documents are scanned on
 * every query (O(n) time complexity). It is suitable for up to a few thousand
 * documents in development and test environments. For production with any
 * meaningful data volume, use Meilisearch, Typesense, Elasticsearch, or Algolia.
 *
 * **No `waitForTask`** — all operations are synchronous. The `getTask` and
 * `waitForTask` methods are not defined on this provider.
 *
 * @example
 * ```ts
 * import { createDbNativeProvider } from '@lastshotlabs/slingshot-search';
 *
 * const provider = createDbNativeProvider();
 * await provider.connect();
 *
 * await provider.createOrUpdateIndex('threads', {
 *   searchableFields: ['title', 'body'],
 *   filterableFields: ['status'],
 *   sortableFields: ['createdAt'],
 *   facetableFields: ['status'],
 * });
 *
 * await provider.indexDocuments('threads', [
 *   { id: '1', title: 'Hello world', status: 'published' },
 * ], 'id');
 *
 * const results = await provider.search('threads', { q: 'hello' });
 * // results.hits[0].document.title === 'Hello world'
 * ```
 */
export function createDbNativeProvider(): SearchProvider {
  const indexes = new Map<string, IndexState>();
  let connected = false;

  /**
   * Retrieve an `IndexState` by name or throw a descriptive error.
   *
   * @param indexName - The index name to look up.
   * @returns The `IndexState` for the named index.
   * @throws {Error} If no index with `indexName` has been created.
   */
  function getIndex(indexName: string): IndexState {
    const idx = indexes.get(indexName);
    if (!idx) {
      throw new SearchIndexNotFoundError(`Index '${indexName}' does not exist`);
    }
    return idx;
  }

  /**
   * Return the list of searchable field paths from an index's settings.
   *
   * A thin accessor that keeps callers decoupled from the `settings` shape and
   * makes the intent explicit at the call site.
   *
   * @param settings - The index settings object.
   * @returns The ordered `searchableFields` array (first = highest weight).
   */
  function getSearchableFields(settings: SearchIndexSettings): ReadonlyArray<string> {
    return settings.searchableFields;
  }

  /**
   * Build a weight map from an index's ordered `searchableFields` list.
   *
   * The first field in `searchableFields` receives the highest weight
   * (`fields.length`), and each subsequent field receives one less. This
   * produces a descending weight sequence aligned with the priority of fields
   * as configured by the entity author.
   *
   * @param settings - The index settings containing the ordered `searchableFields`.
   * @returns A `Map<fieldPath, weight>` where weight ≥ 1 for all entries.
   *
   * @example
   * // searchableFields: ['title', 'summary', 'body']
   * // → { 'title': 3, 'summary': 2, 'body': 1 }
   */
  function buildFieldWeights(settings: SearchIndexSettings): Map<string, number> {
    // Searchable fields are already ordered by weight descending.
    // Assign descending weights based on position.
    const weights = new Map<string, number>();
    const fields = settings.searchableFields;
    for (let i = 0; i < fields.length; i++) {
      weights.set(fields[i], fields.length - i);
    }
    return weights;
  }

  const provider: SearchProvider = {
    name: 'db-native',

    // --- Lifecycle ---

    connect(): Promise<void> {
      connected = true;
      return Promise.resolve();
    },

    healthCheck(): Promise<SearchHealthResult> {
      const start = performance.now();
      return Promise.resolve({
        healthy: connected,
        provider: 'db-native',
        latencyMs: Math.round(performance.now() - start),
        version: '1.0.0',
        error: connected ? undefined : 'Not connected',
      });
    },

    teardown(): Promise<void> {
      indexes.clear();
      connected = false;
      return Promise.resolve();
    },

    // --- Index Management ---

    createOrUpdateIndex(indexName: string, settings: SearchIndexSettings): Promise<undefined> {
      const existing = indexes.get(indexName);
      if (existing) {
        // Update settings, preserve documents
        indexes.set(indexName, {
          settings,
          documents: existing.documents,
          primaryKey: existing.primaryKey,
          createdAt: existing.createdAt,
          updatedAt: new Date(),
        });
      } else {
        indexes.set(indexName, {
          settings,
          documents: new Map(),
          primaryKey: settings.primaryKey ?? 'id',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      return Promise.resolve(undefined);
    },

    deleteIndex(indexName: string): Promise<void> {
      indexes.delete(indexName);
      return Promise.resolve();
    },

    listIndexes() {
      return Promise.resolve(
        [...indexes.entries()].map(([name, state]) => ({
          name,
          documentCount: state.documents.size,
          updatedAt: state.updatedAt,
        })),
      );
    },

    getIndexSettings(indexName: string): Promise<SearchIndexSettings> {
      return Promise.resolve().then(() => getIndex(indexName).settings);
    },

    // --- Document Operations ---

    indexDocument(
      indexName: string,
      document: Record<string, unknown>,
      documentId: string,
    ): Promise<void> {
      const idx = getIndex(indexName);
      idx.documents.set(documentId, { ...document });
      idx.updatedAt = new Date();
      return Promise.resolve();
    },

    deleteDocument(indexName: string, documentId: string): Promise<void> {
      const idx = getIndex(indexName);
      idx.documents.delete(documentId);
      idx.updatedAt = new Date();
      return Promise.resolve();
    },

    indexDocuments(
      indexName: string,
      documents: ReadonlyArray<Record<string, unknown>>,
      primaryKey: string,
    ): Promise<undefined> {
      const idx = getIndex(indexName);
      for (const doc of documents) {
        const id = stringifyDocumentId(doc[primaryKey]);
        if (!id) continue;
        idx.documents.set(id, { ...doc });
      }
      idx.updatedAt = new Date();
      return Promise.resolve(undefined);
    },

    deleteDocuments(indexName: string, documentIds: ReadonlyArray<string>): Promise<undefined> {
      const idx = getIndex(indexName);
      for (const id of documentIds) {
        idx.documents.delete(id);
      }
      idx.updatedAt = new Date();
      return Promise.resolve(undefined);
    },

    clearIndex(indexName: string): Promise<undefined> {
      const idx = getIndex(indexName);
      idx.documents.clear();
      idx.updatedAt = new Date();
      return Promise.resolve(undefined);
    },

    // --- Search ---

    async search(indexName: string, query: SearchQuery): Promise<SearchResponse> {
      const start = performance.now();
      const idx = getIndex(indexName);
      const { settings } = idx;
      const searchableFields = getSearchableFields(settings);
      const fieldWeights = buildFieldWeights(settings);
      const matchingStrategy = query.matchingStrategy ?? 'all';

      // 1. Filter + text match
      const allDocs = [...idx.documents.values()];
      const matched: Array<{ doc: Record<string, unknown>; score: number }> = [];

      for (const doc of allDocs) {
        // Apply filter first
        if (query.filter && !evaluateFilter(doc, query.filter)) continue;

        // Text match
        if (!matchesQuery(doc, query.q, searchableFields, matchingStrategy)) continue;

        const score = computeTextScore(doc, query.q, searchableFields, fieldWeights);

        // Score threshold
        if (query.rankingScoreThreshold !== undefined) {
          // Normalize score to 0-1 range (approximate)
          const maxPossibleScore =
            searchableFields.length * 10 * Math.max(...fieldWeights.values(), 1);
          const normalizedScore = maxPossibleScore > 0 ? score / maxPossibleScore : 0;
          if (normalizedScore < query.rankingScoreThreshold) continue;
        }

        matched.push({ doc, score });
      }

      // 2. Distinct / dedup
      let deduped = matched;
      const distinctField = query.distinct ?? settings.distinctField;
      if (distinctField) {
        const seen = new Set<unknown>();
        deduped = matched.filter(({ doc }) => {
          const val = getNestedValue(doc, distinctField);
          if (seen.has(val)) return false;
          seen.add(val);
          return true;
        });
      }

      // 3. Sort
      applySorting(deduped, query.sort);

      const totalHits = deduped.length;

      // 4. Facets (computed on the filtered set before pagination)
      let facetDistribution: Record<string, Record<string, number>> | undefined;
      let facetStats: Record<string, FacetStats> | undefined;
      if (query.facets && query.facets.length > 0) {
        const filteredDocs = deduped.map(d => d.doc);
        const facetResult = computeFacets(filteredDocs, query.facets, query.facetOptions);
        facetDistribution = facetResult.distribution;
        facetStats = Object.keys(facetResult.stats).length > 0 ? facetResult.stats : undefined;
      }

      // 5. Pagination
      // dbNative materializes the entire filtered/sorted set in memory before
      // slicing, so deep pagination is a heap-pressure DoS vector. Cap the
      // effective offset at MAX_DB_NATIVE_OFFSET (10,000) and reject anything
      // beyond — callers should switch to filter-by-cursor for deeper scans.
      const MAX_DB_NATIVE_OFFSET = 10_000;
      let offset: number;
      let limit: number;
      let page: number | undefined;
      let hitsPerPage: number | undefined;

      if (query.page !== undefined) {
        hitsPerPage = query.hitsPerPage ?? 20;
        page = query.page;
        offset = (page - 1) * hitsPerPage;
        limit = hitsPerPage;
      } else {
        offset = query.offset ?? 0;
        limit = query.limit ?? 20;
      }

      if (offset > MAX_DB_NATIVE_OFFSET) {
        throw new SearchPaginationError(
          `offset ${offset} exceeds the safe maximum ` +
            `${MAX_DB_NATIVE_OFFSET}. Use a more selective filter or a cursor-based scan ` +
            `for deeper pagination.`,
        );
      }

      const paginatedDocs = deduped.slice(offset, offset + limit);

      // 6. Build hits with highlights, projections, scores
      const preTag = query.highlight?.preTag ?? '<mark>';
      const postTag = query.highlight?.postTag ?? '</mark>';
      const highlightFields =
        query.highlight?.fields ?? (query.highlight ? searchableFields : undefined);

      const hits: Array<SearchHit> = paginatedDocs.map(({ doc, score }) => {
        let projected = projectFields(doc, query.fields, query.excludeFields);

        // Apply index-level excluded fields (displayed: false in entity config)
        if (settings.excludedFields && settings.excludedFields.length > 0) {
          const excludedSet = new Set(settings.excludedFields);
          const cleaned: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(projected)) {
            if (!excludedSet.has(key)) {
              cleaned[key] = value;
            }
          }
          projected = cleaned;
        }

        let highlights: Record<string, string> | undefined;
        if (highlightFields) {
          const computed = computeHighlights(doc, query.q, highlightFields, preTag, postTag);
          if (Object.keys(computed).length > 0) {
            highlights = computed;
          }
        }

        let matchesPosition:
          | Record<string, ReadonlyArray<{ start: number; length: number }>>
          | undefined;
        if (query.showMatchesPosition) {
          const positions = computeMatchPositions(doc, query.q, searchableFields);
          if (Object.keys(positions).length > 0) {
            matchesPosition = positions;
          }
        }

        return {
          document: projected,
          score: query.showRankingScore ? score : undefined,
          highlights,
          matchesPosition,
        } satisfies SearchHit;
      });

      // 7. Build response
      const processingTimeMs = Math.round(performance.now() - start);

      const response: SearchResponse = {
        hits,
        totalHits,
        totalHitsRelation: 'exact',
        query: query.q,
        processingTimeMs,
        indexName,
        facetDistribution,
        facetStats,
        page,
        hitsPerPage,
        totalPages: page !== undefined ? Math.ceil(totalHits / (hitsPerPage ?? 20)) : undefined,
        offset: page !== undefined ? undefined : offset,
        limit: page !== undefined ? undefined : limit,
      };

      return response;
    },

    async multiSearch(
      queries: ReadonlyArray<{ indexName: string; query: SearchQuery }>,
    ): Promise<ReadonlyArray<SearchResponse>> {
      return Promise.all(queries.map(({ indexName, query }) => provider.search(indexName, query)));
    },

    // --- Suggest ---

    suggest(indexName: string, query: SuggestQuery): Promise<SuggestResponse> {
      const start = performance.now();
      const idx = getIndex(indexName);
      const { settings } = idx;
      const suggestFields = query.fields ?? settings.searchableFields;
      const limit = query.limit ?? 5;
      const q = query.q.toLowerCase();
      const preTag = '<mark>';
      const postTag = '</mark>';

      // Collect all unique prefix-matched values from searchable fields
      const seen = new Set<string>();
      const suggestions: Array<{
        text: string;
        highlight?: string;
        score: number;
        field: string;
      }> = [];

      for (const doc of idx.documents.values()) {
        // Apply filter if provided
        if (query.filter && !evaluateFilter(doc, query.filter)) continue;

        for (const field of suggestFields) {
          const value = getNestedValue(doc, field);
          if (value === undefined || value === null) continue;
          const text = stringifySearchValue(value);
          const textLower = text.toLowerCase();

          // Prefix match on the full value or on individual words
          let matched = false;
          let score = 0;

          if (textLower.startsWith(q)) {
            matched = true;
            score = 10; // Full prefix match — high score
          } else {
            // Check word-level prefix matching
            const words = textLower.split(/\s+/);
            for (const word of words) {
              if (word.startsWith(q)) {
                matched = true;
                score = 5; // Word prefix match
                break;
              }
            }
            // Also include substring matches with lower score
            if (!matched && textLower.includes(q)) {
              matched = true;
              score = 1;
            }
          }

          if (matched && !seen.has(textLower)) {
            seen.add(textLower);
            suggestions.push({
              text,
              highlight: query.highlight
                ? highlightText(text, query.q, preTag, postTag)
                : undefined,
              score,
              field,
            });
          }
        }

        // Early exit if we have enough
        if (suggestions.length >= limit * 3) break;
      }

      // Sort by score descending, then alphabetically
      suggestions.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));

      return Promise.resolve({
        suggestions: suggestions.slice(0, limit).map(s => ({
          text: s.text,
          highlight: s.highlight,
          score: s.score,
          field: s.field,
        })),
        processingTimeMs: Math.round(performance.now() - start),
      });
    },
  };

  return provider;
}
