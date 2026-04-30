/**
 * Elasticsearch search provider.
 *
 * HTTP-based provider that communicates with an Elasticsearch cluster via its
 * REST API. Uses native `fetch` (available in Bun) with retry logic and
 * exponential backoff.
 *
 * Implements the full `SearchProvider` interface including lifecycle, index
 * management, document operations, search, suggest, and task monitoring.
 *
 * Elasticsearch operations are synchronous for most document/search APIs,
 * so `waitForTask` is a no-op.
 */
import type { SearchProvider } from '../types/provider';
import type {
  ElasticsearchProviderConfig,
  SearchHealthResult,
  SearchIndexSettings,
  SearchIndexTask,
} from '../types/provider';
import type { SearchFilter, SearchQuery, SearchSort, SuggestQuery } from '../types/query';
import type { SearchHit, SearchResponse, SuggestResponse } from '../types/response';
import { stringifyDocumentId, stringifySearchValue } from './stringify';
import { SearchProviderError } from '../errors/searchErrors';

// ============================================================================
// Internal HTTP client
// ============================================================================

interface HttpClientConfig {
  readonly baseUrl: string;
  readonly auth?:
    | { readonly username: string; readonly password: string }
    | { readonly bearer: string };
  readonly apiKey?: string;
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
  post<T>(
    path: string,
    body?: unknown,
    options?: { contentType?: string; rawBody?: string },
  ): Promise<{ readonly status: number; readonly data: T }>;
  put<T>(path: string, body?: unknown): Promise<{ readonly status: number; readonly data: T }>;
  delete<T>(path: string, body?: unknown): Promise<{ readonly status: number; readonly data: T }>;
  head(path: string): Promise<{ status: number }>;
  send<T>(method: string, path: string, body?: unknown): Promise<HttpResponse<T>>;
}

