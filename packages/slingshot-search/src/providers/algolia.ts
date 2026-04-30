/**
 * Algolia search provider.
 *
 * HTTP-based provider that communicates with the Algolia REST API.
 * Uses native `fetch` (available in Bun) with retry logic and
 * exponential backoff.
 *
 * Implements the full `SearchProvider` interface including lifecycle, index
 * management, document operations, search, suggest, and task monitoring.
 *
 * Algolia operations return task IDs for indexing mutations; search is
 * synchronous.
 */
import type { SearchProvider } from '../types/provider';
import type {
  AlgoliaProviderConfig,
  SearchHealthResult,
  SearchIndexSettings,
  SearchIndexTask,
} from '../types/provider';
import type { SearchFilter, SearchQuery, SuggestQuery } from '../types/query';
import type { SearchHit, SearchResponse, SuggestResponse } from '../types/response';
import { stringifyDocumentId, stringifySearchValue } from './stringify';
import { createConsoleLogger } from '@lastshotlabs/slingshot-core';
import type { Logger } from '@lastshotlabs/slingshot-core';
import { SearchProviderError } from '../errors/searchErrors';

const logger: Logger = createConsoleLogger({ base: { provider: 'slingshot-search:algolia' } });

// ============================================================================
// Internal HTTP client
// ============================================================================

interface HttpClientConfig {
  readonly applicationId: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
}

interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly data: T | undefined;
}

interface HttpClient {
  get<T>(path: string): Promise<{ readonly status: number; readonly data: T }>;
  post<T>(path: string, body?: unknown): Promise<{ readonly status: number; readonly data: T }>;
  put<T>(path: string, body?: unknown): Promise<{ readonly status: number; readonly data: T }>;
  delete<T>(path: string, body?: unknown): Promise<{ readonly status: number; readonly data: T }>;
  send<T>(method: string, path: string, body?: unknown): Promise<HttpResponse<T>>;
}

