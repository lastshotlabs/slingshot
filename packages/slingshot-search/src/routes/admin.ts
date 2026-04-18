/**
 * Admin routes for search index management.
 *
 * Protected by `config.adminGate`. Provides index rebuild, per-entity health,
 * and aggregate health endpoints.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  type AppEnv,
  RESOLVE_REINDEX_SOURCE,
  createRoute,
  errorResponse,
} from '@lastshotlabs/slingshot-core';
import type { StoreInfra } from '@lastshotlabs/slingshot-core';
import type { SearchManager } from '../searchManager';
import type { SearchPluginConfig } from '../types/config';

const tags = ['Search - Admin'];

const ErrorResponseSchema = z.object({
  error: z.string(),
  requestId: z.string(),
});

// --- Per-entity health ---

const EntityHealthResponseSchema = z.object({
  entity: z.string(),
  indexName: z.string(),
  provider: z.object({
    healthy: z.boolean(),
    provider: z.string(),
    latencyMs: z.number(),
    version: z.string().optional(),
    error: z.string().optional(),
  }),
});

const entityHealthRoute = createRoute({
  method: 'get',
  path: '/admin/indexes/:entity/health',
  tags,
  summary: 'Health check for a specific entity index',
  responses: {
    200: {
      content: { 'application/json': { schema: EntityHealthResponseSchema } },
      description: 'Entity index health',
    },
    403: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Forbidden',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Entity not found',
    },
  },
});

// --- Rebuild ---

const RebuildResponseSchema = z.object({
  entity: z.string(),
  documentsIndexed: z.number(),
  durationMs: z.number(),
});

const rebuildRoute = createRoute({
  method: 'post',
  path: '/admin/indexes/:entity/rebuild',
  tags,
  summary: 'Rebuild the search index for a specific entity',
  responses: {
    200: {
      content: { 'application/json': { schema: RebuildResponseSchema } },
      description: 'Rebuild complete',
    },
    403: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Forbidden',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Entity not found',
    },
    422: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'No reindex source registered for entity',
    },
  },
});

// --- Aggregate health ---

const AggregateHealthResponseSchema = z.object({
  healthy: z.boolean(),
  providers: z.record(
    z.string(),
    z.object({
      healthy: z.boolean(),
      provider: z.string(),
      latencyMs: z.number(),
      version: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

const aggregateHealthRoute = createRoute({
  method: 'get',
  path: '/admin/health',
  tags,
  summary: 'Aggregate health across all search providers',
  responses: {
    200: {
      content: { 'application/json': { schema: AggregateHealthResponseSchema } },
      description: 'Aggregate health',
    },
    403: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Forbidden',
    },
  },
});

/**
 * Create the search administration router.
 *
 * Mounts the following OpenAPI routes, all protected by `config.adminGate`:
 * - `GET /admin/indexes/:entity/health` — health check for a specific entity's
 *   search index and provider.
 * - `GET /admin/health` — aggregate health across all registered providers.
 *
 * **Security:** Every request to `/admin/*` is gated by
 * `config.adminGate.verifyRequest`. If `adminGate` is not configured, all
 * admin requests receive a `403 Forbidden` response. Successful requests that
 * provide `adminGate.logAuditEntry` will have an audit entry recorded.
 *
 * @param manager - The `SearchManager` that owns provider instances and index
 *   metadata.
 * @param config - Plugin-level configuration. `config.adminGate` is required
 *   for any admin route to be accessible.
 * @returns An `OpenAPIHono` router ready to be mounted on the plugin's base
 *   path (e.g. `/search`).
 *
 * @throws Never — errors from the provider's `healthCheck` propagate to the
 *   caller as unhandled promise rejections (Hono's default error handler).
 *
 * @example
 * ```ts
 * const router = createAdminRouter(manager, {
 *   adminGate: {
 *     verifyRequest: async (c) => c.req.header('X-Admin-Token') === process.env.ADMIN_TOKEN,
 *     logAuditEntry: async ({ action, entity }) => auditLog.write({ action, entity }),
 *   },
 * });
 * app.route('/search', router);
 * // GET /search/admin/health
 * // GET /search/admin/indexes/Thread/health
 * ```
 */
export function createAdminRouter(
  manager: SearchManager,
  config: SearchPluginConfig,
  infra: StoreInfra,
): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();
  const gate = config.adminGate;

  // Admin gate middleware — applied to all admin routes
  router.use('/admin/*', async (c, next) => {
    const requestContext = c as Context<AppEnv>;
    if (!gate) {
      return errorResponse(requestContext, 'Admin routes require adminGate configuration', 403);
    }
    const allowed = await gate.verifyRequest(requestContext);
    if (!allowed) {
      return errorResponse(requestContext, 'Forbidden', 403);
    }
    await next();
  });

  // GET /admin/indexes/:entity/health
  router.openapi(entityHealthRoute, async c => {
    const entityParam = c.req.param('entity') ?? '';

    const indexName = manager.getIndexName(entityParam);
    if (!indexName) {
      return errorResponse(c, `Entity '${entityParam}' is not configured for search`, 404);
    }

    const provider = manager.getProvider(entityParam);
    if (!provider) {
      return errorResponse(c, `No provider found for entity '${entityParam}'`, 404);
    }

    const health = await provider.healthCheck();

    if (gate?.logAuditEntry) {
      await gate.logAuditEntry({ action: 'entity-health-check', entity: entityParam });
    }

    return c.json(
      {
        entity: entityParam,
        indexName,
        provider: health,
      },
      200,
    );
  });

  // POST /admin/indexes/:entity/rebuild
  router.openapi(rebuildRoute, async c => {
    const entityParam = c.req.param('entity') ?? '';

    const storageName = manager.resolveStorageName(entityParam);
    if (!storageName) {
      return errorResponse(c, `Entity '${entityParam}' is not configured for search`, 404);
    }

    const resolveSource = Reflect.get(infra, RESOLVE_REINDEX_SOURCE) as
      | ((name: string) => AsyncIterable<Record<string, unknown>> | null)
      | undefined;
    const source = resolveSource?.(storageName) ?? null;
    if (!source) {
      return errorResponse(
        c,
        `No reindex source registered for entity '${storageName}'. ` +
          'Ensure the entity plugin is loaded and the entity has a search config.',
        422,
      );
    }

    if (gate?.logAuditEntry) {
      await gate.logAuditEntry({ action: 'reindex', entity: storageName });
    }

    const result = await manager.reindex(storageName, source);

    return c.json({ entity: storageName, ...result }, 200);
  });

  // GET /admin/health
  router.openapi(aggregateHealthRoute, async c => {
    const results = await manager.healthCheck();
    const allHealthy = Object.values(results).every(r => r.healthy);

    if (gate?.logAuditEntry) {
      await gate.logAuditEntry({ action: 'aggregate-health-check', entity: '*' });
    }

    return c.json(
      {
        healthy: allHealthy,
        providers: results,
      },
      200,
    );
  });

  return router;
}
