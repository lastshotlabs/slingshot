/**
 * Per-entity search route.
 *
 * GET /search/:entity — full-text search with filters, facets, sorting,
 * highlighting, and pagination.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { type AppEnv, createRoute, errorResponse } from '@lastshotlabs/slingshot-core';
import { FilterParseError, parseUrlFilter, parseUrlSort } from '../queryParser';
import type { SearchManager } from '../searchManager';
import type { SearchPluginConfig } from '../types/config';
import type { SearchQuery } from '../types/query';

const tags = ['Search'];

const SearchQueryParams = z.object({
  q: z.string().min(1).describe('Search query string'),
  filter: z.string().optional().describe('URL filter syntax (field:value,field:>N,...)'),
  facets: z.string().optional().describe('Comma-separated facet field names'),
  sort: z.string().optional().describe('Sort expression (field:asc or field:desc)'),
  limit: z.string().optional().describe('Results per page (1-100, default 20)'),
  offset: z.string().optional().describe('Offset for pagination'),
  page: z.string().optional().describe('Page number (1-based)'),
  highlight: z.string().optional().describe('Include highlight snippets (true/false)'),
});

const SearchResponseSchema = z.object({
  hits: z
    .array(
      z.object({
        document: z.record(z.string(), z.unknown()),
        score: z.number().optional(),
        highlights: z.record(z.string(), z.string()).optional(),
      }),
    )
    .readonly(),
  totalHits: z.number(),
  totalHitsRelation: z.enum(['exact', 'estimated']),
  query: z.string(),
  processingTimeMs: z.number(),
  indexName: z.string(),
  facetDistribution: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  facetStats: z
    .record(
      z.string(),
      z.object({
        min: z.number(),
        max: z.number(),
        avg: z.number(),
        sum: z.number(),
        count: z.number(),
      }),
    )
    .optional(),
  page: z.number().optional(),
  totalPages: z.number().optional(),
  hitsPerPage: z.number().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

const ErrorResponseSchema = z.object({
  error: z.string(),
  requestId: z.string(),
});

const entitySearchRoute = createRoute({
  method: 'get',
  path: '/:entity',
  tags,
  summary: 'Search an entity',
  request: { query: SearchQueryParams },
  responses: {
    200: {
      content: { 'application/json': { schema: SearchResponseSchema } },
      description: 'Search results',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Invalid request parameters',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Entity not found or not searchable',
    },
  },
});

/**
 * Create the per-entity search router.
 *
 * Mounts a single OpenAPI route: `GET /:entity`
 *
 * The `:entity` path segment accepts either the entity name (e.g. `"Thread"`)
 * or its storage name (e.g. `"community_threads"`). The manager resolves both
 * to the canonical index name.
 *
 * **Request processing pipeline:**
 * 1. Resolve the entity to a configured search index (404 if unknown).
 * 2. Parse and validate the `filter` URL string via `parseUrlFilter`.
 * 3. Validate all filter fields against the index's `filterableFields`.
 * 4. Parse and validate the `sort` URL string; check against `sortableFields`.
 * 5. Parse `facets` and check against `facetableFields`.
 * 6. Validate and coerce `limit`, `offset`, `page` to numbers.
 * 7. Resolve a tenant ID via `config.tenantResolver` (if configured) and
 *    inject a tenant equality filter when the entity has no dedicated tenant
 *    isolation config.
 * 8. Delegate to the entity's `SearchClient.search()`.
 *
 * @param manager - The `SearchManager` that owns index metadata and search
 *   client instances.
 * @param config - Plugin-level configuration supplying `tenantResolver` and
 *   `tenantField` for plugin-level tenant decoration.
 * @returns An `OpenAPIHono` router ready to be mounted on the plugin's base
 *   path (e.g. `/search`).
 *
 * @remarks
 * Entity-level tenant isolation config takes precedence over the plugin-level
 * `tenantField`/`tenantResolver`. When the entity has its own `tenantIsolation`
 * setting, the search client handles tenant filtering internally and this router
 * does not inject a redundant tenant condition.
 *
 * @example
 * ```ts
 * const router = createSearchRouter(manager, config);
 * app.route('/search', router);
 * // GET /search/Thread?q=hello&filter=status:published&limit=10
 * ```
 */
