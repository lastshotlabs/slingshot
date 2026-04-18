/**
 * Suggest / autocomplete route.
 *
 * GET /search/:entity/suggest — returns autocomplete suggestions for a partial query.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { type AppEnv, createRoute, errorResponse } from '@lastshotlabs/slingshot-core';
import type { SearchManager } from '../searchManager';
import type { SearchPluginConfig } from '../types/config';
import type { SuggestQuery } from '../types/query';

const tags = ['Search'];

const SuggestQueryParams = z.object({
  q: z.string().min(1).describe('Partial query text'),
  limit: z.string().optional().describe('Max suggestions (1-10, default 5)'),
});

const SuggestResponseSchema = z.object({
  suggestions: z
    .array(
      z.object({
        text: z.string(),
        highlight: z.string().optional(),
        score: z.number().optional(),
        field: z.string().optional(),
      }),
    )
    .readonly(),
  processingTimeMs: z.number(),
});

const ErrorResponseSchema = z.object({
  error: z.string(),
  requestId: z.string(),
});

const suggestRoute = createRoute({
  method: 'get',
  path: '/:entity/suggest',
  tags,
  summary: 'Autocomplete suggestions for an entity',
  request: { query: SuggestQueryParams },
  responses: {
    200: {
      content: { 'application/json': { schema: SuggestResponseSchema } },
      description: 'Suggest results',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Invalid parameters',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Entity not found or not searchable',
    },
  },
});

/**
 * Create the autocomplete / suggest router.
 *
 * Mounts a single OpenAPI route: `GET /:entity/suggest`
 *
 * Returns ranked completion suggestions for a partial query string. Useful for
 * search-as-you-type UX — each keystroke can call this endpoint without
 * triggering a full search.
 *
 * **Request processing pipeline:**
 * 1. Resolve the entity to a configured search index (404 if unknown).
 * 2. Parse and validate `limit` (integer, 1–10, default 5).
 * 3. Resolve a tenant ID via `config.tenantResolver` and inject a tenant
 *    equality filter when the entity has no dedicated tenant isolation config.
 * 4. Delegate to the entity's `SearchClient.suggest()` with `highlight: true`.
 *
 * @param manager - The `SearchManager` that owns index metadata and search
 *   client instances.
 * @param config - Plugin-level configuration supplying `tenantResolver` and
 *   `tenantField` for plugin-level tenant decoration.
 * @returns An `OpenAPIHono` router ready to be mounted on the plugin's base
 *   path (e.g. `/search`).
 *
 * @remarks
 * The suggest endpoint always requests highlight annotations (`highlight: true`)
 * so consumers can render matched substrings in bold. Highlights use `<mark>`
 * / `</mark>` tags in the DB-native provider; external providers may use
 * different tags.
 *
 * @example
 * ```ts
 * const router = createSuggestRouter(manager, config);
 * app.route('/search', router);
 * // GET /search/User/suggest?q=joh&limit=5
 * ```
 */
export function createSuggestRouter(
  manager: SearchManager,
  config: SearchPluginConfig,
): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();

  router.openapi(suggestRoute, async c => {
    const entityParam = c.req.param('entity') ?? '';
    const query = c.req.valid('query');

    const indexName = manager.getIndexName(entityParam);
    if (!indexName) {
      return errorResponse(c, `Entity '${entityParam}' is not configured for search`, 404);
    }

    const limit = query.limit ? parseInt(query.limit, 10) : 5;
    if (Number.isNaN(limit)) {
      return errorResponse(c, 'limit must be a number', 400);
    }
    if (limit < 1 || limit > 10) {
      return errorResponse(c, 'limit must be between 1 and 10', 400);
    }

    // Resolve tenant ID — entity-level config takes precedence over plugin-level
    const entityTenantConfig = manager.getEntityTenantConfig(entityParam);
    let tenantId: string | undefined;
    if (config.tenantResolver) {
      tenantId = config.tenantResolver(c);
    }

    // Apply plugin-level tenant decoration (legacy fallback — only when entity has no tenant isolation)
    let filter: import('../types/query').SearchFilter | undefined;
    if (!entityTenantConfig && tenantId && config.tenantField) {
      filter = { field: config.tenantField, op: '=' as const, value: tenantId };
    }

    const suggestQuery: SuggestQuery = {
      q: query.q,
      limit,
      highlight: true,
      filter,
    };

    // Pass tenant context to suggest client — entity-level isolation handled inside the client
    const client = manager.getSearchClient(entityParam);
    const result = await client.suggest(suggestQuery, { tenantId });

    return c.json(result, 200);
  });

  return router;
}