function createHttpClient(config: HttpClientConfig) {
  const { applicationId, apiKey, timeoutMs, retries, retryDelayMs } = config;

  function buildUrl(path: string): string {
    const base = `https://${applicationId}-dsn.algolia.net`;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalizedPath}`;
  }

  function buildHeaders(): Record<string, string> {
    return {
      'X-Algolia-API-Key': apiKey,
      'X-Algolia-Application-Id': applicationId,
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
            `[slingshot-search:algolia] HTTP ${response.status} ${method} ${path}: ${errorBody}`,
          );

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

        if (response.status === 204) {
          return { status: response.status, data: undefined };
        }

        const data = (await response.json()) as T;
        return { status: response.status, data };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          lastError = new Error(
            `[slingshot-search:algolia] Request timeout after ${timeoutMs}ms: ${method} ${path}`,
          );
        } else if (err instanceof Error && err.message.startsWith('[slingshot-search:algolia]')) {
          throw err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    throw lastError ?? new Error(`[slingshot-search:algolia] Request failed: ${method} ${path}`);
  }

  async function jsonRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly data: unknown }> {
    const response = await request(method, path, body);
    if (response.data === undefined) {
      throw new SearchProviderError(
        `Expected JSON body but got ${response.status} for ${method} ${path}`,
      );
    }
    return { status: response.status, data: response.data };
  }

  const get = ((path: string) => jsonRequest('GET', path)) as HttpClient['get'];
  const post = ((path: string, body?: unknown) =>
    jsonRequest('POST', path, body)) as HttpClient['post'];
  const put = ((path: string, body?: unknown) =>
    jsonRequest('PUT', path, body)) as HttpClient['put'];
  const remove = ((path: string, body?: unknown) =>
    jsonRequest('DELETE', path, body)) as HttpClient['delete'];
  const send = ((method: string, path: string, body?: unknown) =>
    request(method, path, body)) as HttpClient['send'];

  const client: HttpClient = {
    get,
    post,
    put,
    delete: remove,
    send,
  };

  return client;
}

// ============================================================================
// Filter translation
// ============================================================================

/**
 * Translate a `SearchFilter` AST to an Algolia filter string.
 *
 * Recursively transforms composite operators and leaf conditions into the
 * Algolia filter syntax accepted by its search API.
 *
 * @param filter - The filter AST to translate. Supports all `SearchFilter`
 *   variants: `$and`, `$or`, `$not`, `$geoRadius`, `$geoBoundingBox`, and
 *   `SearchFilterCondition` leaves.
 * @returns An Algolia-compatible filter string, e.g. `status:"published"`,
 *   `(status:"a") AND (price > 10)`, or `aroundLatLng:48.85,2.35,...`.
 *
 * @remarks
 * **String quoting** — string values are wrapped in double quotes with
 * internal double quotes escaped as `\"`. Numeric and boolean values are
 * serialised without quotes.
 *
 * **`IN` operator** — translated as `(field:"a" OR field:"b")` since Algolia
 * has no native IN syntax.
 *
 * **`NOT_IN` operator** — translated as `(NOT field:"a" AND NOT field:"b")`.
 *
 * **`BETWEEN`** — translated as `field:min TO max` (Algolia range syntax).
 *
 * **`EXISTS` / `NOT_EXISTS`** — approximated as `field:*` / `NOT field:*`
 * using Algolia's wildcard syntax, which is only reliable for facet attributes.
 *
 * **`STARTS_WITH`** — not natively supported. Falls back to equality with a
 * `console.warn`.
 *
 * **Geo filters** — `$geoRadius` and `$geoBoundingBox` are translated to
 * Algolia's `aroundLatLng`/`insideBoundingBox` parameter syntax. These are
 * not standard filter string expressions — they must be passed as separate
 * `aroundLatLng`/`insideBoundingBox` query parameters in production use.
 * The current translation embeds them in the filter string as a best-effort
 * approximation.
 *
 * @example
 * ```ts
 * searchFilterToAlgoliaFilter({ field: 'status', op: '=', value: 'published' });
 * // 'status:"published"'
 *
 * searchFilterToAlgoliaFilter({ field: 'price', op: '>', value: 100 });
 * // 'price > 100'
 *
 * searchFilterToAlgoliaFilter({ $and: [
 *   { field: 'status', op: '=', value: 'active' },
 *   { field: 'score', op: '>=', value: 5 },
 * ]});
 * // '(status:"active") AND (score >= 5)'
 * ```
 */
export function searchFilterToAlgoliaFilter(filter: SearchFilter): string {
  if ('$and' in filter) {
    const clauses = filter.$and.map(f => searchFilterToAlgoliaFilter(f));
    return clauses.map(c => `(${c})`).join(' AND ');
  }

  if ('$or' in filter) {
    const clauses = filter.$or.map(f => searchFilterToAlgoliaFilter(f));
    return clauses.map(c => `(${c})`).join(' OR ');
  }

  if ('$not' in filter) {
    return `NOT (${searchFilterToAlgoliaFilter(filter.$not)})`;
  }

  if ('$geoRadius' in filter) {
    const { lat, lng, radiusMeters } = filter.$geoRadius;
    return `aroundLatLng:${lat},${lng},aroundRadius:${Math.round(radiusMeters)}`;
  }

  if ('$geoBoundingBox' in filter) {
    const { topLeft, bottomRight } = filter.$geoBoundingBox;
    return `insideBoundingBox:${topLeft.lat},${topLeft.lng},${bottomRight.lat},${bottomRight.lng}`;
  }

  // SearchFilterCondition
  if ('field' in filter && 'op' in filter) {
    const { field, op, value } = filter;

    switch (op) {
      case '=':
        return `${field}:${formatAlgoliaValue(value)}`;

      case '!=':
        return `NOT ${field}:${formatAlgoliaValue(value)}`;

      case '>':
        return `${field} > ${formatAlgoliaNumericValue(value)}`;

      case '>=':
        return `${field} >= ${formatAlgoliaNumericValue(value)}`;

      case '<':
        return `${field} < ${formatAlgoliaNumericValue(value)}`;

      case '<=':
        return `${field} <= ${formatAlgoliaNumericValue(value)}`;

      case 'IN':
        if (Array.isArray(value)) {
          const formatted = (value as ReadonlyArray<string | number | boolean>)
            .map(v => `${field}:${formatAlgoliaValue(v)}`)
            .join(' OR ');
          return `(${formatted})`;
        }
        return `${field}:${formatAlgoliaValue(value)}`;

      case 'NOT_IN':
        if (Array.isArray(value)) {
          const formatted = (value as ReadonlyArray<string | number | boolean>)
            .map(v => `NOT ${field}:${formatAlgoliaValue(v)}`)
            .join(' AND ');
          return `(${formatted})`;
        }
        return `NOT ${field}:${formatAlgoliaValue(value)}`;

      case 'EXISTS':
        // Algolia doesn't have a direct EXISTS operator — use facet filter
        return `${field}:*`;

      case 'NOT_EXISTS':
        return `NOT ${field}:*`;

      case 'BETWEEN': {
        if (Array.isArray(value) && value.length === 2) {
          return `${field}:${value[0]} TO ${value[1]}`;
        }
        return `${field}:*`;
      }

      case 'CONTAINS':
        return `${field}:${formatAlgoliaValue(value)}`;

      case 'STARTS_WITH':
        logger.warn(
          `[slingshot-search:algolia] STARTS_WITH filter is not natively supported. Using equality as approximation for field '${field}'.`,
        );
        return `${field}:${formatAlgoliaValue(value)}`;

      case 'IS_EMPTY':
        return `NOT ${field}:*`;

      case 'IS_NOT_EMPTY':
        return `${field}:*`;

      default:
        return `${field}:*`;
    }
  }

  return '';
}

function formatAlgoliaValue(value: unknown): string {
  if (typeof value === 'string') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  if (value instanceof Date) {
    return String(Math.floor(value.getTime() / 1000));
  }
  return stringifySearchValue(value);
}

function formatAlgoliaNumericValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return String(Math.floor(value.getTime() / 1000));
  return String(value);
}