export function createSearchRouter(
  manager: SearchManager,
  config: SearchPluginConfig,
): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(entitySearchRoute, async c => {
    const entityParam = c.req.param('entity') ?? '';
    const query = c.req.valid('query');

    // Resolve entity — accepts entity name (e.g., "Thread") or storage name (e.g., "community_threads")
    const indexName = manager.getIndexName(entityParam);
    if (!indexName) {
      return errorResponse(c, `Entity '${entityParam}' is not configured for search`, 404);
    }

    // Parse and validate filter
    let filter;
    try {
      filter = parseUrlFilter(query.filter);
    } catch (err) {
      if (err instanceof FilterParseError) {
        return errorResponse(c, err.message, 400);
      }
      throw err;
    }

    // Validate filter fields against entity config
    const settings = manager.getIndexSettings(entityParam);
    if (settings && filter) {
      const filterError = validateFilterFields(filter, new Set(settings.filterableFields));
      if (filterError) {
        return errorResponse(c, filterError, 400);
      }
    }

    // Parse sort
    const sort = parseUrlSort(query.sort);
    if (sort && settings) {
      const sortableSet = new Set(settings.sortableFields);
      for (const s of sort) {
        if (!sortableSet.has(s.field)) {
          return errorResponse(
            c,
            `Field '${s.field}' is not sortable. Sortable fields: [${settings.sortableFields.join(', ')}]`,
            400,
          );
        }
      }
    }

    // Parse facets
    const facets = query.facets
      ? query.facets
          .split(',')
          .map(f => f.trim())
          .filter(Boolean)
      : undefined;
    if (facets && settings) {
      const facetableSet = new Set(settings.facetableFields);
      for (const f of facets) {
        if (!facetableSet.has(f)) {
          return errorResponse(
            c,
            `Field '${f}' is not facetable. Facetable fields: [${settings.facetableFields.join(', ')}]`,
            400,
          );
        }
      }
    }

    // Build search query — validate numeric params
    const limit = query.limit ? parseInt(query.limit, 10) : undefined;
    const offset = query.offset ? parseInt(query.offset, 10) : undefined;
    const page = query.page ? parseInt(query.page, 10) : undefined;

    if (limit !== undefined && Number.isNaN(limit)) {
      return errorResponse(c, 'limit must be a number', 400);
    }
    if (offset !== undefined && Number.isNaN(offset)) {
      return errorResponse(c, 'offset must be a number', 400);
    }
    if (page !== undefined && Number.isNaN(page)) {
      return errorResponse(c, 'page must be a number', 400);
    }

    if (limit !== undefined && (limit < 1 || limit > 100)) {
      return errorResponse(c, 'limit must be between 1 and 100', 400);
    }
    if (page !== undefined && page < 1) {
      return errorResponse(c, 'page must be >= 1', 400);
    }

    const shouldHighlight = query.highlight === 'true' || query.highlight === '1';

    // Resolve tenant ID — entity-level config takes precedence over plugin-level
    const entityTenantConfig = manager.getEntityTenantConfig(entityParam);
    let tenantId: string | undefined;
    if (config.tenantResolver) {
      tenantId = config.tenantResolver(c);
    }

    // Apply plugin-level tenant decoration (legacy fallback — only when entity has no tenant isolation)
    let decoratedFilter = filter;
    if (!entityTenantConfig && tenantId && config.tenantField) {
      const tenantCondition = { field: config.tenantField, op: '=' as const, value: tenantId };
      decoratedFilter = decoratedFilter
        ? { $and: [tenantCondition, decoratedFilter] }
        : tenantCondition;
    }

    const searchQuery: SearchQuery = {
      q: query.q,
      filter: decoratedFilter,
      sort,
      facets,
      limit: limit ?? 20,
      offset: page !== undefined ? undefined : offset,
      page,
      hitsPerPage: page !== undefined ? (limit ?? 20) : undefined,
      highlight: shouldHighlight ? {} : undefined,
      showRankingScore: true,
    };

    // Pass tenant context to search client — entity-level isolation handled inside the client
    const client = manager.getSearchClient(entityParam);
    const result = await client.search(searchQuery, { tenantId });

    return c.json(result, 200);
  });

  return router;
}

// ============================================================================
// Validation helpers
// ============================================================================

/**
 * Recursively validate that all filter fields are in the filterable set.
 * Returns an error message or undefined if valid.
 */
function validateFilterFields(
  filter: import('../types/query').SearchFilter,
  filterableFields: Set<string>,
): string | undefined {
  if ('$and' in filter) {
    for (const f of filter.$and) {
      const err = validateFilterFields(f, filterableFields);
      if (err) return err;
    }
    return undefined;
  }
  if ('$or' in filter) {
    for (const f of filter.$or) {
      const err = validateFilterFields(f, filterableFields);
      if (err) return err;
    }
    return undefined;
  }
  if ('$not' in filter) {
    return validateFilterFields(filter.$not, filterableFields);
  }
  if ('$geoRadius' in filter || '$geoBoundingBox' in filter) {
    return undefined; // Geo filters don't reference named fields
  }
  if ('field' in filter && 'op' in filter) {
    if (!filterableFields.has(filter.field)) {
      return `Field '${filter.field}' is not filterable. Filterable fields: [${[...filterableFields].join(', ')}]`;
    }
  }
  return undefined;
}