function createHttpClient(config: HttpClientConfig) {
  const { baseUrl, auth, apiKey, timeoutMs, retries, retryDelayMs } = config;

  function buildUrl(path: string): string {
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalizedPath}`;
  }

  function buildHeaders(contentType = 'application/json'): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };

    if (auth) {
      if ('bearer' in auth) {
        headers.Authorization = `Bearer ${auth.bearer}`;
      } else {
        const encoded = btoa(`${auth.username}:${auth.password}`);
        headers.Authorization = `Basic ${encoded}`;
      }
    } else if (apiKey) {
      headers.Authorization = `ApiKey ${apiKey}`;
    }

    return headers;
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { contentType?: string; rawBody?: string },
  ): Promise<HttpResponse<T>> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const delay = retryDelayMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      try {
        const contentType = options?.contentType ?? 'application/json';
        const requestBody =
          options?.rawBody !== undefined
            ? options.rawBody
            : body !== undefined
              ? JSON.stringify(body)
              : undefined;

        const response = await fetch(buildUrl(path), {
          method,
          headers: buildHeaders(contentType),
          body: requestBody,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          const error = new Error(
            `[slingshot-search:elasticsearch] HTTP ${response.status} ${method} ${path}: ${errorBody}`,
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
            `[slingshot-search:elasticsearch] Request timeout after ${timeoutMs}ms: ${method} ${path}`,
          );
        } else if (
          err instanceof Error &&
          err.message.startsWith('[slingshot-search:elasticsearch]')
        ) {
          throw err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    throw (
      lastError ?? new Error(`[slingshot-search:elasticsearch] Request failed: ${method} ${path}`)
    );
  }

  async function jsonRequest(
    method: string,
    path: string,
    body?: unknown,
    options?: { contentType?: string; rawBody?: string },
  ): Promise<{ readonly status: number; readonly data: unknown }> {
    const response = await request(method, path, body, options);
    if (response.data === undefined) {
      throw new SearchProviderError(
        `Expected JSON body but got ${response.status} for ${method} ${path}`,
      );
    }
    return { status: response.status, data: response.data };
  }

  const get = ((path: string) => jsonRequest('GET', path)) as HttpClient['get'];
  const post = ((
    path: string,
    body?: unknown,
    options?: { contentType?: string; rawBody?: string },
  ) => jsonRequest('POST', path, body, options)) as HttpClient['post'];
  const put = ((path: string, body?: unknown) =>
    jsonRequest('PUT', path, body)) as HttpClient['put'];
  const remove = ((path: string, body?: unknown) =>
    jsonRequest('DELETE', path, body)) as HttpClient['delete'];
  const head = async (path: string): Promise<{ status: number }> => {
    const response = await request<unknown>('HEAD', path);
    return { status: response.status };
  };
  const send = ((method: string, path: string, body?: unknown) =>
    request(method, path, body)) as HttpClient['send'];

  const client: HttpClient = {
    get,
    post,
    put,
    delete: remove,
    head,
    send,
  };

  return client;
}

function asFilterArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [value];
}

// ============================================================================
// Filter translation
// ============================================================================

/**
 * Translate a `SearchFilter` AST to an Elasticsearch query DSL clause.
 *
 * The returned object is a complete Elasticsearch query clause suitable for
 * use as the value of `query` in a search body, or nested inside a `bool`
 * filter context.
 *
 * @param filter - The filter AST to translate. Supports all `SearchFilter`
 *   variants: `$and`, `$or`, `$not`, `$geoRadius`, `$geoBoundingBox`, and
 *   `SearchFilterCondition` leaves.
 * @returns An Elasticsearch query DSL object (e.g. `{ term: { field: value } }`).
 *
 * @remarks
 * **Operator mapping:**
 * | SearchFilter op | ES clause |
 * |---|---|
 * | `=` | `term` |
 * | `!=` | `bool.must_not[term]` |
 * | `>` / `>=` / `<` / `<=` | `range` with `gt`/`gte`/`lt`/`lte` |
 * | `IN` | `terms` |
 * | `NOT_IN` | `bool.must_not[terms]` |
 * | `EXISTS` | `exists` |
 * | `NOT_EXISTS` | `bool.must_not[exists]` |
 * | `BETWEEN` | `range` with `gte` and `lte` |
 * | `CONTAINS` | `match` (analyzed full-text, not strict substring) |
 * | `STARTS_WITH` | `prefix` |
 * | `IS_EMPTY` | `bool.should[term:'', must_not[exists]]` |
 * | `IS_NOT_EMPTY` | `bool.must[exists], must_not[term:'']` |
 * | `$geoRadius` | `geo_distance` on `_geo` using `lat`/`lon` |
 * | `$geoBoundingBox` | `geo_bounding_box` on `_geo` using `lat`/`lon` |
 *
 * **`Date` coercion** — `Date` values are serialised to ISO 8601 strings via
 * `toISOString()`, which Elasticsearch's date field mapping handles natively.
 *
 * **Fallback** — unknown operator values return `{ exists: { field } }` as
 * a safe no-op.
 *
 * @example
 * ```ts
 * searchFilterToElasticsearchQuery({ field: 'status', op: '=', value: 'published' });
 * // { term: { status: 'published' } }
 *
 * searchFilterToElasticsearchQuery({ $and: [
 *   { field: 'price', op: '>=', value: 10 },
 *   { field: 'price', op: '<=', value: 100 },
 * ]});
 * // { bool: { filter: [{ range: { price: { gte: 10 } } }, { range: { price: { lte: 100 } } }] } }
 *
 * searchFilterToElasticsearchQuery({ $geoRadius: { lat: 48.85, lng: 2.35, radiusMeters: 1000 } });
 * // { geo_distance: { distance: '1000m', _geo: { lat: 48.85, lon: 2.35 } } }
 * ```
 */
export function searchFilterToElasticsearchQuery(filter: SearchFilter): Record<string, unknown> {
  if ('$and' in filter) {
    return {
      bool: {
        filter: filter.$and.map(f => searchFilterToElasticsearchQuery(f)),
      },
    };
  }

  if ('$or' in filter) {
    return {
      bool: {
        should: filter.$or.map(f => searchFilterToElasticsearchQuery(f)),
        minimum_should_match: 1,
      },
    };
  }

  if ('$not' in filter) {
    return {
      bool: {
        must_not: [searchFilterToElasticsearchQuery(filter.$not)],
      },
    };
  }

  if ('$geoRadius' in filter) {
    const { lat, lng, radiusMeters } = filter.$geoRadius;
    return {
      geo_distance: {
        distance: `${radiusMeters}m`,
        _geo: { lat, lon: lng },
      },
    };
  }

  if ('$geoBoundingBox' in filter) {
    const { topLeft, bottomRight } = filter.$geoBoundingBox;
    return {
      geo_bounding_box: {
        _geo: {
          top_left: { lat: topLeft.lat, lon: topLeft.lng },
          bottom_right: { lat: bottomRight.lat, lon: bottomRight.lng },
        },
      },
    };
  }

  // SearchFilterCondition
  if ('field' in filter && 'op' in filter) {
    const { field, op, value } = filter;

    switch (op) {
      case '=':
        return { term: { [field]: formatEsValue(value) } };

      case '!=':
        return { bool: { must_not: [{ term: { [field]: formatEsValue(value) } }] } };

      case '>':
        return { range: { [field]: { gt: formatEsValue(value) } } };

      case '>=':
        return { range: { [field]: { gte: formatEsValue(value) } } };

      case '<':
        return { range: { [field]: { lt: formatEsValue(value) } } };

      case '<=':
        return { range: { [field]: { lte: formatEsValue(value) } } };

      case 'IN':
        return { terms: { [field]: asFilterArray(value).map(formatEsValue) } };

      case 'NOT_IN':
        return {
          bool: {
            must_not: [{ terms: { [field]: asFilterArray(value).map(formatEsValue) } }],
          },
        };

      case 'EXISTS':
        return { exists: { field } };

      case 'NOT_EXISTS':
        return { bool: { must_not: [{ exists: { field } }] } };

      case 'BETWEEN': {
        if (Array.isArray(value) && value.length === 2) {
          const min: unknown = value[0];
          const max: unknown = value[1];
          return { range: { [field]: { gte: min, lte: max } } };
        }
        return { exists: { field } };
      }

      case 'CONTAINS':
        return { match: { [field]: formatEsValue(value) } };

      case 'STARTS_WITH':
        return { prefix: { [field]: formatEsValue(value) } };

      case 'IS_EMPTY':
        return {
          bool: {
            should: [{ term: { [field]: '' } }, { bool: { must_not: [{ exists: { field } }] } }],
            minimum_should_match: 1,
          },
        };

      case 'IS_NOT_EMPTY':
        return {
          bool: {
            must: [{ exists: { field } }],
            must_not: [{ term: { [field]: '' } }],
          },
        };

      default:
        return { exists: { field } };
    }
  }

  return { match_all: {} };
}

function formatEsValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

// ============================================================================
// Sort translation
// ============================================================================

function mapSortToElasticsearch(sort: SearchSort): Record<string, unknown> {
  if ('geoPoint' in sort) {
    return {
      _geo_distance: {
        _geo: { lat: sort.geoPoint.lat, lon: sort.geoPoint.lng },
        order: sort.direction,
        unit: 'm',
      },
    };
  }
  return { [sort.field]: { order: sort.direction } };
}

// ============================================================================
// Settings mapping
// ============================================================================

interface ElasticsearchIndexMapping {
  mappings?: {
    properties?: Record<
      string,
      { type?: string; index?: boolean; fields?: Record<string, unknown> }
    >;
  };
  settings?: {
    index?: Record<string, unknown>;
    analysis?: Record<string, unknown>;
  };
}

function mapSettingsToElasticsearchMapping(
  settings: SearchIndexSettings,
): ElasticsearchIndexMapping {
  const properties: Record<string, Record<string, unknown>> = {};

  // All known fields from searchable, filterable, sortable, facetable
  const allFields = new Set([
    ...settings.searchableFields,
    ...settings.filterableFields,
    ...settings.sortableFields,
    ...settings.facetableFields,
  ]);

  const searchableSet = new Set(settings.searchableFields);

  for (const field of allFields) {
    if (searchableSet.has(field)) {
      // Text field with keyword sub-field for exact matching/sorting
      properties[field] = {
        type: 'text',
        fields: {
          keyword: {
            type: 'keyword',
            ignore_above: 256,
          },
        },
      };
    } else {
      // Keyword field for filtering/sorting
      properties[field] = {
        type: 'keyword',
      };
    }
  }

  // Add primary key
  if (settings.primaryKey && !(settings.primaryKey in properties)) {
    properties[settings.primaryKey] = { type: 'keyword' };
  }

  return {
    mappings: { properties },
    settings: {
      index: {
        number_of_shards: 1,
        number_of_replicas: 0,
      },
    },
  };
}

function mapElasticsearchMappingToSettings(
  mapping: ElasticsearchIndexMapping,
): SearchIndexSettings {
  const searchable: string[] = [];
  const filterable: string[] = [];
  const sortable: string[] = [];
  const facetable: string[] = [];

  const properties = mapping.mappings?.properties ?? {};

  for (const [field, config] of Object.entries(properties)) {
    if (config.type === 'text') {
      searchable.push(field);
      // Text fields with keyword sub-field are also filterable/sortable
      if (config.fields && 'keyword' in config.fields) {
        filterable.push(field);
        sortable.push(field);
      }
    } else if (config.type === 'keyword') {
      filterable.push(field);
      sortable.push(field);
    } else if (
      config.type === 'integer' ||
      config.type === 'long' ||
      config.type === 'float' ||
      config.type === 'double' ||
      config.type === 'date'
    ) {
      filterable.push(field);
      sortable.push(field);
    }
  }

  return {
    searchableFields: searchable,
    filterableFields: filterable,
    sortableFields: sortable,
    facetableFields: facetable,
  };
}

// ============================================================================
// Search query mapping
// ============================================================================

function buildElasticsearchQuery(
  query: SearchQuery,
  searchableFields: ReadonlyArray<string>,
): Record<string, unknown> {
  const esQuery: Record<string, unknown> = {};
  const boolClauses: { must?: unknown[]; filter?: unknown[] } = {};

  // Full-text search
  if (query.q && query.q.trim() !== '') {
    const fields = searchableFields.length > 0 ? [...searchableFields] : ['*'];
    if (!boolClauses.must) boolClauses.must = [];
    boolClauses.must.push({
      multi_match: {
        query: query.q,
        fields,
        type: 'best_fields',
        operator: query.matchingStrategy === 'all' ? 'and' : 'or',
      },
    });
  } else {
    if (!boolClauses.must) boolClauses.must = [];
    boolClauses.must.push({ match_all: {} });
  }

  // Filters
  if (query.filter) {
    if (!boolClauses.filter) boolClauses.filter = [];
    boolClauses.filter.push(searchFilterToElasticsearchQuery(query.filter));
  }

  esQuery.query = { bool: boolClauses };

  // Sort
  if (query.sort && query.sort.length > 0) {
    esQuery.sort = query.sort.map(mapSortToElasticsearch);
  }

  // Pagination
  if (query.page !== undefined) {
    const perPage = query.hitsPerPage ?? 20;
    esQuery.from = (query.page - 1) * perPage;
    esQuery.size = perPage;
  } else {
    if (query.offset !== undefined) esQuery.from = query.offset;
    esQuery.size = query.limit ?? 20;
  }

  // Highlighting
  if (query.highlight) {
    const highlightFields: Record<string, Record<string, unknown>> = {};
    const fields = query.highlight.fields ?? searchableFields;
    for (const field of fields) {
      highlightFields[field] = {};
    }
    esQuery.highlight = {
      fields: highlightFields,
      pre_tags: [query.highlight.preTag ?? '<mark>'],
      post_tags: [query.highlight.postTag ?? '</mark>'],
    };
  }

  // Field projection
  if (query.fields && query.fields.length > 0) {
    esQuery._source = { includes: [...query.fields] };
  } else if (query.excludeFields && query.excludeFields.length > 0) {
    esQuery._source = { excludes: [...query.excludeFields] };
  }

  // Facets (aggregations)
  if (query.facets && query.facets.length > 0) {
    const aggs: Record<string, unknown> = {};
    for (const facet of query.facets) {
      aggs[facet] = {
        terms: {
          field: `${facet}.keyword`,
          size: query.facetOptions?.[facet]?.maxValues ?? 100,
        },
      };
      // Also add stats aggregation for numeric facets
      aggs[`${facet}_stats`] = {
        stats: { field: facet },
      };
    }
    esQuery.aggs = aggs;
  }

  // Score threshold
  if (query.rankingScoreThreshold !== undefined) {
    esQuery.min_score = query.rankingScoreThreshold;
  }

  return esQuery;
}

// ============================================================================
// Response mapping
// ============================================================================

interface ElasticsearchSearchResponse {
  took: number;
  timed_out: boolean;
  hits: {
    total: { value: number; relation: 'eq' | 'gte' };
    max_score: number | null;
    hits: Array<{
      _index: string;
      _id: string;
      _score: number | null;
      _source: Record<string, unknown>;
      highlight?: Partial<Record<string, string[]>>;
      sort?: unknown[];
    }>;
  };
  aggregations?: Record<string, unknown>;
}

function mapElasticsearchResponse(
  esResponse: ElasticsearchSearchResponse,
  indexName: string,
  query: SearchQuery,
): SearchResponse {
  const hits: SearchHit[] = esResponse.hits.hits.map(esHit => {
    const document = { id: esHit._id, ...esHit._source };

    // Build highlights
    let highlights: Record<string, string> | undefined;
    if (esHit.highlight) {
      const h: Record<string, string> = {};
      for (const [field, fragments] of Object.entries(esHit.highlight)) {
        if (!fragments) continue;
        if (fragments.length > 0) {
          h[field] = fragments.join(' ... ');
        }
      }
      if (Object.keys(h).length > 0) {
        highlights = h;
      }
    }

    return {
      document,
      score: esHit._score ?? undefined,
      highlights,
    } satisfies SearchHit;
  });

  // Map facets from aggregations
  let facetDistribution: Record<string, Record<string, number>> | undefined;
  let facetStats:
    | Record<string, { min: number; max: number; avg: number; sum: number; count: number }>
    | undefined;

  if (esResponse.aggregations && query.facets) {
    facetDistribution = {};
    for (const facet of query.facets) {
      const termsAgg = esResponse.aggregations[facet] as
        | {
            buckets?: Array<{ key: string; doc_count: number }>;
          }
        | undefined;
      if (termsAgg?.buckets) {
        const distribution: Record<string, number> = {};
        for (const bucket of termsAgg.buckets) {
          distribution[bucket.key] = bucket.doc_count;
        }
        facetDistribution[facet] = distribution;
      }

      const statsAgg = esResponse.aggregations[`${facet}_stats`] as
        | {
            min?: number | null;
            max?: number | null;
            avg?: number | null;
            sum?: number | null;
            count?: number;
          }
        | undefined;
      if (statsAgg && statsAgg.count && statsAgg.count > 0) {
        if (!facetStats) facetStats = {};
        facetStats[facet] = {
          min: statsAgg.min ?? 0,
          max: statsAgg.max ?? 0,
          avg: statsAgg.avg ?? 0,
          sum: statsAgg.sum ?? 0,
          count: statsAgg.count,
        };
      }
    }
  }

  const totalHits = esResponse.hits.total.value;
  const perPage = query.hitsPerPage ?? query.limit ?? 20;

  return {
    hits,
    totalHits,
    totalHitsRelation: esResponse.hits.total.relation === 'eq' ? 'exact' : 'estimated',
    query: query.q,
    processingTimeMs: esResponse.took,
    indexName,
    facetDistribution,
    facetStats,
    page: query.page,
    totalPages: query.page !== undefined ? Math.ceil(totalHits / perPage) : undefined,
    hitsPerPage: query.page !== undefined ? perPage : undefined,
    offset: query.page !== undefined ? undefined : (query.offset ?? 0),
    limit: query.page !== undefined ? undefined : perPage,
  };
}

// ============================================================================
// Elasticsearch provider factory
// ============================================================================

/**
 * Create an Elasticsearch (or OpenSearch-compatible) search provider.
 *
 * Communicates with an Elasticsearch cluster over HTTP using native `fetch`
 * with configurable retry and exponential backoff. Supports full index
 * management, document operations, search, suggest, multi-search, and
 * health checks.
 *
 * @param config - Elasticsearch connection and authentication configuration.
 * @returns A `SearchProvider` with `name: 'elasticsearch'`.
 *
 * @throws {Error} From `connect()` if the cluster health status is `'red'`
 *   or if the HTTP request fails after all retry attempts.
 * @throws {Error} From any index or document operation if the HTTP request
 *   returns a non-retryable 4xx error or exhausts retries.
 *
 * @remarks
 * **Index naming** — Elasticsearch uses the term "index" directly. The
 * `indexName` maps to the Elasticsearch index name without transformation.
 * The plugin-level `indexPrefix` is applied by the search manager.
 *
 * **Mapping strategy** — `createOrUpdateIndex()` sends a `PUT /<index>` with
 * full mapping. If the index already exists (HTTP 400), it falls back to
 * `PUT /<index>/_mapping` to update mappings. Changing field types in an
 * existing mapping is not permitted by Elasticsearch without a reindex.
 *
 * **Field types** — searchable fields are mapped as `text` with a `keyword`
 * sub-field for exact matching and sorting. Filterable-only fields are mapped
 * as `keyword`. This is a reasonable default; production deployments may need
 * to override the mapping for numeric, date, or geo fields.
 *
 * **Query DSL** — `SearchFilter` ASTs are translated to Elasticsearch query
 * DSL via `searchFilterToElasticsearchQuery()`:
 * - `$and` → `bool.filter`
 * - `$or` → `bool.should` with `minimum_should_match: 1`
 * - `$not` → `bool.must_not`
 * - `$geoRadius` → `geo_distance` query on `_geo`
 * - `$geoBoundingBox` → `geo_bounding_box` on `_geo`
 * - `CONTAINS` → `match` (full-text, not substring)
 * - `STARTS_WITH` → `prefix` query
 * - `IS_EMPTY` → `bool.should[term:'', must_not[exists]]`
 *
 * **Authentication** — supports HTTP basic auth (`{ username, password }`),
 * Bearer token (`{ bearer }`), and `ApiKey` header. Pass via `config.auth`
 * or `config.apiKey`.
 *
 * **Bulk operations** — `indexDocuments()` and `deleteDocuments()` use the
 * `/_bulk` NDJSON endpoint. Multi-search uses `/_msearch`.
 *
 * **Synchronous operations** — Elasticsearch document writes are
 * near-real-time but the HTTP response is synchronous. `waitForTask` is a
 * no-op that immediately returns `{ status: 'succeeded' }`.
 *
 * **Geo coordinates** — Elasticsearch uses `{ lat, lon }` (not `lng`) in its
 * query DSL. The provider translates `_geo.lng` → `lon` when building geo
 * queries, while the indexed field shape follows the provider-neutral
 * `_geo: { lat, lng }` convention set by `applyGeoTransform()`.
 *
 * @example
 * ```ts
 * import { createElasticsearchProvider } from '@lastshotlabs/slingshot-search';
 *
 * const provider = createElasticsearchProvider({
 *   provider: 'elasticsearch',
 *   url: 'http://localhost:9200',
 *   auth: { username: 'elastic', password: 'changeme' },
 *   timeoutMs: 5000,
 *   retries: 3,
 * });
 *
 * await provider.connect();
 * await provider.createOrUpdateIndex('threads', settings);
 * const results = await provider.search('threads', { q: 'hello world' });
 * ```
 */
export function createElasticsearchProvider(config: ElasticsearchProviderConfig): SearchProvider {
  const http = createHttpClient({
    baseUrl: config.url,
    auth: config.auth,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs ?? 5000,
    retries: config.retries ?? 3,
    retryDelayMs: config.retryDelayMs ?? 200,
  });

  // Cache searchable fields per index
  const indexFieldsCache = new Map<string, ReadonlyArray<string>>();

  async function getSearchableFields(indexName: string): Promise<ReadonlyArray<string>> {
    const cached = indexFieldsCache.get(indexName);
    if (cached) return cached;

    try {
      const { data } = await http.get<Record<string, ElasticsearchIndexMapping>>(
        `/${encodeURIComponent(indexName)}/_mapping`,
      );
      const mappingEntries = Object.values(data);
      const mapping = mappingEntries.length > 0 ? mappingEntries[0] : undefined;
      const mappings = mapping?.mappings;
      if (mappings && mappings.properties) {
        const searchable = Object.entries(mappings.properties)
          .filter(([, config]) => config.type === 'text')
          .map(([field]) => field);
        indexFieldsCache.set(indexName, searchable);
        return searchable;
      }
    } catch {
      // Ignore — return empty
    }
    return [];
  }

  const provider: SearchProvider = {
    name: 'elasticsearch',

    // --- Lifecycle ---

    async connect(): Promise<void> {
      const { data } = await http.get<{ status: string }>('/_cluster/health');
      if (data.status === 'red') {
        throw new SearchProviderError(`Cluster health is red`);
      }
    },

    async healthCheck(): Promise<SearchHealthResult> {
      const start = performance.now();
      try {
        const { data } = await http.get<{ status: string; cluster_name: string }>(
          '/_cluster/health',
        );
        const { data: versionData } = await http.get<{
          version: { number: string };
        }>('/');
        return {
          healthy: data.status !== 'red',
          provider: 'elasticsearch',
          latencyMs: Math.round(performance.now() - start),
          version: versionData.version.number,
        };
      } catch (err) {
        return {
          healthy: false,
          provider: 'elasticsearch',
          latencyMs: Math.round(performance.now() - start),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    teardown(): Promise<void> {
      indexFieldsCache.clear();
      return Promise.resolve();
    },

    // --- Index Management ---

    async createOrUpdateIndex(
      indexName: string,
      settings: SearchIndexSettings,
    ): Promise<SearchIndexTask | undefined> {
      const mapping = mapSettingsToElasticsearchMapping(settings);

      try {
        await http.put(`/${encodeURIComponent(indexName)}`, mapping);
      } catch (err) {
        // If index already exists, update mappings
        if (err instanceof Error && err.message.includes('400')) {
          await http.put(`/${encodeURIComponent(indexName)}/_mapping`, mapping.mappings);
        } else {
          throw err;
        }
      }

      // Cache searchable fields
      indexFieldsCache.set(indexName, [...settings.searchableFields]);
      return undefined;
    },

    async deleteIndex(indexName: string): Promise<void> {
      await http.delete(`/${encodeURIComponent(indexName)}`);
      indexFieldsCache.delete(indexName);
    },

    async listIndexes() {
      const { data } = await http.get<
        Record<
          string,
          {
            aliases: Record<string, unknown>;
            mappings: Record<string, unknown>;
            settings: { index: { creation_date?: string } };
          }
        >
      >('/_all');

      const { data: stats } = await http.get<{
        indices: Record<string, { primaries: { docs: { count: number } } }>;
      }>('/_stats/docs');

      return Object.keys(data)
        .filter(name => !name.startsWith('.'))
        .map(name => ({
          name,
          documentCount: name in stats.indices ? stats.indices[name].primaries.docs.count : 0,
          updatedAt: new Date(),
        }));
    },

    async getIndexSettings(indexName: string): Promise<SearchIndexSettings> {
      const { data } = await http.get<Record<string, ElasticsearchIndexMapping>>(
        `/${encodeURIComponent(indexName)}/_mapping`,
      );
      const mapping = Object.values(data)[0] ?? { mappings: {} };
      return mapElasticsearchMappingToSettings(mapping);
    },

    // --- Document Operations ---

    async indexDocument(
      indexName: string,
      document: Record<string, unknown>,
      documentId: string,
    ): Promise<void> {
      await http.put(
        `/${encodeURIComponent(indexName)}/_doc/${encodeURIComponent(documentId)}`,
        document,
      );
    },

    async deleteDocument(indexName: string, documentId: string): Promise<void> {
      await http.delete(`/${encodeURIComponent(indexName)}/_doc/${encodeURIComponent(documentId)}`);
    },

    async indexDocuments(
      indexName: string,
      documents: ReadonlyArray<Record<string, unknown>>,
      primaryKey: string,
    ): Promise<SearchIndexTask | undefined> {
      // Elasticsearch bulk API uses NDJSON format
      const lines: string[] = [];
      for (const doc of documents) {
        const id = stringifyDocumentId(doc[primaryKey] ?? doc.id);
        lines.push(JSON.stringify({ index: { _index: indexName, _id: id } }));
        lines.push(JSON.stringify(doc));
      }
      const ndjson = lines.join('\n') + '\n';

      await http.post('/_bulk', undefined, {
        contentType: 'application/x-ndjson',
        rawBody: ndjson,
      });
      return undefined;
    },

    async deleteDocuments(
      indexName: string,
      documentIds: ReadonlyArray<string>,
    ): Promise<SearchIndexTask | undefined> {
      const lines: string[] = [];
      for (const id of documentIds) {
        lines.push(JSON.stringify({ delete: { _index: indexName, _id: id } }));
      }
      const ndjson = lines.join('\n') + '\n';

      await http.post('/_bulk', undefined, {
        contentType: 'application/x-ndjson',
        rawBody: ndjson,
      });
      return undefined;
    },

    async clearIndex(indexName: string): Promise<SearchIndexTask | undefined> {
      await http.post(`/${encodeURIComponent(indexName)}/_delete_by_query`, {
        query: { match_all: {} },
      });
      return undefined;
    },

    // --- Search ---

    async search(indexName: string, query: SearchQuery): Promise<SearchResponse> {
      const searchableFields = await getSearchableFields(indexName);
      const esQuery = buildElasticsearchQuery(query, searchableFields);

      const { data } = await http.post<ElasticsearchSearchResponse>(
        `/${encodeURIComponent(indexName)}/_search`,
        esQuery,
      );

      return mapElasticsearchResponse(data, indexName, query);
    },

    async multiSearch(
      queries: ReadonlyArray<{ readonly indexName: string; readonly query: SearchQuery }>,
    ): Promise<ReadonlyArray<SearchResponse>> {
      // Build NDJSON for _msearch
      const lines: string[] = [];
      const resolvedFields: ReadonlyArray<string>[] = [];

      for (const { indexName, query } of queries) {
        const searchableFields = await getSearchableFields(indexName);
        resolvedFields.push(searchableFields);
        const esQuery = buildElasticsearchQuery(query, searchableFields);
        lines.push(JSON.stringify({ index: indexName }));
        lines.push(JSON.stringify(esQuery));
      }
      const ndjson = lines.join('\n') + '\n';

      const { data } = await http.post<{
        responses: ElasticsearchSearchResponse[];
      }>('/_msearch', undefined, {
        contentType: 'application/x-ndjson',
        rawBody: ndjson,
      });

      return data.responses.map((result, i) =>
        mapElasticsearchResponse(result, queries[i].indexName, queries[i].query),
      );
    },

    // --- Suggest ---

    async suggest(indexName: string, query: SuggestQuery): Promise<SuggestResponse> {
      const start = performance.now();
      const searchableFields = await getSearchableFields(indexName);
      const fields = query.fields ?? searchableFields;

      const esQuery: Record<string, unknown> = {
        query: {
          multi_match: {
            query: query.q,
            fields: [...fields],
            type: 'phrase_prefix',
          },
        },
        size: query.limit ?? 5,
      };

      if (query.filter) {
        esQuery.query = {
          bool: {
            must: [esQuery.query as Record<string, unknown>],
            filter: [searchFilterToElasticsearchQuery(query.filter)],
          },
        };
      }

      if (query.highlight) {
        const highlightFields: Record<string, Record<string, unknown>> = {};
        for (const field of fields) {
          highlightFields[field] = {};
        }
        esQuery.highlight = {
          fields: highlightFields,
          pre_tags: ['<mark>'],
          post_tags: ['</mark>'],
        };
      }

      const { data } = await http.post<ElasticsearchSearchResponse>(
        `/${encodeURIComponent(indexName)}/_search`,
        esQuery,
      );

      const suggestions = data.hits.hits.map(esHit => {
        let bestField = fields[0] ?? 'id';
        let bestText = stringifySearchValue(esHit._source[bestField]);
        let bestHighlight: string | undefined;

        for (const field of fields) {
          const value = esHit._source[field];
          if (value === undefined || value === null) continue;
          const text = stringifySearchValue(value);
          if (text.toLowerCase().includes(query.q.toLowerCase())) {
            bestField = field;
            bestText = text;
            break;
          }
        }

        if (query.highlight && esHit.highlight) {
          const hlFragments = esHit.highlight[bestField];
          if (hlFragments && hlFragments.length > 0) {
            bestHighlight = hlFragments[0];
          }
        }

        return {
          text: bestText,
          highlight: bestHighlight,
          score: esHit._score ?? undefined,
          field: bestField,
        };
      });

      return {
        suggestions,
        processingTimeMs: Math.round(performance.now() - start),
      };
    },

    // --- Task Monitoring ---
    // Elasticsearch operations are synchronous for most APIs

    getTask(taskId: string | number): Promise<SearchIndexTask> {
      return Promise.resolve({
        taskId,
        status: 'succeeded',
        enqueuedAt: new Date(),
      });
    },

    waitForTask(taskId: string | number): Promise<SearchIndexTask> {
      return Promise.resolve({
        taskId,
        status: 'succeeded',
        enqueuedAt: new Date(),
      });
    },
  };

  return provider;
}