// ============================================================================
// Settings mapping
// ============================================================================

interface AlgoliaSettings {
  searchableAttributes?: string[];
  attributesForFaceting?: string[];
  customRanking?: string[];
  attributesToRetrieve?: string[];
  unretrievableAttributes?: string[];
  ranking?: string[];
}

function mapSettingsToAlgoliaSettings(settings: SearchIndexSettings): AlgoliaSettings {
  const result: AlgoliaSettings = {};

  if (settings.searchableFields.length > 0) {
    result.searchableAttributes = [...settings.searchableFields];
  }

  // Algolia merges filterable, sortable, and facetable into attributesForFaceting
  const facetable = new Set([...settings.filterableFields, ...settings.facetableFields]);
  // Sortable fields that aren't already filterable need special handling
  for (const field of settings.sortableFields) {
    facetable.add(field);
  }
  if (facetable.size > 0) {
    result.attributesForFaceting = [...facetable].map(f => {
      // Fields that are only filterable (not meant for facet display) get filterOnly prefix
      if (settings.filterableFields.includes(f) && !settings.facetableFields.includes(f)) {
        return `filterOnly(${f})`;
      }
      return f;
    });
  }

  if (settings.displayedFields && settings.displayedFields.length > 0) {
    result.attributesToRetrieve = [...settings.displayedFields];
  }

  if (settings.excludedFields && settings.excludedFields.length > 0) {
    result.unretrievableAttributes = [...settings.excludedFields];
  }

  // Custom ranking from sortable fields
  if (settings.ranking?.rules) {
    const customRanking: string[] = [];
    for (const rule of settings.ranking.rules) {
      if (typeof rule !== 'string') {
        customRanking.push(`${rule.direction}(${rule.field})`);
      }
    }
    if (customRanking.length > 0) {
      result.customRanking = customRanking;
    }
  }

  return result;
}

