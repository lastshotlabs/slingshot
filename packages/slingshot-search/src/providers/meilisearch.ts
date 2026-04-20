/**
 * Meilisearch search provider.
 *
 * HTTP-based provider that communicates with a Meilisearch instance via its
 * REST API. Uses native `fetch` (available in Bun) with retry logic and
 * exponential backoff.
 *
 * Implements the full `SearchProvider` interface including lifecycle, index
 * management, document operations, search, suggest, and task monitoring.
 */
import type { SearchProvider } from '../types/provider';
import type {
  MeilisearchProviderConfig,
  SearchHealthResult,
  SearchIndexSettings,
  SearchIndexTask,
  SearchRankingRule,
  SynonymDefinition,
} from '../types/provider';
import type { SearchFilter, SearchQuery, SearchSort, SuggestQuery } from '../types/query';
import type { SearchHit, SearchResponse, SuggestResponse } from '../types/response';
import { stringifySearchValue } from './stringify';

// ============================================================================
// Internal HTTP client
// ============================================================================

interface HttpClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
}

interface HttpResponse<T = unknown> {
  readonly status: number;
  /** Undefined for 204 No Content responses — check `status` before accessing. */
  readonly data: T | undefined;
}

interface HttpClient {
  get<T>(path: string): Promise<{ readonly status: number; readonly data: T }>;
  post<T>(path: string, body?: unknown): Promise<{ readonly status: number; readonly data: T }>;
  put<T>(path: string, body?: unknown): Promise<{ readonly status: number; readonly data: T }>;
  patch<T>(path: string, body?: unknown): Promise<{ readonly status: number; readonly data: T }>;
  delete<T>(path: string, body?: unknown): Promise<{ readonly status: number; readonly data: T }>;
  send<T>(method: string, path: string, body?: unknown): Promise<HttpResponse<T>>;
}

/**
 * Create a lightweight HTTP client pre-configured for a Meilisearch instance.
 *
 * Wraps `fetch` with:
 * - **Authorization header** — `Bearer <apiKey>` on every request.
 * - **Retry with exponential backoff** — up to `config.retries` retries.
 *   Server errors (5xx) and rate-limit responses (429, 408) are retried;
 *   other 4xx client errors are thrown immediately without retry.
 * - **Timeout** — each attempt is cancelled after `config.timeoutMs` ms via
 *   `AbortSignal.timeout`.
 * - **204 No Content** — returns `{ status: 204, data: undefined }` so callers
 *   can detect empty responses without trying to parse a missing body.
 *
 * @param config - Connection parameters (base URL, API key, timeout, retries).
 * @returns An object with convenience methods `get`, `post`, `put`, `patch`,
 *   `delete`, and `send`. All methods return a promise that resolves to
 *   `{ status, data }` or rejects with a descriptive `Error`.
 *
 * @throws {Error} On non-retryable HTTP errors (4xx except 408/429), on
 *   timeout, or after all retry attempts are exhausted.
 *
 * @remarks
 * `get`, `post`, `put`, `patch`, and `delete` are convenience wrappers around
 * `jsonRequest`, which asserts that a JSON body was returned. Use `send` for
 * endpoints that may return 204 No Content (e.g. index deletion tasks).
 *
 * @example
 * ```ts
 * const client = createHttpClient({
 *   baseUrl: 'http://localhost:7700',
 *   apiKey: 'masterKey',
 *   timeoutMs: 5000,
 *   retries: 2,
 *   retryDelayMs: 100,
 * });
 *
 * const { data } = await client.get<{ version: string }>('/version');
 * ```
 */
