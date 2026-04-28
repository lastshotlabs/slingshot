/**
 * Typesense search provider.
 *
 * HTTP-based provider that communicates with a Typesense instance via its
 * REST API. Uses native `fetch` (available in Bun) with retry logic and
 * exponential backoff.
 *
 * Implements the full `SearchProvider` interface including lifecycle, index
 * management, document operations, search, suggest, and task monitoring.
 *
 * Typesense operations are synchronous (no task queue), so `waitForTask`
 * is a no-op.
 */
import type { SearchProvider } from '../types/provider';
import type {
  SearchHealthResult,
  SearchIndexSettings,
  SearchIndexTask,
  TypesenseProviderConfig,
} from '../types/provider';
import type { SearchFilter, SearchQuery, SearchSort, SuggestQuery } from '../types/query';
import type { SearchHit, SearchResponse, SuggestResponse } from '../types/response';
import { stringifyDocumentId, stringifySearchValue } from './stringify';

// ============================================================================
// Internal HTTP client
// ============================================================================

interface HttpClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  /** Circuit breaker — consecutive failures before opening. */
  readonly circuitBreakerThreshold: number;
  /** Circuit breaker — cooldown duration in ms before half-open probe. */
  readonly circuitBreakerCooldownMs: number;
  /** Circuit breaker — clock for cooldown comparisons (override in tests). */
  readonly now: () => number;
}

/** Snapshot of the provider-level circuit breaker. */
export interface CircuitBreakerHealth {
  readonly state: 'closed' | 'open' | 'half-open';
  readonly consecutiveFailures: number;
  /** Epoch ms when the breaker last opened. `undefined` while closed. */
  readonly openedAt: number | undefined;
  /** Earliest epoch ms at which a half-open probe will be allowed. */
  readonly nextProbeAt: number | undefined;
}

/**
 * Structured error thrown when the circuit breaker is open. Callers can
 * pattern-match on `code === 'PROVIDER_UNAVAILABLE'` to fail fast without
 * waiting for the underlying request retries.
 */
export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE' as const;
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.retryAfterMs = retryAfterMs;
  }
}

interface HttpResponse<T = unknown> {
  readonly status: number;
  /** Undefined for 204 No Content responses — check `status` before accessing. */
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
  patch<T>(path: string, body?: unknown): Promise<{ readonly status: number; readonly data: T }>;
  delete<T>(path: string): Promise<{ readonly status: number; readonly data: T }>;
  send<T>(method: string, path: string, body?: unknown): Promise<HttpResponse<T>>;
  /** Inspect the circuit breaker state — stable observability surface. */
  getBreakerHealth(): CircuitBreakerHealth;
}