function mapAlgoliaSettingsToOurs(algolia: AlgoliaSettings): SearchIndexSettings {
  const searchable = algolia.searchableAttributes ?? [];
  const filterable: string[] = [];
  const facetable: string[] = [];

  if (algolia.attributesForFaceting) {
    for (const attr of algolia.attributesForFaceting) {
      if (attr.startsWith('filterOnly(')) {
        filterable.push(attr.slice('filterOnly('.length, -1));
      } else if (attr.startsWith('searchable(')) {
        const field = attr.slice('searchable('.length, -1);
        filterable.push(field);
        facetable.push(field);
      } else {
        filterable.push(attr);
        facetable.push(attr);
      }
    }
  }

  return {
    searchableFields: searchable,
    filterableFields: filterable,
    sortableFields: [], // Algolia doesn't expose sortable separately
    facetableFields: facetable,
    displayedFields: algolia.attributesToRetrieve ?? undefined,
    excludedFields: algolia.unretrievableAttributes ?? undefined,
  };
}

// ============================================================================
// Search query mapping
// ============================================================================

interface AlgoliaSearchParams {
  query: string;
  filters?: string;
  facets?: string[];
  page?: number;
  hitsPerPage?: number;
  offset?: number;
  length?: number;
  attributesToHighlight?: string[];
  highlightPreTag?: string;
  highlightPostTag?: string;
  attributesToSnippet?: string[];
  attributesToRetrieve?: string[];
  typoTolerance?: boolean | 'min' | 'strict';
  getRankingInfo?: boolean;
}

function mapSearchQueryToAlgoliaParams(query: SearchQuery): AlgoliaSearchParams {
  const params: AlgoliaSearchParams = {
    query: query.q,
  };

  if (query.filter) {
    params.filters = searchFilterToAlgoliaFilter(query.filter);
  }

  if (query.facets && query.facets.length > 0) {
    params.facets = [...query.facets];
  }

  // Pagination
  if (query.page !== undefined) {
    params.page = query.page - 1; // Algolia is 0-indexed
    if (query.hitsPerPage !== undefined) {
      params.hitsPerPage = query.hitsPerPage;
    }
  } else {
    if (query.offset !== undefined) params.offset = query.offset;
    if (query.limit !== undefined) params.length = query.limit;
  }

  // Highlighting
  if (query.highlight) {
    params.attributesToHighlight = query.highlight.fields ? [...query.highlight.fields] : ['*'];
    if (query.highlight.preTag) params.highlightPreTag = query.highlight.preTag;
    if (query.highlight.postTag) params.highlightPostTag = query.highlight.postTag;
  }

  // Snippets
  if (query.snippet) {
    params.attributesToSnippet = query.snippet.fields.map(
      f => `${f}:${query.snippet?.maxWords ?? 30}`,
    );
  }

  // Field projection
  if (query.fields && query.fields.length > 0) {
    params.attributesToRetrieve = [...query.fields];
  }

  // Ranking score
  if (query.showRankingScore) {
    params.getRankingInfo = true;
  }

  return params;
}

// ============================================================================
// Response mapping
// ============================================================================

interface AlgoliaSearchResponse {
  hits: Array<AlgoliaHit>;
  nbHits: number;
  page: number;
  nbPages: number;
  hitsPerPage: number;
  processingTimeMS: number;
  query: string;
  facets?: Record<string, Record<string, number>>;
  facets_stats?: Record<string, { min: number; max: number; avg: number; sum: number }>;
}