function createHttpClient(config: HttpClientConfig) {
  const { baseUrl, apiKey, timeoutMs, retries, retryDelayMs } = config;

  function buildUrl(path: string): string {
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalizedPath}`;
  }

  function buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<HttpResponse<T>> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const delay = retryDelayMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      try {
        const response = await fetch(buildUrl(path), {
          method,
          headers: buildHeaders(),
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          const error = new Error(
            `[slingshot-search:meilisearch] HTTP ${response.status} ${method} ${path}: ${errorBody}`,
          );

          // Don't retry client errors (4xx) except 408 (timeout) and 429 (rate limit)
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429
          ) {
            throw error;
          }

          lastError = error;
          continue;
        }

        // 204 No Content — no body to parse
        if (response.status === 204) {
          return { status: response.status, data: undefined };
        }

        const data = (await response.json()) as T;
        return { status: response.status, data };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          lastError = new Error(
            `[slingshot-search:meilisearch] Request timeout after ${timeoutMs}ms: ${method} ${path}`,
          );
        } else if (
          err instanceof Error &&
          err.message.startsWith('[slingshot-search:meilisearch]')
        ) {
          // Already formatted error from non-retryable response
          throw err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    throw (
      lastError ?? new Error(`[slingshot-search:meilisearch] Request failed: ${method} ${path}`)
    );
  }

  /** Wrapper that narrows data to non-undefined for endpoints that always return a body. */
  async function jsonRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly data: unknown }> {
    const response = await request(method, path, body);
    if (response.data === undefined) {
      throw new Error(
        `[slingshot-search:meilisearch] Expected JSON body but got ${response.status} for ${method} ${path}`,
      );
    }
    return { status: response.status, data: response.data };
  }

  const get = ((path: string) => jsonRequest('GET', path)) as HttpClient['get'];
  const post = ((path: string, body?: unknown) =>
    jsonRequest('POST', path, body)) as HttpClient['post'];
  const put = ((path: string, body?: unknown) =>
    jsonRequest('PUT', path, body)) as HttpClient['put'];
  const patch = ((path: string, body?: unknown) =>
    jsonRequest('PATCH', path, body)) as HttpClient['patch'];
  const remove = ((path: string, body?: unknown) =>
    jsonRequest('DELETE', path, body)) as HttpClient['delete'];
  const send = ((method: string, path: string, body?: unknown) =>
    request(method, path, body)) as HttpClient['send'];

  const client: HttpClient = {
    get,
    post,
    put,
    patch,
    delete: remove,
    /** For endpoints that may return 204 No Content. */
    send,
  };

  return client;
}

// ============================================================================
// Filter translation
// ============================================================================

/**
 * Convert a `SearchFilter` AST to a Meilisearch filter expression string.
 *
 * Recursively transforms composite operators and leaf conditions into the
 * Meilisearch filter syntax accepted by its search and documents endpoints.
 *
 * @param filter - The filter AST to translate. Supports all `SearchFilter`
 *   variants: `$and`, `$or`, `$not`, `$geoRadius`, `$geoBoundingBox`, and
 *   `SearchFilterCondition` leaves.
 * @returns A Meilisearch-compatible filter string, e.g. `status = "published"`,
 *   `(a > 1) AND (b < 10)`, or `_geoRadius(48.85, 2.35, 1000)`.
 *
 * @remarks
 * **Operator mapping caveats:**
 * - `CONTAINS` — Meilisearch has no native `CONTAINS` operator; the function
 *   falls back to `=` (equality) as the closest approximation. For array fields
 *   this effectively tests membership, but for string fields it will only match
 *   exact equality, not substring presence.
 * - `STARTS_WITH` — not supported by Meilisearch's filter syntax. A warning is
 *   logged to `console.warn` and the filter degrades to `field EXISTS` (no-op).
 * - `BETWEEN` — translated as `field min TO max` (Meilisearch range syntax).
 *
 * @example
 * ```ts
 * searchFilterToMeilisearchFilter({ field: 'status', op: '=', value: 'published' });
 * // 'status = "published"'
 *
 * searchFilterToMeilisearchFilter({ $and: [
 *   { field: 'price', op: '>=', value: 10 },
 *   { field: 'price', op: '<=', value: 100 },
 * ]});
 * // '(price >= 10) AND (price <= 100)'
 *
 * searchFilterToMeilisearchFilter({ $geoRadius: { lat: 48.85, lng: 2.35, radiusMeters: 1000 } });
 * // '_geoRadius(48.85, 2.35, 1000)'
 * ```
 */
export function searchFilterToMeilisearchFilter(filter: SearchFilter): string {
  if ('$and' in filter) {
    const clauses = filter.$and.map(f => searchFilterToMeilisearchFilter(f));
    return clauses.map(c => `(${c})`).join(' AND ');
  }

  if ('$or' in filter) {
    const clauses = filter.$or.map(f => searchFilterToMeilisearchFilter(f));
    return clauses.map(c => `(${c})`).join(' OR ');
  }

  if ('$not' in filter) {
    return `NOT (${searchFilterToMeilisearchFilter(filter.$not)})`;
  }

  if ('$geoRadius' in filter) {
    const { lat, lng, radiusMeters } = filter.$geoRadius;
    return `_geoRadius(${lat}, ${lng}, ${radiusMeters})`;
  }

  if ('$geoBoundingBox' in filter) {
    const { topLeft, bottomRight } = filter.$geoBoundingBox;
    return `_geoBoundingBox([${topLeft.lat}, ${topLeft.lng}], [${bottomRight.lat}, ${bottomRight.lng}])`;
  }

  // SearchFilterCondition
  if ('field' in filter && 'op' in filter) {
    const { field, op, value } = filter;

    switch (op) {
      case '=':
        return `${field} = ${formatFilterValue(value)}`;

      case '!=':
        return `${field} != ${formatFilterValue(value)}`;

      case '>':
        return `${field} > ${formatFilterValue(value)}`;

      case '>=':
        return `${field} >= ${formatFilterValue(value)}`;

      case '<':
        return `${field} < ${formatFilterValue(value)}`;

      case '<=':
        return `${field} <= ${formatFilterValue(value)}`;

      case 'IN':
        if (Array.isArray(value)) {
          const formatted = (value as ReadonlyArray<string | number | boolean>)
            .map(formatFilterValue)
            .join(', ');
          return `${field} IN [${formatted}]`;
        }
        return `${field} IN [${formatFilterValue(value)}]`;

      case 'NOT_IN':
        if (Array.isArray(value)) {
          const formatted = (value as ReadonlyArray<string | number | boolean>)
            .map(formatFilterValue)
            .join(', ');
          return `${field} NOT IN [${formatted}]`;
        }
        return `${field} NOT IN [${formatFilterValue(value)}]`;

      case 'EXISTS':
        return `${field} EXISTS`;

      case 'NOT_EXISTS':
        return `${field} NOT EXISTS`;

      case 'BETWEEN': {
        if (Array.isArray(value) && value.length === 2) {
          const min: unknown = value[0];
          const max: unknown = value[1];
          return `${field} ${stringifySearchValue(min)} TO ${stringifySearchValue(max)}`;
        }
        return `${field} EXISTS`;
      }

      case 'IS_EMPTY':
        return `${field} IS EMPTY`;

      case 'IS_NOT_EMPTY':
        return `${field} IS NOT EMPTY`;

      case 'CONTAINS':
        // Meilisearch doesn't have a native CONTAINS filter operator.
        // Use equality as closest approximation for array membership.
        return `${field} = ${formatFilterValue(value)}`;

      case 'STARTS_WITH':
        // Not natively supported in Meilisearch filters.
        // Cannot be translated — log a warning and return a no-op filter.
        console.warn(
          `[slingshot-search:meilisearch] STARTS_WITH filter is not supported by Meilisearch. Skipping filter on field '${field}'.`,
        );
        return `${field} EXISTS`;

      default:
        return `${field} EXISTS`;
    }
  }

  return '';
}

function formatFilterValue(value: unknown): string {
  if (typeof value === 'string') {
    // Escape double quotes within string values
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  if (value instanceof Date) {
    return `${value.getTime()}`;
  }
  return stringifySearchValue(value);
}

// ============================================================================
// Settings mapping
// ============================================================================

interface MeilisearchSettings {
  searchableAttributes?: string[];
  filterableAttributes?: string[];
  sortableAttributes?: string[];
  displayedAttributes?: string[];
  rankingRules?: string[];
  typoTolerance?: {
    enabled?: boolean;
    minWordSizeForTypos?: {
      oneTypo?: number;
      twoTypos?: number;
    };
    disableOnAttributes?: string[];
    disableOnNumbers?: boolean;
  };
  synonyms?: Record<string, string[]>;
  stopWords?: string[];
  pagination?: { maxTotalHits?: number };
  proximityPrecision?: 'byWord' | 'byAttribute';
  distinctAttribute?: string | null;
  separatorTokens?: string[];
  nonSeparatorTokens?: string[];
}

function mapSettingsToMeilisearch(settings: SearchIndexSettings): MeilisearchSettings {
  const result: MeilisearchSettings = {};

  if (settings.searchableFields.length > 0) {
    result.searchableAttributes = [...settings.searchableFields];
  }

  // Meilisearch doesn't separate filterable and facetable — merge them
  const filterableSet = new Set([...settings.filterableFields, ...settings.facetableFields]);
  if (filterableSet.size > 0) {
    result.filterableAttributes = [...filterableSet];
  }

  if (settings.sortableFields.length > 0) {
    result.sortableAttributes = [...settings.sortableFields];
  }

  if (settings.displayedFields && settings.displayedFields.length > 0) {
    result.displayedAttributes = [...settings.displayedFields];
  } else if (settings.excludedFields && settings.excludedFields.length > 0) {
    // Compute displayedAttributes as all known fields minus excluded fields.
    // Gather all fields from searchable, filterable, sortable, and facetable sets.
    const allFields = new Set<string>([
      ...settings.searchableFields,
      ...settings.filterableFields,
      ...settings.sortableFields,
      ...settings.facetableFields,
    ]);
    const excludedSet = new Set(settings.excludedFields);
    const displayed = [...allFields].filter(f => !excludedSet.has(f));
    if (displayed.length > 0) {
      result.displayedAttributes = displayed;
    }
  }

  if (settings.ranking?.rules && settings.ranking.rules.length > 0) {
    result.rankingRules = settings.ranking.rules.map(mapRankingRule);
  }

  if (settings.typoTolerance) {
    result.typoTolerance = {
      enabled: settings.typoTolerance.enabled,
      minWordSizeForTypos: {
        oneTypo: settings.typoTolerance.minWordSizeForOneTypo,
        twoTypos: settings.typoTolerance.minWordSizeForTwoTypos,
      },
      disableOnAttributes: settings.typoTolerance.disableOnFields
        ? [...settings.typoTolerance.disableOnFields]
        : undefined,
      disableOnNumbers: settings.typoTolerance.disableOnNumbers,
    };
  }

  if (settings.synonyms && settings.synonyms.length > 0) {
    result.synonyms = mapSynonyms(settings.synonyms);
  }

  if (settings.stopWords && settings.stopWords.length > 0) {
    result.stopWords = [...settings.stopWords];
  }

  if (settings.pagination) {
    result.pagination = { maxTotalHits: settings.pagination.maxTotalHits };
  }

  if (settings.proximityPrecision) {
    result.proximityPrecision = settings.proximityPrecision;
  }

  if (settings.distinctField) {
    result.distinctAttribute = settings.distinctField;
  }

  if (settings.separatorTokens && settings.separatorTokens.length > 0) {
    result.separatorTokens = [...settings.separatorTokens];
  }

  if (settings.nonSeparatorTokens && settings.nonSeparatorTokens.length > 0) {
    result.nonSeparatorTokens = [...settings.nonSeparatorTokens];
  }

  return result;
}

function mapRankingRule(rule: SearchRankingRule): string {
  if (typeof rule === 'string') {
    return rule;
  }
  return `${rule.field}:${rule.direction}`;
}

function mapSynonyms(synonyms: ReadonlyArray<SynonymDefinition>): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const syn of synonyms) {
    const words = [...syn.words];
    if (syn.oneWay && words.length >= 2) {
      // One-way synonym: first word maps to the rest
      result[words[0]] = words.slice(1);
    } else {
      // Two-way: each word maps to all others
      for (const word of words) {
        result[word] = words.filter(w => w !== word);
      }
    }
  }

  return result;
}

function mapMeilisearchSettingsToOurs(meili: MeilisearchSettings): SearchIndexSettings {
  return {
    searchableFields: meili.searchableAttributes ?? [],
    filterableFields: meili.filterableAttributes ?? [],
    sortableFields: meili.sortableAttributes ?? [],
    facetableFields: [], // Meilisearch doesn't separate these
    displayedFields: meili.displayedAttributes ?? undefined,
    distinctField: meili.distinctAttribute ?? undefined,
    stopWords: meili.stopWords ?? undefined,
    pagination: meili.pagination ?? undefined,
    proximityPrecision: meili.proximityPrecision ?? undefined,
    separatorTokens: meili.separatorTokens ?? undefined,
    nonSeparatorTokens: meili.nonSeparatorTokens ?? undefined,
    ranking: meili.rankingRules ? { rules: meili.rankingRules.map(parseRankingRule) } : undefined,
    typoTolerance: meili.typoTolerance
      ? {
          enabled: meili.typoTolerance.enabled,
          minWordSizeForOneTypo: meili.typoTolerance.minWordSizeForTypos?.oneTypo,
          minWordSizeForTwoTypos: meili.typoTolerance.minWordSizeForTypos?.twoTypos,
          disableOnFields: meili.typoTolerance.disableOnAttributes
            ? [...meili.typoTolerance.disableOnAttributes]
            : undefined,
          disableOnNumbers: meili.typoTolerance.disableOnNumbers,
        }
      : undefined,
    synonyms: meili.synonyms ? parseSynonyms(meili.synonyms) : undefined,
  };
}

function parseRankingRule(rule: string): SearchRankingRule {
  const builtins = ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'];
  if (builtins.includes(rule)) {
    return rule as SearchRankingRule;
  }
  // Custom field rule: "fieldName:asc" or "fieldName:desc"
  const colonIdx = rule.lastIndexOf(':');
  if (colonIdx > 0) {
    const field = rule.slice(0, colonIdx);
    const direction = rule.slice(colonIdx + 1);
    if (direction === 'asc' || direction === 'desc') {
      return { field, direction };
    }
  }
  // Unknown — return as-is string (best effort)
  return rule as SearchRankingRule;
}

function parseSynonyms(meiliSynonyms: Record<string, string[]>): SynonymDefinition[] {
  const result: SynonymDefinition[] = [];
  const processed = new Set<string>();

  for (const [word, targets] of Object.entries(meiliSynonyms)) {
    if (processed.has(word)) continue;

    // Check if it's a two-way synonym (all targets also map back to this word)
    const isTwoWay = targets.every(t => {
      const synonymTargets = meiliSynonyms[t];
      return Array.isArray(synonymTargets) && synonymTargets.includes(word);
    });

    if (isTwoWay) {
      const allWords = [word, ...targets];
      for (const w of allWords) processed.add(w);
      result.push({ words: allWords });
    } else {
      result.push({ words: [word, ...targets], oneWay: true });
    }
  }

  return result;
}

// ============================================================================
// Search query mapping
// ============================================================================

interface MeilisearchSearchParams {
  q: string;
  filter?: string;
  sort?: string[];
  facets?: string[];
  page?: number;
  hitsPerPage?: number;
  offset?: number;
  limit?: number;
  attributesToHighlight?: string[];
  highlightPreTag?: string;
  highlightPostTag?: string;
  attributesToCrop?: string[];
  cropLength?: number;
  matchingStrategy?: 'all' | 'last' | 'frequency';
  showMatchesPosition?: boolean;
  showRankingScore?: boolean;
  rankingScoreThreshold?: number;
  distinct?: string;
  attributesToRetrieve?: string[];
  hybrid?: {
    semanticRatio?: number;
    embedder?: string;
  };
}

function mapSearchQueryToMeilisearch(query: SearchQuery): MeilisearchSearchParams {
  const params: MeilisearchSearchParams = { q: query.q };

  if (query.filter) {
    params.filter = searchFilterToMeilisearchFilter(query.filter);
  }

  if (query.sort && query.sort.length > 0) {
    params.sort = query.sort.map(mapSortToMeilisearch);
  }

  if (query.facets && query.facets.length > 0) {
    params.facets = [...query.facets];
  }

  // Pagination
  if (query.page !== undefined) {
    params.page = query.page;
    if (query.hitsPerPage !== undefined) {
      params.hitsPerPage = query.hitsPerPage;
    }
  } else {
    if (query.offset !== undefined) params.offset = query.offset;
    if (query.limit !== undefined) params.limit = query.limit;
  }

  // Highlighting
  if (query.highlight) {
    params.attributesToHighlight = query.highlight.fields ? [...query.highlight.fields] : ['*'];
    if (query.highlight.preTag) params.highlightPreTag = query.highlight.preTag;
    if (query.highlight.postTag) params.highlightPostTag = query.highlight.postTag;
  }

  // Snippets
  if (query.snippet) {
    params.attributesToCrop = [...query.snippet.fields];
    if (query.snippet.maxWords) params.cropLength = query.snippet.maxWords;
    // Snippet highlight tags — use snippet's tags if set, else fall through to highlight tags
    if (query.snippet.preTag && !query.highlight?.preTag) {
      params.highlightPreTag = query.snippet.preTag;
    }
    if (query.snippet.postTag && !query.highlight?.postTag) {
      params.highlightPostTag = query.snippet.postTag;
    }
  }

  // Matching behavior
  if (query.matchingStrategy) params.matchingStrategy = query.matchingStrategy;
  if (query.showMatchesPosition) params.showMatchesPosition = true;
  if (query.showRankingScore) params.showRankingScore = true;
  if (query.rankingScoreThreshold !== undefined) {
    params.rankingScoreThreshold = query.rankingScoreThreshold;
  }
  if (query.distinct) params.distinct = query.distinct;

  // Field projection
  if (query.fields && query.fields.length > 0) {
    params.attributesToRetrieve = [...query.fields];
  }

  // Hybrid search
  if (query.hybrid) {
    params.hybrid = {
      semanticRatio: query.hybrid.semanticRatio,
      embedder: query.hybrid.embedder,
    };
  }

  return params;
}

function mapSortToMeilisearch(sort: SearchSort): string {
  if ('geoPoint' in sort) {
    return `_geoPoint(${sort.geoPoint.lat}, ${sort.geoPoint.lng}):${sort.direction}`;
  }
  return `${sort.field}:${sort.direction}`;
}

// ============================================================================
// Response mapping
// ============================================================================

interface MeilisearchSearchResponse {
  hits: Array<Record<string, unknown>>;
  query: string;
  processingTimeMs: number;
  estimatedTotalHits?: number;
  totalHits?: number;
  totalPages?: number;
  page?: number;
  hitsPerPage?: number;
  offset?: number;
  limit?: number;
  facetDistribution?: Record<string, Record<string, number>>;
  facetStats?: Record<string, { min: number; max: number }>;
}

interface MeilisearchHit extends Record<string, unknown> {
  _formatted?: Partial<Record<string, unknown>>;
  _matchesPosition?: Record<string, Array<{ start: number; length: number }>>;
  _rankingScore?: number;
  _rankingScoreDetails?: Record<string, unknown>;
  _geo?: { lat: number; lng: number };
  _geoDistance?: number;
}

function mapMeilisearchResponse(
  meiliResponse: MeilisearchSearchResponse,
  indexName: string,
): SearchResponse {
  const hits: SearchHit[] = meiliResponse.hits.map(rawHit => {
    const hit = rawHit as MeilisearchHit;

    // Extract special Meilisearch fields, leave the rest as the document
    const {
      _formatted,
      _matchesPosition,
      _rankingScore,
      _rankingScoreDetails,
      _geoDistance,
      ...document
    } = hit;

    // Build highlights from _formatted
    let highlights: Record<string, string> | undefined;
    if (_formatted) {
      const h: Record<string, string> = {};
      for (const [key, value] of Object.entries(_formatted)) {
        if (key.startsWith('_')) continue;
        const originalValue = stringifySearchValue(document[key]);
        const formattedValue = stringifySearchValue(value);
        if (formattedValue !== originalValue) {
          h[key] = formattedValue;
        }
      }
      if (Object.keys(h).length > 0) {
        highlights = h;
      }
    }

    // Build snippets from _formatted crop fields
    let snippets: Record<string, string> | undefined;
    if (_formatted) {
      const s: Record<string, string> = {};
      for (const [key, value] of Object.entries(_formatted)) {
        if (key.startsWith('_')) continue;
        const formattedValue = stringifySearchValue(value);
        // Cropped values contain ellipsis markers
        if (formattedValue.includes('…') || formattedValue.includes('...')) {
          s[key] = formattedValue;
        }
      }
      if (Object.keys(s).length > 0) {
        snippets = s;
      }
    }

    return {
      document,
      score: _rankingScore,
      highlights,
      snippets,
      matchesPosition: _matchesPosition
        ? Object.fromEntries(
            Object.entries(_matchesPosition).map(([k, v]) => [
              k,
              v.map(p => ({ start: p.start, length: p.length })),
            ]),
          )
        : undefined,
      geoDistanceMeters: _geoDistance,
      rankingScoreDetails: _rankingScoreDetails,
    } satisfies SearchHit;
  });

  const totalHits = meiliResponse.totalHits ?? meiliResponse.estimatedTotalHits ?? 0;

  return {
    hits,
    totalHits,
    totalHitsRelation: meiliResponse.totalHits !== undefined ? 'exact' : 'estimated',
    query: meiliResponse.query,
    processingTimeMs: meiliResponse.processingTimeMs,
    indexName,
    facetDistribution: meiliResponse.facetDistribution,
    facetStats: meiliResponse.facetStats
      ? Object.fromEntries(
          Object.entries(meiliResponse.facetStats).map(([field, stats]) => [
            field,
            {
              min: stats.min,
              max: stats.max,
              avg: 0, // Meilisearch doesn't provide avg
              sum: 0, // Meilisearch doesn't provide sum
              count: 0, // Meilisearch doesn't provide count
            },
          ]),
        )
      : undefined,
    estimatedTotalHits: meiliResponse.estimatedTotalHits,
    page: meiliResponse.page,
    totalPages: meiliResponse.totalPages,
    hitsPerPage: meiliResponse.hitsPerPage,
    offset: meiliResponse.offset,
    limit: meiliResponse.limit,
  };
}

// ============================================================================
// Task types
// ============================================================================

interface MeilisearchTask {
  taskUid: number;
  indexUid: string;
  status: 'enqueued' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  type: string;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: { message: string; code: string; type: string };
}

function mapTask(task: MeilisearchTask): SearchIndexTask {
  return {
    taskId: task.taskUid,
    status: task.status === 'canceled' ? 'failed' : task.status,
    enqueuedAt: new Date(task.enqueuedAt),
  };
}

// ============================================================================
// Meilisearch provider factory
// ============================================================================

/**
 * Create a Meilisearch search provider.
 *
 * Communicates with a Meilisearch instance over HTTP using native `fetch`
 * with configurable retry and exponential backoff. Supports full index
 * management, document operations, search, suggest, multi-search, and
 * asynchronous task monitoring.
 *
 * @param config - Meilisearch connection and authentication configuration.
 * @returns A `SearchProvider` with `name: 'meilisearch'`.
 *
 * @throws {Error} From `connect()` if the `/health` endpoint reports a status
 *   other than `'available'`, or if the HTTP request fails after all retries.
 * @throws {Error} From any index or document operation if the HTTP request
 *   returns a non-retryable 4xx error or exhausts retries.
 *
 * @remarks
 * **Index naming** — Meilisearch uses the term "index" directly. The
 * `indexName` passed to provider methods maps directly to the Meilisearch
 * index `uid`. The plugin-level `indexPrefix` is applied by the search
 * manager before reaching this provider.
 *
 * **Async task queue** — most Meilisearch mutations (index creation, settings
 * update, document import, clear index, delete index) are asynchronous and
 * return a task object. `createOrUpdateIndex()` waits for the index creation
 * task before applying settings to avoid race conditions. `reindex()` in the
 * search manager uses `waitForTask()` between batches when this provider is
 * used.
 *
 * **`waitForTask()` polling** — polls `GET /tasks/:taskUid` at 200 ms
 * intervals until the task status is `succeeded`, `failed`, or `canceled`.
 * `canceled` maps to `'failed'` in the returned `SearchIndexTask`.
 *
 * **Filterable attributes** — Meilisearch does not separate filterable and
 * facetable attributes. The provider merges both sets into
 * `filterableAttributes`. For entities with tenant isolation configured as
 * `'filtered'`, the `tenantField` is automatically included (handled by
 * `deriveIndexSettings()` in the search manager).
 *
 * **Ranking rules** — `SearchIndexSettings.ranking.rules` supports both
 * built-in string rules (`'words'`, `'typo'`, `'proximity'`, `'attribute'`,
 * `'sort'`, `'exactness'`) and custom field rules (`{ field, direction }`
 * serialised as `'fieldName:asc'`). When absent, Meilisearch applies its
 * default ranking rules.
 *
 * **Geo fields** — Meilisearch uses `_geo: { lat, lng }` natively.
 * `applyGeoTransform()` is applied before documents reach this provider, so
 * the composite `_geo` field is always present when a geo config is defined.
 * Geo filters use `_geoRadius(lat, lng, radiusMeters)` and
 * `_geoBoundingBox([lat, lng], [lat, lng])` syntax in the filter string.
 *
 * **`facetStats`** — Meilisearch only returns `{ min, max }` for numeric
 * facets. The `avg`, `sum`, and `count` fields in the response are `0`
 * because Meilisearch does not compute them.
 *
 * @example
 * ```ts
 * import { createMeilisearchProvider } from '@lastshotlabs/slingshot-search';
 *
 * const provider = createMeilisearchProvider({
 *   provider: 'meilisearch',
 *   url: 'http://localhost:7700',
 *   apiKey: 'masterKey',
 *   timeoutMs: 5000,
 *   retries: 3,
 * });
 *
 * await provider.connect();
 * await provider.createOrUpdateIndex('threads', settings);
 * await provider.indexDocuments('threads', docs, 'id');
 * const results = await provider.search('threads', { q: 'hello' });
 * ```
 */
export function createMeilisearchProvider(config: MeilisearchProviderConfig): SearchProvider {
  const http = createHttpClient({
    baseUrl: config.url,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs ?? 5000,
    retries: config.retries ?? 3,
    retryDelayMs: config.retryDelayMs ?? 200,
  });

  const provider: SearchProvider = {
    name: 'meilisearch',

    // --- Lifecycle ---

    async connect(): Promise<void> {
      const { data } = await http.get<{ status: string }>('/health');
      if (data.status !== 'available') {
        throw new Error(
          `[slingshot-search:meilisearch] Health check failed: status = ${data.status}`,
        );
      }
    },

    async healthCheck(): Promise<SearchHealthResult> {
      const start = performance.now();
      try {
        const { data } = await http.get<{ status: string }>('/health');
        const { data: versionData } = await http.get<{ pkgVersion: string }>('/version');
        return {
          healthy: data.status === 'available',
          provider: 'meilisearch',
          latencyMs: Math.round(performance.now() - start),
          version: versionData.pkgVersion,
        };
      } catch (err) {
        return {
          healthy: false,
          provider: 'meilisearch',
          latencyMs: Math.round(performance.now() - start),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    teardown(): Promise<void> {
      // HTTP-based — no persistent connections to close
      return Promise.resolve();
    },

    // --- Index Management ---

    async createOrUpdateIndex(
      indexName: string,
      settings: SearchIndexSettings,
    ): Promise<SearchIndexTask> {
      // Create the index (idempotent — Meilisearch returns 202 if already exists)
      try {
        const { data: createTask } = await http.post<MeilisearchTask>('/indexes', {
          uid: indexName,
          primaryKey: settings.primaryKey ?? 'id',
        });
        // Wait for index creation to complete before applying settings
        if (provider.waitForTask) {
          await provider.waitForTask(createTask.taskUid, 10_000);
        }
      } catch {
        // Index may already exist — continue to settings update
      }

      // Apply settings
      const meiliSettings = mapSettingsToMeilisearch(settings);
      const { data: settingsTask } = await http.patch<MeilisearchTask>(
        `/indexes/${encodeURIComponent(indexName)}/settings`,
        meiliSettings,
      );

      return mapTask(settingsTask);
    },

    async deleteIndex(indexName: string): Promise<void> {
      const { data: task } = await http.delete<MeilisearchTask>(
        `/indexes/${encodeURIComponent(indexName)}`,
      );
      if (provider.waitForTask) {
        await provider.waitForTask(task.taskUid, 10_000);
      }
    },

    async listIndexes() {
      const { data } = await http.get<{
        results: Array<{
          uid: string;
          numberOfDocuments: number;
          updatedAt: string;
        }>;
      }>('/indexes');

      return data.results.map(idx => ({
        name: idx.uid,
        documentCount: idx.numberOfDocuments,
        updatedAt: new Date(idx.updatedAt),
      }));
    },

    async getIndexSettings(indexName: string): Promise<SearchIndexSettings> {
      const { data } = await http.get<MeilisearchSettings>(
        `/indexes/${encodeURIComponent(indexName)}/settings`,
      );
      return mapMeilisearchSettingsToOurs(data);
    },

    // --- Document Operations ---

    async indexDocument(
      indexName: string,
      document: Record<string, unknown>,
      documentId: string,
    ): Promise<void> {
      const doc = { ...document, id: documentId };
      await http.post(`/indexes/${encodeURIComponent(indexName)}/documents`, [doc]);
    },

    async deleteDocument(indexName: string, documentId: string): Promise<void> {
      await http.delete(
        `/indexes/${encodeURIComponent(indexName)}/documents/${encodeURIComponent(documentId)}`,
      );
    },

    async indexDocuments(
      indexName: string,
      documents: ReadonlyArray<Record<string, unknown>>,
      primaryKey: string,
    ): Promise<SearchIndexTask> {
      const url =
        primaryKey !== 'id'
          ? `/indexes/${encodeURIComponent(indexName)}/documents?primaryKey=${encodeURIComponent(primaryKey)}`
          : `/indexes/${encodeURIComponent(indexName)}/documents`;

      const { data } = await http.post<MeilisearchTask>(url, documents);
      return mapTask(data);
    },

    async deleteDocuments(
      indexName: string,
      documentIds: ReadonlyArray<string>,
    ): Promise<SearchIndexTask> {
      const { data } = await http.post<MeilisearchTask>(
        `/indexes/${encodeURIComponent(indexName)}/documents/delete-batch`,
        documentIds,
      );
      return mapTask(data);
    },

    async clearIndex(indexName: string): Promise<SearchIndexTask> {
      const { data } = await http.delete<MeilisearchTask>(
        `/indexes/${encodeURIComponent(indexName)}/documents`,
      );
      return mapTask(data);
    },

    // --- Search ---

    async search(indexName: string, query: SearchQuery): Promise<SearchResponse> {
      const params = mapSearchQueryToMeilisearch(query);
      const { data } = await http.post<MeilisearchSearchResponse>(
        `/indexes/${encodeURIComponent(indexName)}/search`,
        params,
      );
      return mapMeilisearchResponse(data, indexName);
    },

    async multiSearch(
      queries: ReadonlyArray<{ readonly indexName: string; readonly query: SearchQuery }>,
    ): Promise<ReadonlyArray<SearchResponse>> {
      const meiliQueries = queries.map(({ indexName, query }) => ({
        indexUid: indexName,
        ...mapSearchQueryToMeilisearch(query),
      }));

      const { data } = await http.post<{
        results: MeilisearchSearchResponse[];
      }>('/multi-search', { queries: meiliQueries });

      return data.results.map((result, i) => mapMeilisearchResponse(result, queries[i].indexName));
    },

    // --- Suggest ---

    async suggest(indexName: string, query: SuggestQuery): Promise<SuggestResponse> {
      const start = performance.now();

      const params: MeilisearchSearchParams = {
        q: query.q,
        matchingStrategy: 'last',
        limit: query.limit ?? 5,
      };

      if (query.fields && query.fields.length > 0) {
        params.attributesToRetrieve = [...query.fields];
        params.attributesToHighlight = [...query.fields];
      } else {
        params.attributesToHighlight = ['*'];
      }

      if (query.filter) {
        params.filter = searchFilterToMeilisearchFilter(query.filter);
      }

      params.showRankingScore = true;

      const { data } = await http.post<MeilisearchSearchResponse>(
        `/indexes/${encodeURIComponent(indexName)}/search`,
        params,
      );

      // Convert search hits to suggestions
      const suggestions = data.hits.map(rawHit => {
        const hit = rawHit as MeilisearchHit;
        const searchableFields = query.fields ?? Object.keys(hit).filter(k => !k.startsWith('_'));
        const formatted = hit._formatted;

        // Find the best field to use as the suggestion text
        let bestField = searchableFields[0] ?? 'id';
        let bestText = stringifySearchValue(hit[bestField]);
        let bestHighlight: string | undefined;

        for (const field of searchableFields) {
          const value = hit[field];
          if (value === undefined || value === null) continue;
          const text = stringifySearchValue(value);
          if (text.toLowerCase().includes(query.q.toLowerCase())) {
            bestField = field;
            bestText = text;
            if (formatted && query.highlight) {
              bestHighlight = stringifySearchValue(formatted[field] ?? text);
            }
            break;
          }
        }

        if (!bestHighlight && formatted && query.highlight) {
          bestHighlight = stringifySearchValue(formatted[bestField] ?? bestText);
        }

        return {
          text: bestText,
          highlight: bestHighlight,
          score: hit._rankingScore,
          field: bestField,
        };
      });

      return {
        suggestions,
        processingTimeMs: Math.round(performance.now() - start),
      };
    },

    // --- Task Monitoring ---

    async getTask(taskId: string | number): Promise<SearchIndexTask> {
      const { data } = await http.get<MeilisearchTask>(`/tasks/${taskId}`);
      return mapTask(data);
    },

    async waitForTask(
      taskId: string | number,
      timeoutMs: number = 30_000,
    ): Promise<SearchIndexTask> {
      const start = Date.now();
      const pollInterval = 100;

      while (Date.now() - start < timeoutMs) {
        const { data } = await http.get<MeilisearchTask>(`/tasks/${taskId}`);

        if (data.status === 'succeeded' || data.status === 'failed' || data.status === 'canceled') {
          if (data.status === 'failed') {
            throw new Error(
              `[slingshot-search:meilisearch] Task ${taskId} failed: ${data.error?.message ?? 'unknown error'}`,
            );
          }
          return mapTask(data);
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

      throw new Error(
        `[slingshot-search:meilisearch] Task ${taskId} timed out after ${timeoutMs}ms`,
      );
    },
  };

  return provider;
}
