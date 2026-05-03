/**
 * Federated (multi-entity) search route.
 *
 * POST /search/multi — search across multiple entities in a single request.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  type AppEnv,
  createRoute,
  errorResponse,
  registerSchema,
} from '@lastshotlabs/slingshot-core';
import type { SearchManager } from '../searchManager';
import type { SearchPluginConfig } from '../types/config';
import type { FederatedSearchQuery, SearchFilter } from '../types/query';

const tags = ['Search'];

/**
 * Zod schema for SearchFilter — accepts any valid filter shape.
 * Runtime validation is handled by the search provider; Zod validates structure.
 */
const SearchFilterOpSchema = z.enum([
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'IN',
  'NOT_IN',
  'EXISTS',
  'NOT_EXISTS',
  'CONTAINS',
  'BETWEEN',
  'STARTS_WITH',
  'IS_EMPTY',
  'IS_NOT_EMPTY',
]);

const SearchFilterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.tuple([z.number(), z.number()]).readonly(),
  z.array(z.union([z.string(), z.number(), z.boolean()])).readonly(),
]);

// Recursive schema — must be registered as a named OpenAPI component so the
// generator emits `$ref: '#/components/schemas/SearchFilter'` at use sites
// instead of attempting to inline-expand the cycle (which blows the stack).
const SearchFilterSchema: z.ZodType<SearchFilter> = registerSchema(
  'SearchFilter',
  z.lazy(() =>
    z.union([
      z.object({ field: z.string(), op: SearchFilterOpSchema, value: SearchFilterValueSchema }),
      z.object({ $and: z.array(SearchFilterSchema).readonly() }),
      z.object({ $or: z.array(SearchFilterSchema).readonly() }),
      z.object({ $not: SearchFilterSchema }),
      z.object({
        $geoRadius: z.object({
          lat: z.number(),
          lng: z.number(),
          radiusMeters: z.number(),
        }),
      }),
      z.object({
        $geoBoundingBox: z.object({
          topLeft: z.object({ lat: z.number(), lng: z.number() }),
          bottomRight: z.object({ lat: z.number(), lng: z.number() }),
        }),
      }),
    ]),
  ),
);

const FederatedSearchEntrySchema = z.object({
  indexName: z.string(),
  q: z.string().optional(),
  filter: SearchFilterSchema.optional(),
  weight: z.number().optional(),
  limit: z.number().optional(),
});

const FederatedSearchBodySchema = z.object({
  q: z.string().describe('Shared query string'),
  queries: z.array(FederatedSearchEntrySchema).min(1).describe('Per-index queries'),
  limit: z.number().optional().describe('Total results limit'),
  merge: z.enum(['interleave', 'concat', 'weighted']).optional().describe('Merge strategy'),
  highlight: z
    .object({
      fields: z.array(z.string()).optional(),
      preTag: z.string().optional(),
      postTag: z.string().optional(),
    })
    .optional(),
});

const FederatedSearchResponseSchema = z.object({
  hits: z
    .array(
      z.object({
        document: z.record(z.string(), z.unknown()),
        indexName: z.string(),
        score: z.number().optional(),
        rawScore: z.number().optional(),
        weightedScore: z.number().optional(),
        highlights: z.record(z.string(), z.string()).optional(),
      }),
    )
    .readonly(),
  totalHits: z.number(),
  processingTimeMs: z.number(),
  indexes: z.record(
    z.string(),
    z.object({
      totalHits: z.number(),
      processingTimeMs: z.number(),
      facetDistribution: z.record(z.string(), z.record(z.string(), z.number())).optional(),
    }),
  ),
});

const ErrorResponseSchema = z.object({
  error: z.string(),
  requestId: z.string(),
});

const federatedSearchRoute = createRoute({
  method: 'post',
  path: '/multi',
  tags,
  summary: 'Federated search across multiple entities',
  request: {
    body: {
      content: {
        'application/json': { schema: FederatedSearchBodySchema },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: FederatedSearchResponseSchema } },
      description: 'Federated search results',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Invalid request',
    },
  },
});