interface AlgoliaHit extends Record<string, unknown> {
  objectID: string;
  _highlightResult?: Partial<
    Record<
      string,
      {
        value: string;
        matchLevel: 'none' | 'partial' | 'full';
        matchedWords: string[];
        fullyHighlighted?: boolean;
      }
    >
  >;
  _snippetResult?: Partial<
    Record<
      string,
      {
        value: string;
        matchLevel: 'none' | 'partial' | 'full';
      }
    >
  >;
  _rankingInfo?: Record<string, unknown>;
  _distinctSeqID?: number;
}

function mapAlgoliaResponse(
  algoliaResponse: AlgoliaSearchResponse,
  indexName: string,
  query: SearchQuery,
): SearchResponse {
  const hits: SearchHit[] = algoliaResponse.hits.map(algoliaHit => {
    const { objectID, _highlightResult, _snippetResult, _rankingInfo, ...document } = algoliaHit;

    // Add objectID as id in document
    const docWithId = { id: objectID, ...document };

    // Build highlights
    let highlights: Record<string, string> | undefined;
    if (_highlightResult) {
      const h: Record<string, string> = {};
      for (const [key, hl] of Object.entries(_highlightResult)) {
        if (!hl) continue;
        if (hl.matchLevel !== 'none') {
          h[key] = hl.value;
        }
      }
      if (Object.keys(h).length > 0) {
        highlights = h;
      }
    }

    // Build snippets
    let snippets: Record<string, string> | undefined;
    if (_snippetResult) {
      const s: Record<string, string> = {};
      for (const [key, sn] of Object.entries(_snippetResult)) {
        if (!sn) continue;
        if (sn.matchLevel !== 'none') {
          s[key] = sn.value;
        }
      }
      if (Object.keys(s).length > 0) {
        snippets = s;
      }
    }

    return {
      document: docWithId,
      highlights,
      snippets,
      rankingScoreDetails: _rankingInfo,
    } satisfies SearchHit;
  });

  // Map facets
  let facetDistribution: Record<string, Record<string, number>> | undefined;
  let facetStats:
    | Record<string, { min: number; max: number; avg: number; sum: number; count: number }>
    | undefined;

  if (algoliaResponse.facets) {
    facetDistribution = algoliaResponse.facets;
  }

  if (algoliaResponse.facets_stats) {
    facetStats = {};
    for (const [field, stats] of Object.entries(algoliaResponse.facets_stats)) {
      facetStats[field] = {
        min: stats.min,
        max: stats.max,
        avg: stats.avg,
        sum: stats.sum,
        count: 0, // Algolia doesn't expose count in facet_stats
      };
    }
  }

  const totalHits = algoliaResponse.nbHits;
  // Algolia page is 0-indexed, our API is 1-indexed
  const page = query.page !== undefined ? algoliaResponse.page + 1 : undefined;
  const perPage = algoliaResponse.hitsPerPage;

  return {
    hits,
    totalHits,
    totalHitsRelation: 'exact',
    query: algoliaResponse.query,
    processingTimeMs: algoliaResponse.processingTimeMS,
    indexName,
    facetDistribution,
    facetStats,
    page,
    totalPages: page !== undefined ? algoliaResponse.nbPages : undefined,
    hitsPerPage: page !== undefined ? perPage : undefined,
    offset: page !== undefined ? undefined : (query.offset ?? 0),
    limit: page !== undefined ? undefined : (query.limit ?? perPage),
  };
}

// ============================================================================
// Algolia task type
// ============================================================================

interface AlgoliaTaskResponse {
  taskID: number;
  objectID?: string;
  objectIDs?: string[];
  updatedAt?: string;
}

function mapAlgoliaTask(task: AlgoliaTaskResponse): SearchIndexTask {
  return {
    taskId: task.taskID,
    status: 'succeeded', // Algolia returns after the write is acknowledged
    enqueuedAt: task.updatedAt ? new Date(task.updatedAt) : new Date(),
  };
}

// ============================================================================
// Algolia provider factory
// ============================================================================