function createHttpClient(config: HttpClientConfig) {
  const {
    baseUrl,
    apiKey,
    timeoutMs,
    retries,
    retryDelayMs,
    circuitBreakerThreshold,
    circuitBreakerCooldownMs,
    now,
  } = config;

  // Circuit breaker state — closure-owned so tests can drive it deterministically.
  // States:
  //   closed      — normal operation; failures increment a counter
  //   open        — fail fast; reject every request until cooldown elapses
  //   half-open   — let exactly one probe through; success resets, failure re-opens
  let breakerState: 'closed' | 'open' | 'half-open' = 'closed';
  let consecutiveFailures = 0;
  let openedAt: number | undefined;
  let halfOpenInFlight = false;

  function getBreakerHealth(): CircuitBreakerHealth {
    const nextProbeAt =
      breakerState === 'open' && openedAt !== undefined
        ? openedAt + circuitBreakerCooldownMs
        : undefined;
    return { state: breakerState, consecutiveFailures, openedAt, nextProbeAt };
  }

  function recordSuccess(): void {
    consecutiveFailures = 0;
    breakerState = 'closed';
    openedAt = undefined;
    halfOpenInFlight = false;
  }

  function recordFailure(): void {
    consecutiveFailures += 1;
    if (breakerState === 'half-open') {
      // Probe failed — reopen and back off again.
      breakerState = 'open';
      openedAt = now();
      halfOpenInFlight = false;
      return;
    }
    if (consecutiveFailures >= circuitBreakerThreshold && breakerState === 'closed') {
      breakerState = 'open';
      openedAt = now();
    }
  }

  function tryEnterHalfOpen(): boolean {
    if (breakerState !== 'open') return true;
    if (openedAt === undefined) return true;
    if (now() - openedAt < circuitBreakerCooldownMs) return false;
    if (halfOpenInFlight) return false;
    breakerState = 'half-open';
    halfOpenInFlight = true;
    return true;
  }

  function buildUrl(path: string): string {
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalizedPath}`;
  }

  function buildHeaders(contentType = 'application/json'): Record<string, string> {
    return {
      'X-TYPESENSE-API-KEY': apiKey,
      'Content-Type': contentType,
    };
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { contentType?: string; rawBody?: string },
  ): Promise<HttpResponse<T>> {
    // Fail fast when the breaker is open and the cooldown has not yet elapsed.
    // `tryEnterHalfOpen()` mutates state to 'half-open' when it admits a probe;
    // the per-attempt loop below treats the probe like any other request and
    // will trigger `recordSuccess` / `recordFailure` accordingly.
    if (!tryEnterHalfOpen()) {
      const retryAfterMs =
        openedAt !== undefined ? Math.max(0, openedAt + circuitBreakerCooldownMs - now()) : 0;
      throw new ProviderUnavailableError(
        `[slingshot-search:typesense] Circuit breaker open after ${consecutiveFailures} ` +
          `consecutive failures. Retrying in ~${retryAfterMs}ms. Method: ${method} ${path}`,
        retryAfterMs,
      );
    }

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
            `[slingshot-search:typesense] HTTP ${response.status} ${method} ${path}: ${errorBody}`,
          );

          // Don't retry client errors (4xx) except 408 (timeout) and 429 (rate limit).
          // 4xx (except 408/429) are caller errors and do not feed the breaker —
          // they would otherwise trip the circuit on intentional bad requests.
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429
          ) {
            // Successful round-trip from the breaker's perspective: the host
            // is responsive even though the request was rejected.
            recordSuccess();
            throw error;
          }

          lastError = error;
          continue;
        }

        // 204 No Content — no body to parse
        if (response.status === 204) {
          recordSuccess();
          return { status: response.status, data: undefined };
        }

        const data = (await response.json()) as T;
        recordSuccess();
        return { status: response.status, data };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          lastError = new Error(
            `[slingshot-search:typesense] Request timeout after ${timeoutMs}ms: ${method} ${path}`,
          );
        } else if (err instanceof Error && err.message.startsWith('[slingshot-search:typesense]')) {
          // Already formatted error from non-retryable response
          throw err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    // All retries exhausted — feed the breaker a single failure for this op.
    recordFailure();
    throw lastError ?? new Error(`[slingshot-search:typesense] Request failed: ${method} ${path}`);
  }

  /** Wrapper that narrows data to non-undefined for endpoints that always return a body. */
  async function jsonRequest(
    method: string,
    path: string,
    body?: unknown,
    options?: { contentType?: string; rawBody?: string },
  ): Promise<{ readonly status: number; readonly data: unknown }> {
    const response = await request(method, path, body, options);
    if (response.data === undefined) {
      throw new Error(
        `[slingshot-search:typesense] Expected JSON body but got ${response.status} for ${method} ${path}`,
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
  const patch = ((path: string, body?: unknown) =>
    jsonRequest('PATCH', path, body)) as HttpClient['patch'];
  const remove = ((path: string) => jsonRequest('DELETE', path)) as HttpClient['delete'];
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
    getBreakerHealth,
  };

  return client;
}

// ============================================================================
// Filter translation
// ============================================================================

/**
 * Translate a `SearchFilter` AST to a Typesense `filter_by` string.
 *
 * Recursively transforms composite operators and leaf conditions into the
 * Typesense filter syntax accepted by its search endpoint.
 *
 * @param filter - The filter AST to translate. Supports all `SearchFilter`
 *   variants: `$and`, `$or`, `$not`, `$geoRadius`, `$geoBoundingBox`, and
 *   `SearchFilterCondition` leaves.
 * @returns A Typesense-compatible filter string, e.g. `status:=\`published\``,
 *   `(price:>100) && (stock:>=1)`, or `location:(48.85, 2.35, 1.5 km)`.
 *
 * @remarks
 * **String escaping** — string values are wrapped in backticks and internal
 * backticks are escaped with a backslash (e.g. `` `hello\`world` ``). This
 * is the Typesense-native quoting style for filter values.
 *
 * **`STARTS_WITH`** — not supported by Typesense filter syntax. Falls back to
 * equality (`field:=\`prefix\``) and logs a `console.warn`.
 *
 * **Geo bounding box** — Typesense does not natively support rectangular
 * bounding boxes. The box is approximated as a center point + radius derived
 * from the maximum of the lat/lng span. This is a lossy approximation —
 * documents near the corners of the box may be excluded.
 *
 * **`BETWEEN`** — translated as `field:[min..max]` (Typesense range syntax).
 *
 * **`$not`** — translated as `!(inner_clause)`.
 *
 * @example
 * ```ts
 * searchFilterToTypesenseFilter({ field: 'status', op: '=', value: 'published' });
 * // 'status:=`published`'
 *
 * searchFilterToTypesenseFilter({ field: 'price', op: '>', value: 100 });
 * // 'price:>100'
 *
 * searchFilterToTypesenseFilter({ field: 'tags', op: 'IN', value: ['a', 'b'] });
 * // 'tags:[`a`,`b`]'
 *
 * searchFilterToTypesenseFilter({ $and: [
 *   { field: 'price', op: '>=', value: 10 },
 *   { field: 'price', op: '<=', value: 100 },
 * ]});
 * // '(price:>=10) && (price:<=100)'
 *
 * searchFilterToTypesenseFilter({ $geoRadius: { lat: 48.85, lng: 2.35, radiusMeters: 1000 } });
 * // 'location:(48.85, 2.35, 1 km)'
 * ```
 */
export function searchFilterToTypesenseFilter(filter: SearchFilter): string {
  if ('$and' in filter) {
    const clauses = filter.$and.map(f => searchFilterToTypesenseFilter(f));
    return clauses.map(c => `(${c})`).join(' && ');
  }

  if ('$or' in filter) {
    const clauses = filter.$or.map(f => searchFilterToTypesenseFilter(f));
    return clauses.map(c => `(${c})`).join(' || ');
  }

  if ('$not' in filter) {
    return `!(${searchFilterToTypesenseFilter(filter.$not)})`;
  }

  if ('$geoRadius' in filter) {
    const { lat, lng, radiusMeters } = filter.$geoRadius;
    const radiusKm = radiusMeters / 1000;
    return `location:(${lat}, ${lng}, ${radiusKm} km)`;
  }

  if ('$geoBoundingBox' in filter) {
    const { topLeft, bottomRight } = filter.$geoBoundingBox;
    // Typesense uses geopoint filter with bounding box corners
    // Approximate as center + radius from bounding box
    const centerLat = (topLeft.lat + bottomRight.lat) / 2;
    const centerLng = (topLeft.lng + bottomRight.lng) / 2;
    const latDiff = Math.abs(topLeft.lat - bottomRight.lat);
    const lngDiff = Math.abs(topLeft.lng - bottomRight.lng);
    const approxRadiusKm = (Math.max(latDiff, lngDiff) * 111.32) / 2;
    return `location:(${centerLat}, ${centerLng}, ${approxRadiusKm} km)`;
  }

  // SearchFilterCondition
  if ('field' in filter && 'op' in filter) {
    const { field, op, value } = filter;

    switch (op) {
      case '=':
        return `${field}:=${formatTypesenseValue(value)}`;

      case '!=':
        return `${field}:!=${formatTypesenseValue(value)}`;

      case '>':
        return `${field}:>${formatTypesenseValue(value)}`;

      case '>=':
        return `${field}:>=${formatTypesenseValue(value)}`;

      case '<':
        return `${field}:<${formatTypesenseValue(value)}`;

      case '<=':
        return `${field}:<=${formatTypesenseValue(value)}`;

      case 'IN':
        if (Array.isArray(value)) {
          const formatted = (value as ReadonlyArray<string | number | boolean>)
            .map(formatTypesenseValue)
            .join(',');
          return `${field}:[${formatted}]`;
        }
        return `${field}:=[${formatTypesenseValue(value)}]`;

      case 'NOT_IN':
        if (Array.isArray(value)) {
          const formatted = (value as ReadonlyArray<string | number | boolean>)
            .map(formatTypesenseValue)
            .join(',');
          return `${field}:!=[${formatted}]`;
        }
        return `${field}:!=[${formatTypesenseValue(value)}]`;

      case 'EXISTS':
        return `${field}:!=null`;

      case 'NOT_EXISTS':
        return `${field}:=null`;

      case 'BETWEEN': {
        if (Array.isArray(value) && value.length === 2) {
          return `${field}:[${value[0]}..${value[1]}]`;
        }
        return `${field}:!=null`;
      }

      case 'CONTAINS':
        return `${field}:=${formatTypesenseValue(value)}`;

      case 'IS_EMPTY':
        return `${field}:=''`;

      case 'IS_NOT_EMPTY':
        return `${field}:!=''`;

      case 'STARTS_WITH':
        console.warn(
          `[slingshot-search:typesense] STARTS_WITH filter is not natively supported. Using equality as approximation for field '${field}'.`,
        );
        return `${field}:=${formatTypesenseValue(value)}`;

      default:
        return `${field}:!=null`;
    }
  }

  return '';
}

function formatTypesenseValue(value: unknown): string {
  if (typeof value === 'string') {
    // Typesense uses backtick-escaping for special characters in filter values
    return `\`${value.replace(/`/g, '\\`')}\``;
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

// ============================================================================
// Sort translation
// ============================================================================

function mapSortToTypesense(sort: SearchSort): string {
  if ('geoPoint' in sort) {
    return `location(${sort.geoPoint.lat}, ${sort.geoPoint.lng}):${sort.direction}`;
  }
  return `${sort.field}:${sort.direction}`;
}

function mapSortArrayToTypesense(sortRules: ReadonlyArray<SearchSort>): string {
  return sortRules.map(mapSortToTypesense).join(',');
}

// ============================================================================
// Settings mapping
// ============================================================================

interface TypesenseCollectionField {
  name: string;
  type: string;
  facet?: boolean;
  index?: boolean;
  sort?: boolean;
  optional?: boolean;
}

interface TypesenseCollectionSchema {
  name: string;
  fields: TypesenseCollectionField[];
  default_sorting_field?: string;
  enable_nested_fields?: boolean;
}

interface TypesenseCollectionResponse {
  name: string;
  num_documents: number;
  fields: TypesenseCollectionField[];
  default_sorting_field?: string;
  created_at?: number;
}

function mapSettingsToTypesenseSchema(
  collectionName: string,
  settings: SearchIndexSettings,
): TypesenseCollectionSchema {
  const fieldMap = new Map<string, TypesenseCollectionField>();
  const sortableSet = new Set(settings.sortableFields);
  const facetableSet = new Set(settings.facetableFields);

  // Add searchable fields
  for (const field of settings.searchableFields) {
    fieldMap.set(field, {
      name: field,
      type: 'string',
      facet: facetableSet.has(field),
      sort: sortableSet.has(field),
      optional: true,
    });
  }

  // Add filterable fields that aren't already added
  for (const field of settings.filterableFields) {
    if (!fieldMap.has(field)) {
      fieldMap.set(field, {
        name: field,
        type: 'auto',
        facet: facetableSet.has(field),
        index: true,
        sort: sortableSet.has(field),
        optional: true,
      });
    }
  }

  // Add sortable fields that aren't already added
  for (const field of settings.sortableFields) {
    if (!fieldMap.has(field)) {
      fieldMap.set(field, {
        name: field,
        type: 'auto',
        facet: facetableSet.has(field),
        sort: true,
        optional: true,
      });
    }
  }

  // Add facetable fields that aren't already added
  for (const field of settings.facetableFields) {
    if (!fieldMap.has(field)) {
      fieldMap.set(field, {
        name: field,
        type: 'auto',
        facet: true,
        optional: true,
      });
    }
  }

  // Add a wildcard auto field to handle any additional fields in documents
  fieldMap.set('.*', {
    name: '.*',
    type: 'auto',
    optional: true,
  });

  return {
    name: collectionName,
    fields: [...fieldMap.values()],
    enable_nested_fields: true,
  };
}

function mapTypesenseCollectionToSettings(
  collection: TypesenseCollectionResponse,
): SearchIndexSettings {
  const searchable: string[] = [];
  const filterable: string[] = [];
  const sortable: string[] = [];
  const facetable: string[] = [];

  for (const field of collection.fields) {
    if (field.name === '.*') continue;

    // String fields are typically searchable
    if (field.type === 'string' || field.type === 'string[]') {
      searchable.push(field.name);
    }

    if (field.index !== false) {
      filterable.push(field.name);
    }

    if (field.sort) {
      sortable.push(field.name);
    }

    if (field.facet) {
      facetable.push(field.name);
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

function mapSearchQueryToTypesenseParams(
  query: SearchQuery,
  searchableFields: ReadonlyArray<string>,
): Record<string, string> {
  const params: Record<string, string> = {};

  params.q = query.q || '*';
  params.query_by = searchableFields.length > 0 ? searchableFields.join(',') : '*';

  if (query.filter) {
    params.filter_by = searchFilterToTypesenseFilter(query.filter);
  }

  if (query.sort && query.sort.length > 0) {
    params.sort_by = mapSortArrayToTypesense(query.sort);
  }

  if (query.facets && query.facets.length > 0) {
    params.facet_by = query.facets.join(',');
  }

  // Pagination
  if (query.page !== undefined) {
    params.page = String(query.page);
    if (query.hitsPerPage !== undefined) {
      params.per_page = String(query.hitsPerPage);
    }
  } else {
    if (query.offset !== undefined) {
      const perPage = query.limit ?? 20;
      params.page = String(Math.floor(query.offset / perPage) + 1);
      params.per_page = String(perPage);
    } else if (query.limit !== undefined) {
      params.per_page = String(query.limit);
    }
  }

  // Highlighting
  if (query.highlight) {
    if (query.highlight.fields && query.highlight.fields.length > 0) {
      params.highlight_fields = query.highlight.fields.join(',');
    }
    if (query.highlight.preTag) {
      params.highlight_start_tag = query.highlight.preTag;
    }
    if (query.highlight.postTag) {
      params.highlight_end_tag = query.highlight.postTag;
    }
  }

  // Snippet
  if (query.snippet) {
    params.snippet_threshold = String(query.snippet.maxWords ?? 30);
  }

  // Field projection
  if (query.fields && query.fields.length > 0) {
    params.include_fields = query.fields.join(',');
  }
  if (query.excludeFields && query.excludeFields.length > 0) {
    params.exclude_fields = query.excludeFields.join(',');
  }

  return params;
}

// ============================================================================
// Response mapping
// ============================================================================

interface TypesenseSearchResponse {
  found: number;
  hits: Array<TypesenseSearchHit>;
  facet_counts?: Array<{
    field_name: string;
    counts: Array<{ value: string; count: number }>;
    stats?: { min?: number; max?: number; avg?: number; sum?: number };
  }>;
  search_time_ms: number;
  page: number;
  request_params?: Record<string, string>;
  out_of?: number;
}

interface TypesenseSearchHit {
  document: Record<string, unknown>;
  text_match?: number;
  text_match_info?: Record<string, unknown>;
  highlights?: Array<{
    field: string;
    snippet?: string;
    value?: string;
    matched_tokens?: string[];
    snippets?: string[];
    indices?: number[];
  }>;
  geo_distance_meters?: Record<string, number>;
}

function mapTypesenseResponse(
  tsResponse: TypesenseSearchResponse,
  indexName: string,
  query: SearchQuery,
): SearchResponse {
  const perPage = query.hitsPerPage ?? query.limit ?? 20;

  const hits: SearchHit[] = tsResponse.hits.map(tsHit => {
    const document = { ...tsHit.document };

    // Build highlights from Typesense highlight data
    let highlights: Record<string, string> | undefined;
    if (tsHit.highlights && tsHit.highlights.length > 0) {
      const h: Record<string, string> = {};
      for (const hl of tsHit.highlights) {
        if (hl.snippet) {
          h[hl.field] = hl.snippet;
        } else if (hl.value) {
          h[hl.field] = hl.value;
        }
      }
      if (Object.keys(h).length > 0) {
        highlights = h;
      }
    }

    // Geo distance
    let geoDistanceMeters: number | undefined;
    if (tsHit.geo_distance_meters) {
      const values = Object.values(tsHit.geo_distance_meters);
      if (values.length > 0) {
        geoDistanceMeters = values[0];
      }
    }

    return {
      document,
      score: tsHit.text_match,
      highlights,
      geoDistanceMeters,
      rankingScoreDetails: tsHit.text_match_info,
    } satisfies SearchHit;
  });

  // Map facets
  let facetDistribution: Record<string, Record<string, number>> | undefined;
  let facetStats:
    | Record<string, { min: number; max: number; avg: number; sum: number; count: number }>
    | undefined;

  if (tsResponse.facet_counts && tsResponse.facet_counts.length > 0) {
    facetDistribution = {};
    for (const facet of tsResponse.facet_counts) {
      const distribution: Record<string, number> = {};
      for (const entry of facet.counts) {
        distribution[entry.value] = entry.count;
      }
      facetDistribution[facet.field_name] = distribution;

      if (facet.stats && (facet.stats.min !== undefined || facet.stats.max !== undefined)) {
        if (!facetStats) facetStats = {};
        facetStats[facet.field_name] = {
          min: facet.stats.min ?? 0,
          max: facet.stats.max ?? 0,
          avg: facet.stats.avg ?? 0,
          sum: facet.stats.sum ?? 0,
          count: Object.keys(distribution).length,
        };
      }
    }
  }

  const totalHits = tsResponse.found;
  const page = query.page ?? tsResponse.page;
  const totalPages = Math.ceil(totalHits / perPage);

  return {
    hits,
    totalHits,
    totalHitsRelation: 'exact',
    query: query.q,
    processingTimeMs: tsResponse.search_time_ms,
    indexName,
    facetDistribution,
    facetStats,
    page: query.page !== undefined ? page : undefined,
    totalPages: query.page !== undefined ? totalPages : undefined,
    hitsPerPage: query.page !== undefined ? perPage : undefined,
    offset: query.page !== undefined ? undefined : (query.offset ?? 0),
    limit: query.page !== undefined ? undefined : perPage,
  };
}

// ============================================================================
// Multi-search response
// ============================================================================

interface TypesenseMultiSearchResponse {
  results: TypesenseSearchResponse[];
}

// ============================================================================
// Typesense provider factory
// ============================================================================

/**
 * Create a Typesense search provider.
 *
 * Communicates with a Typesense instance over HTTP using native `fetch` with
 * configurable retry and exponential backoff. Supports full index management
 * (collections), document operations, search, suggest, multi-search, and
 * health checks.
 *
 * @param config - Typesense connection and authentication configuration.
 * @returns A `SearchProvider` with `name: 'typesense'`.
 *
 * @throws {Error} From `connect()` if the Typesense `/health` endpoint returns
 *   `ok: false`, or if the HTTP request fails after all retry attempts.
 * @throws {Error} From any index or document operation if the HTTP request
 *   returns a non-retryable 4xx error or exhausts retries.
 *
 * @remarks
 * **Collection naming** — Typesense uses the term "collection" for what
 * slingshot calls an "index". The `indexName` passed to provider methods maps
 * directly to the Typesense collection `uid`. The configured `indexPrefix`
 * from the plugin config is applied by the search manager before reaching
 * this provider, so the provider always receives the fully-prefixed name.
 *
 * **Schema sync** — `createOrUpdateIndex()` attempts to create the collection;
 * if it already exists (HTTP 409), the collection is deleted and recreated.
 * Typesense does not support in-place schema updates for field type changes.
 * This means a schema change during a rolling deployment will briefly clear
 * all documents — for production use, prefer additive schema changes or
 * schedule reindexes alongside deploys.
 *
 * **Filter syntax** — `SearchFilter` ASTs are translated to Typesense
 * `filter_by` strings via `searchFilterToTypesenseFilter()`:
 * - Equality: `field:=\`value\``
 * - Range: `field:>N`, `field:[min..max]`
 * - IN set: `field:[a,b,c]`
 * - Geo radius: `location:(lat, lng, radiusKm km)`
 * - Geo bounding box: approximated as a center + radius (Typesense does not
 *   natively support rectangular bounding boxes)
 * - `STARTS_WITH`: not supported; falls back to equality with a `console.warn`.
 *
 * **Searchable fields** — Typesense requires `query_by` to name the fields
 * to search. The provider caches the collection's string-type fields after
 * the first `createOrUpdateIndex()` call and uses that list for every query.
 * If the cache is empty, the provider falls back to `'*'`.
 *
 * **Synchronous operations** — all Typesense document and index mutations
 * complete synchronously. `waitForTask` is a no-op that immediately returns
 * `{ status: 'succeeded' }`.
 *
 * **Batch import** — `indexDocuments()` uses Typesense's JSONL bulk import
 * endpoint (`/documents/import?action=upsert`) for efficiency. Each document's
 * primary key is normalised to the string `id` field expected by Typesense.
 *
 * @example
 * ```ts
 * import { createTypesenseProvider } from '@lastshotlabs/slingshot-search';
 *
 * const provider = createTypesenseProvider({
 *   provider: 'typesense',
 *   url: 'http://localhost:8108',
 *   apiKey: 'xyz',
 *   timeoutMs: 3000,
 *   retries: 2,
 * });
 *
 * await provider.connect();
 * await provider.createOrUpdateIndex('threads', settings);
 * await provider.indexDocuments('threads', docs, 'id');
 * const results = await provider.search('threads', { q: 'hello' });
 * ```
 */
export function createTypesenseProvider(config: TypesenseProviderConfig): SearchProvider {
  const http = createHttpClient({
    baseUrl: config.url,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs ?? 5000,
    retries: config.retries ?? 3,
    retryDelayMs: config.retryDelayMs ?? 200,
    circuitBreakerThreshold: config.circuitBreakerThreshold ?? 5,
    circuitBreakerCooldownMs: config.circuitBreakerCooldownMs ?? 30_000,
    now: config.now ?? (() => Date.now()),
  });

  // Cache searchable fields per collection for query_by parameter
  const collectionFieldsCache = new Map<string, ReadonlyArray<string>>();

  async function getSearchableFields(indexName: string): Promise<ReadonlyArray<string>> {
    const cached = collectionFieldsCache.get(indexName);
    if (cached) return cached;

    try {
      const { data } = await http.get<TypesenseCollectionResponse>(
        `/collections/${encodeURIComponent(indexName)}`,
      );
      const searchable = data.fields
        .filter(f => f.name !== '.*' && (f.type === 'string' || f.type === 'string[]'))
        .map(f => f.name);
      collectionFieldsCache.set(indexName, searchable);
      return searchable;
    } catch {
      return [];
    }
  }

  const provider: SearchProvider = {
    name: 'typesense',

    // --- Lifecycle ---

    async connect(): Promise<void> {
      const { data } = await http.get<{ ok: boolean }>('/health');
      if (!data.ok) {
        throw new Error(`[slingshot-search:typesense] Health check failed: not ok`);
      }
    },

    async healthCheck(): Promise<SearchHealthResult> {
      const start = performance.now();
      // Snapshot the breaker BEFORE making the call so the returned health
      // result reflects the breaker state used to gate the request itself.
      const breakerBefore = http.getBreakerHealth();
      try {
        const { data } = await http.get<{ ok: boolean }>('/health');
        const breakerAfter = http.getBreakerHealth();
        return {
          healthy: data.ok,
          provider: 'typesense',
          latencyMs: Math.round(performance.now() - start),
          circuitBreaker: {
            state: breakerAfter.state,
            consecutiveFailures: breakerAfter.consecutiveFailures,
            openedAt: breakerAfter.openedAt,
            nextProbeAt: breakerAfter.nextProbeAt,
          },
        };
      } catch (err) {
        const breakerAfter = http.getBreakerHealth();
        return {
          healthy: false,
          provider: 'typesense',
          latencyMs: Math.round(performance.now() - start),
          error: err instanceof Error ? err.message : String(err),
          circuitBreaker: {
            // If breaker was already open and request short-circuited, prefer
            // the pre-call snapshot to surface that fast-fail state.
            state: breakerBefore.state === 'open' ? breakerBefore.state : breakerAfter.state,
            consecutiveFailures: breakerAfter.consecutiveFailures,
            openedAt: breakerAfter.openedAt,
            nextProbeAt: breakerAfter.nextProbeAt,
          },
        };
      }
    },

    teardown(): Promise<void> {
      collectionFieldsCache.clear();
      return Promise.resolve();
    },

    // --- Index Management ---

    async createOrUpdateIndex(
      indexName: string,
      settings: SearchIndexSettings,
    ): Promise<SearchIndexTask | undefined> {
      const schema = mapSettingsToTypesenseSchema(indexName, settings);

      try {
        // Try to create the collection
        await http.post('/collections', schema);
      } catch (err) {
        // If collection already exists (409), update it
        if (err instanceof Error && err.message.includes('409')) {
          // Typesense doesn't support full schema update — update fields individually
          // For now, drop and recreate
          try {
            await http.delete(`/collections/${encodeURIComponent(indexName)}`);
          } catch {
            // Ignore delete errors
          }
          await http.post('/collections', schema);
        } else {
          throw err;
        }
      }

      // Cache the searchable fields
      const searchable =
        settings.searchableFields.length > 0
          ? settings.searchableFields
          : schema.fields
              .filter(f => f.name !== '.*' && (f.type === 'string' || f.type === 'string[]'))
              .map(f => f.name);
      collectionFieldsCache.set(indexName, searchable);
      return undefined;
    },

    async deleteIndex(indexName: string): Promise<void> {
      await http.delete(`/collections/${encodeURIComponent(indexName)}`);
      collectionFieldsCache.delete(indexName);
    },

    async listIndexes() {
      const { data } = await http.get<TypesenseCollectionResponse[]>('/collections');
      return data.map(col => ({
        name: col.name,
        documentCount: col.num_documents,
        updatedAt: col.created_at ? new Date(col.created_at * 1000) : new Date(),
      }));
    },

    async getIndexSettings(indexName: string): Promise<SearchIndexSettings> {
      const { data } = await http.get<TypesenseCollectionResponse>(
        `/collections/${encodeURIComponent(indexName)}`,
      );
      return mapTypesenseCollectionToSettings(data);
    },

    // --- Document Operations ---

    async indexDocument(
      indexName: string,
      document: Record<string, unknown>,
      documentId: string,
    ): Promise<void> {
      const doc = { ...document, id: documentId };
      await http.post(`/collections/${encodeURIComponent(indexName)}/documents?action=upsert`, doc);
    },

    async deleteDocument(indexName: string, documentId: string): Promise<void> {
      await http.delete(
        `/collections/${encodeURIComponent(indexName)}/documents/${encodeURIComponent(documentId)}`,
      );
    },

    async indexDocuments(
      indexName: string,
      documents: ReadonlyArray<Record<string, unknown>>,
      primaryKey: string,
    ): Promise<SearchIndexTask | undefined> {
      // Typesense batch import uses JSONL (newline-delimited JSON)
      const jsonl = documents
        .map(doc => JSON.stringify({ ...doc, id: stringifyDocumentId(doc[primaryKey] ?? doc.id) }))
        .join('\n');

      await http.post(
        `/collections/${encodeURIComponent(indexName)}/documents/import?action=upsert`,
        undefined,
        { contentType: 'text/plain', rawBody: jsonl },
      );
      return undefined;
    },

    async deleteDocuments(
      indexName: string,
      documentIds: ReadonlyArray<string>,
    ): Promise<SearchIndexTask | undefined> {
      // Typesense supports batch delete via filter
      const filterBy = `id:[${documentIds.join(',')}]`;
      await http.delete(
        `/collections/${encodeURIComponent(indexName)}/documents?filter_by=${encodeURIComponent(filterBy)}`,
      );
      return undefined;
    },

    async clearIndex(indexName: string): Promise<SearchIndexTask | undefined> {
      // Delete all documents by using a wildcard filter — Typesense requires a filter
      // The safest approach is to delete the collection and recreate it
      try {
        const { data: collection } = await http.get<TypesenseCollectionResponse>(
          `/collections/${encodeURIComponent(indexName)}`,
        );
        await http.delete(`/collections/${encodeURIComponent(indexName)}`);
        // Recreate with same schema
        const schema: TypesenseCollectionSchema = {
          name: indexName,
          fields: collection.fields,
          default_sorting_field: collection.default_sorting_field,
          enable_nested_fields: true,
        };
        await http.post('/collections', schema);
      } catch {
        // If collection doesn't exist, that's fine
      }
      return undefined;
    },

    // --- Search ---

    async search(indexName: string, query: SearchQuery): Promise<SearchResponse> {
      const searchableFields = await getSearchableFields(indexName);
      const params = mapSearchQueryToTypesenseParams(query, searchableFields);

      // Build query string for GET request
      const queryString = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');

      const { data } = await http.get<TypesenseSearchResponse>(
        `/collections/${encodeURIComponent(indexName)}/documents/search?${queryString}`,
      );

      return mapTypesenseResponse(data, indexName, query);
    },

    async multiSearch(
      queries: ReadonlyArray<{ readonly indexName: string; readonly query: SearchQuery }>,
    ): Promise<ReadonlyArray<SearchResponse>> {
      const searches = await Promise.all(
        queries.map(async ({ indexName, query }) => {
          const searchableFields = await getSearchableFields(indexName);
          const params = mapSearchQueryToTypesenseParams(query, searchableFields);
          return {
            collection: indexName,
            ...params,
          };
        }),
      );

      const { data } = await http.post<TypesenseMultiSearchResponse>('/multi_search', {
        searches,
      });

      return data.results.map((result, i) =>
        mapTypesenseResponse(result, queries[i].indexName, queries[i].query),
      );
    },

    // --- Suggest ---

    async suggest(indexName: string, query: SuggestQuery): Promise<SuggestResponse> {
      const start = performance.now();
      const searchableFields = await getSearchableFields(indexName);

      const params: Record<string, string> = {
        q: query.q,
        query_by: (query.fields ?? searchableFields).join(',') || '*',
        per_page: String(query.limit ?? 5),
        prefix: 'true',
      };

      if (query.filter) {
        params.filter_by = searchFilterToTypesenseFilter(query.filter);
      }

      if (query.highlight) {
        params.highlight_full_fields = (query.fields ?? searchableFields).join(',') || '*';
      }

      const queryString = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');

      const { data } = await http.get<TypesenseSearchResponse>(
        `/collections/${encodeURIComponent(indexName)}/documents/search?${queryString}`,
      );

      const suggestFields = query.fields ?? searchableFields;

      const suggestions = data.hits.map(tsHit => {
        let bestField = suggestFields[0] ?? 'id';
        let bestText = stringifySearchValue(tsHit.document[bestField]);
        let bestHighlight: string | undefined;

        // Find the best matching field
        for (const field of suggestFields) {
          const value = tsHit.document[field];
          if (value === undefined || value === null) continue;
          const text = stringifySearchValue(value);
          if (text.toLowerCase().includes(query.q.toLowerCase())) {
            bestField = field;
            bestText = text;
            break;
          }
        }

        // Extract highlight from Typesense highlights
        if (query.highlight && tsHit.highlights) {
          const hl = tsHit.highlights.find(h => h.field === bestField);
          if (hl) {
            bestHighlight = hl.snippet ?? hl.value;
          }
        }

        return {
          text: bestText,
          highlight: bestHighlight,
          score: tsHit.text_match,
          field: bestField,
        };
      });

      return {
        suggestions,
        processingTimeMs: Math.round(performance.now() - start),
      };
    },

    // --- Task Monitoring ---
    // Typesense is synchronous — no task queue

    getTask(taskId: string | number): Promise<SearchIndexTask> {
      return Promise.resolve({
        taskId,
        status: 'succeeded',
        enqueuedAt: new Date(),
      });
    },

    waitForTask(taskId: string | number): Promise<SearchIndexTask> {
      // Typesense operations are synchronous — no waiting needed
      return Promise.resolve({
        taskId,
        status: 'succeeded',
        enqueuedAt: new Date(),
      });
    },
  };

  return provider;
}