/**
 * Create the federated (multi-entity) search router.
 *
 * Mounts a single OpenAPI route: `POST /multi`
 *
 * Executes a search across multiple entity indexes in a single HTTP round-trip
 * and merges the results according to the requested merge strategy.
 *
 * **Request processing pipeline:**
 * 1. Validate that every `queries[].indexName` refers to a configured entity.
 * 2. Resolve the tenant ID via `config.tenantResolver`.
 * 3. For each per-index query entry:
 *    - If the entity has a `filtered` tenant isolation config and a tenant ID is
 *      present, prepend a tenant equality condition to the entry's filter.
 *    - If the entity has an `index-per-tenant` isolation config, resolve the
 *      index name to `<baseIndex>__tenant_<tenantId>`.
 *    - Otherwise fall back to plugin-level `tenantField` decoration.
 * 4. Delegate the assembled `FederatedSearchQuery` to `manager.federatedSearch`.
 *
 * @param manager - The `SearchManager` that orchestrates multi-index search and
 *   owns index metadata.
 * @param config - Plugin-level configuration supplying `tenantResolver` and
 *   `tenantField`.
 * @returns An `OpenAPIHono` router ready to be mounted on the plugin's base
 *   path (e.g. `/search`).
 *
 * @remarks
 * Federated search bypasses per-entity `SearchClient` instances and operates
 * directly through the manager. This means entity-level `filtered` tenant
 * isolation is handled by injecting a filter here, while `index-per-tenant`
 * isolation is handled by rewriting the index name in this router before the
 * manager is called.
 *
 * @example
 * ```ts
 * const router = createFederatedRouter(manager, config);
 * app.route('/search', router);
 * // POST /search/multi
 * // { "q": "hello", "queries": [{ "indexName": "Thread" }, { "indexName": "User" }] }
 * ```
 */
export function createFederatedRouter(
  manager: SearchManager,
  config: SearchPluginConfig,
): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(federatedSearchRoute, async c => {
    const body = c.req.valid('json');

    // Validate all referenced indexes exist
    for (const entry of body.queries) {
      const indexName = manager.getIndexName(entry.indexName);
      if (!indexName) {
        return errorResponse(c, `Entity '${entry.indexName}' is not configured for search`, 400);
      }
    }

    // Resolve tenant ID for tenant decoration
    let tenantId: string | undefined;
    if (config.tenantResolver) {
      tenantId = config.tenantResolver(c);
    }

    // Map the request body index names to resolved index names, applying tenant filters.
    // Entity-level tenant isolation takes precedence over plugin-level config.
    // For index-per-tenant entities, the search client handles index resolution internally,
    // so we resolve index names via the manager (base index) and pass tenantId via the client.
    const federatedQuery: FederatedSearchQuery = {
      q: body.q,
      queries: body.queries.map(entry => {
        let filter: SearchFilter | undefined = entry.filter;
        const entityTenantConfig = manager.getEntityTenantConfig(entry.indexName);

        if (entityTenantConfig) {
          // Entity has its own tenant isolation — for filtered mode, the search client
          // will inject the tenant filter automatically. For index-per-tenant, the client
          // routes to the correct index. Federated search operates on base indexes, so
          // for filtered mode we inject the filter here (federated bypasses getSearchClient).
          if (entityTenantConfig.tenantIsolation === 'filtered' && tenantId) {
            const tenantCondition: SearchFilter = {
              field: entityTenantConfig.tenantField,
              op: '=' as const,
              value: tenantId,
            };
            filter = filter ? { $and: [tenantCondition, filter] } : tenantCondition;
          }
        } else if (tenantId && config.tenantField) {
          // Plugin-level tenant decoration (legacy fallback)
          const tenantCondition: SearchFilter = {
            field: config.tenantField,
            op: '=' as const,
            value: tenantId,
          };
          filter = filter ? { $and: [tenantCondition, filter] } : tenantCondition;
        }

        // For index-per-tenant, resolve to the tenant-scoped index name
        let resolvedIndexName = manager.getIndexName(entry.indexName) ?? entry.indexName;
        if (entityTenantConfig?.tenantIsolation === 'index-per-tenant' && tenantId) {
          resolvedIndexName = `${resolvedIndexName}__tenant_${tenantId}`;
        }

        return {
          indexName: resolvedIndexName,
          q: entry.q,
          filter,
          weight: entry.weight,
          limit: entry.limit,
        };
      }),
      limit: body.limit,
      merge: body.merge,
      highlight: body.highlight,
    };

    try {
      const result = await manager.federatedSearch(federatedQuery);
      return c.json(result, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(c, `Federated search failed: ${message}`, 400);
    }
  });

  return router;
}