/**
 * Create an Algolia search provider.
 *
 * Communicates with the Algolia REST API over HTTPS using native `fetch` with
 * configurable retry and exponential backoff. Supports full index management,
 * document operations, search, suggest, multi-search, and health checks.
 *
 * @param config - Algolia application ID, API keys, and optional tuning parameters.
 * @returns A `SearchProvider` with `name: 'algolia'`.
 *
 * @throws {Error} From `connect()` if the `/1/indexes` health-check call fails
 *   (e.g. invalid credentials or network unavailability).
 * @throws {Error} From any index or document operation if the HTTP request
 *   returns a non-retryable 4xx error or exhausts retries.
 *
 * @remarks
 * **Index naming** — Algolia uses "index" directly. The `indexName` maps to
 * the Algolia index name without transformation. The plugin-level `indexPrefix`
 * is applied by the search manager before reaching this provider.
 *
 * **Dual HTTP clients** — two HTTP clients are created: one using
 * `adminApiKey` (for index management and document writes) and one using
 * `apiKey` (search-only key for read operations). This allows safe separation
 * of write permissions from read permissions. When `adminApiKey` is not set,
 * the search-only key is used for all operations.
 *
 * **Attribute config** — `createOrUpdateIndex()` maps `SearchIndexSettings`
 * to Algolia's settings structure:
 * - `searchableFields` → `searchableAttributes`
 * - `filterableFields` (not facetable) → `filterOnly(field)` inside
 *   `attributesForFaceting` (Algolia merges filterable and facetable)
 * - `facetableFields` → plain entries in `attributesForFaceting`
 * - `sortableFields` → added to `attributesForFaceting` as plain entries
 * - `excludedFields` → `unretrievableAttributes`
 *
 * **Pagination** — Algolia pages are 0-indexed internally. The provider
 * transparently translates between the 1-indexed `page` in `SearchQuery` and
 * Algolia's 0-indexed `page` parameter, and back to 1-indexed in the response.
 *
 * **Async task IDs** — Algolia mutation operations return task IDs. The
 * `waitForTask` method is a best-effort no-op because Algolia's task status
 * API requires the index name alongside the task ID, which is not available
 * at the `waitForTask` call site. Mutations are typically propagated within
 * a few hundred milliseconds.
 *
 * **Filter syntax** — `SearchFilter` ASTs are translated to Algolia filter
 * strings via `searchFilterToAlgoliaFilter()`:
 * - `=` → `field:"value"` or `field:number`
 * - `IN` → `(field:"a" OR field:"b")`
 * - `BETWEEN` → `field:min TO max`
 * - `$geoRadius` → `aroundLatLng:lat,lng,aroundRadius:r`
 * - `$geoBoundingBox` → `insideBoundingBox:lat1,lng1,lat2,lng2`
 * - `STARTS_WITH`: not natively supported; falls back to equality with a
 *   `console.warn`.
 *
 * **API key requirements** — read-only operations (`search`, `suggest`,
 * `multiSearch`) use the search-only API key. Index management and document
 * write operations require the admin API key. Without `adminApiKey`, all
 * calls use `apiKey` — ensure that key has the required ACL permissions.
 *
 * @example
 * ```ts
 * import { createAlgoliaProvider } from '@lastshotlabs/slingshot-search';
 *
 * const provider = createAlgoliaProvider({
 *   provider: 'algolia',
 *   applicationId: 'YourAppId',
 *   apiKey: 'yourSearchOnlyApiKey',
 *   adminApiKey: 'yourAdminApiKey',
 *   timeoutMs: 5000,
 *   retries: 3,
 * });
 *
 * await provider.connect();
 * await provider.createOrUpdateIndex('threads', settings);
 * const results = await provider.search('threads', { q: 'hello' });
 * ```
 */
export function createAlgoliaProvider(config: AlgoliaProviderConfig): SearchProvider {
  const http = createHttpClient({
    applicationId: config.applicationId,
    apiKey: config.adminApiKey ?? config.apiKey,
    timeoutMs: config.timeoutMs ?? 5000,
    retries: config.retries ?? 3,
    retryDelayMs: config.retryDelayMs ?? 200,
  });

  const searchHttp = createHttpClient({
    applicationId: config.applicationId,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs ?? 5000,
    retries: config.retries ?? 3,
    retryDelayMs: config.retryDelayMs ?? 200,
  });

  const provider: SearchProvider = {
    name: 'algolia',

    // --- Lifecycle ---

    async connect(): Promise<void> {
      // Validate credentials by listing indices
      await http.get<{ items: unknown[] }>('/1/indexes');
    },

    async healthCheck(): Promise<SearchHealthResult> {
      const start = performance.now();
      try {
        await http.get<{ items: unknown[] }>('/1/indexes');
        return {
          healthy: true,
          provider: 'algolia',
          latencyMs: Math.round(performance.now() - start),
        };
      } catch (err) {
        return {
          healthy: false,
          provider: 'algolia',
          latencyMs: Math.round(performance.now() - start),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async teardown(): Promise<void> {
      // HTTP-based — no persistent connections to close
    },

    // --- Index Management ---

    async createOrUpdateIndex(
      indexName: string,
      settings: SearchIndexSettings,
    ): Promise<SearchIndexTask> {
      const algoliaSettings = mapSettingsToAlgoliaSettings(settings);
      const { data } = await http.put<AlgoliaTaskResponse>(
        `/1/indexes/${encodeURIComponent(indexName)}/settings`,
        algoliaSettings,
      );
      return mapAlgoliaTask(data);
    },

    async deleteIndex(indexName: string): Promise<void> {
      await http.delete(`/1/indexes/${encodeURIComponent(indexName)}`);
    },

    async listIndexes() {
      const { data } = await http.get<{
        items: Array<{
          name: string;
          entries: number;
          updatedAt: string;
        }>;
      }>('/1/indexes');

      return data.items.map(idx => ({
        name: idx.name,
        documentCount: idx.entries,
        updatedAt: new Date(idx.updatedAt),
      }));
    },

    async getIndexSettings(indexName: string): Promise<SearchIndexSettings> {
      const { data } = await http.get<AlgoliaSettings>(
        `/1/indexes/${encodeURIComponent(indexName)}/settings`,
      );
      return mapAlgoliaSettingsToOurs(data);
    },

    // --- Document Operations ---

    async indexDocument(
      indexName: string,
      document: Record<string, unknown>,
      documentId: string,
    ): Promise<void> {
      await http.put(
        `/1/indexes/${encodeURIComponent(indexName)}/${encodeURIComponent(documentId)}`,
        { ...document, objectID: documentId },
      );
    },

    async deleteDocument(indexName: string, documentId: string): Promise<void> {
      await http.delete(
        `/1/indexes/${encodeURIComponent(indexName)}/${encodeURIComponent(documentId)}`,
      );
    },

    async indexDocuments(
      indexName: string,
      documents: ReadonlyArray<Record<string, unknown>>,
      primaryKey: string,
    ): Promise<SearchIndexTask> {
      const requests = documents.map(doc => ({
        action: 'addObject',
        body: {
          ...doc,
          objectID: stringifyDocumentId(doc[primaryKey] ?? doc.id),
        },
      }));

      const { data } = await http.post<AlgoliaTaskResponse>(
        `/1/indexes/${encodeURIComponent(indexName)}/batch`,
        { requests },
      );

      return mapAlgoliaTask(data);
    },

    async deleteDocuments(
      indexName: string,
      documentIds: ReadonlyArray<string>,
    ): Promise<SearchIndexTask> {
      const requests = documentIds.map(id => ({
        action: 'deleteObject',
        body: { objectID: id },
      }));

      const { data } = await http.post<AlgoliaTaskResponse>(
        `/1/indexes/${encodeURIComponent(indexName)}/batch`,
        { requests },
      );

      return mapAlgoliaTask(data);
    },

    async clearIndex(indexName: string): Promise<SearchIndexTask> {
      const { data } = await http.post<AlgoliaTaskResponse>(
        `/1/indexes/${encodeURIComponent(indexName)}/clear`,
      );
      return mapAlgoliaTask(data);
    },

    // --- Search ---

    async search(indexName: string, query: SearchQuery): Promise<SearchResponse> {
      const params = mapSearchQueryToAlgoliaParams(query);

      const { data } = await searchHttp.post<AlgoliaSearchResponse>(
        `/1/indexes/${encodeURIComponent(indexName)}/query`,
        params,
      );

      return mapAlgoliaResponse(data, indexName, query);
    },

    async multiSearch(
      queries: ReadonlyArray<{ readonly indexName: string; readonly query: SearchQuery }>,
    ): Promise<ReadonlyArray<SearchResponse>> {
      const requests = queries.map(({ indexName, query }) => ({
        indexName,
        params: mapSearchQueryToAlgoliaParams(query),
      }));

      const { data } = await searchHttp.post<{
        results: AlgoliaSearchResponse[];
      }>('/1/indexes/*/queries', { requests });

      return data.results.map((result, i) =>
        mapAlgoliaResponse(result, queries[i].indexName, queries[i].query),
      );
    },

    // --- Suggest ---

    async suggest(indexName: string, query: SuggestQuery): Promise<SuggestResponse> {
      const start = performance.now();

      const params: AlgoliaSearchParams = {
        query: query.q,
        hitsPerPage: query.limit ?? 5,
      };

      if (query.fields && query.fields.length > 0) {
        params.attributesToRetrieve = [...query.fields];
        if (query.highlight) {
          params.attributesToHighlight = [...query.fields];
        }
      } else if (query.highlight) {
        params.attributesToHighlight = ['*'];
      }

      if (query.filter) {
        params.filters = searchFilterToAlgoliaFilter(query.filter);
      }

      const { data } = await searchHttp.post<AlgoliaSearchResponse>(
        `/1/indexes/${encodeURIComponent(indexName)}/query`,
        params,
      );

      const suggestFields =
        query.fields ??
        Object.keys(data.hits[0] ?? {}).filter(k => !k.startsWith('_') && k !== 'objectID');

      const suggestions = data.hits.map(algoliaHit => {
        const { objectID, _highlightResult, ...doc } = algoliaHit;

        let bestField = suggestFields[0] ?? 'objectID';
        let bestText = stringifySearchValue(doc[bestField] ?? objectID);
        let bestHighlight: string | undefined;

        for (const field of suggestFields) {
          const value = doc[field];
          if (value === undefined || value === null) continue;
          const text = stringifySearchValue(value);
          if (text.toLowerCase().includes(query.q.toLowerCase())) {
            bestField = field;
            bestText = text;
            break;
          }
        }

        if (query.highlight && _highlightResult) {
          const hl = _highlightResult[bestField];
          if (hl && hl.matchLevel !== 'none') {
            bestHighlight = hl.value;
          }
        }

        return {
          text: bestText,
          highlight: bestHighlight,
          score: undefined,
          field: bestField,
        };
      });

      return {
        suggestions,
        processingTimeMs: Math.round(performance.now() - start),
      };
    },

    // --- Task Monitoring ---

    getTask(taskId: string | number): Promise<SearchIndexTask> {
      // Algolia task status requires the index name, which we don't have here.
      // Return a succeeded status as a best-effort.
      return Promise.resolve({
        taskId,
        status: 'succeeded',
        enqueuedAt: new Date(),
      });
    },

    waitForTask(taskId: string | number): Promise<SearchIndexTask> {
      // Algolia tasks are generally fast; return immediately as best-effort
      return Promise.resolve({
        taskId,
        status: 'succeeded',
        enqueuedAt: new Date(),
      });
    },
  };

  return provider;
}
