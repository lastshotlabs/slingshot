/**
 * Search plugin configuration types.
 *
 * `SearchPluginConfig` is passed to `createSearchPlugin()` and controls
 * provider setup, default sync mode, and plugin-level settings.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { SearchConfigError } from '../errors/searchErrors';
import type { AnySearchProviderConfig } from './provider';

function normalizeMountPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    throw new SearchConfigError("mountPath must start with '/'");
  }

  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.length === 0) {
    throw new SearchConfigError("mountPath must not be '/'");
  }

  return normalized;
}

/**
 * Admin gate for search index management routes.
 *
 * Controls access to admin endpoints (rebuild index, health check) and
 * optionally logs audit entries for admin actions. Admin routes are only
 * mounted when this is passed to `createSearchPlugin()`.
 *
 * @remarks
 * Validated at plugin construction time via `validateAdapterShape`. The
 * `verifyRequest` method must be present.
 *
 * @example
 * ```ts
 * import type { SearchAdminGate } from '@lastshotlabs/slingshot-search';
 *
 * const adminGate: SearchAdminGate = {
 *   async verifyRequest(c) {
 *     const auth = c.req.header('Authorization');
 *     return auth === `Bearer ${process.env.ADMIN_SECRET}`;
 *   },
 * };
 * ```
 */
export interface SearchAdminGate {
  /** Verify whether the request is authorized for admin operations. */
  verifyRequest(c: Context<AppEnv>): Promise<boolean>;
  /** Optional audit logging for admin actions. */
  logAuditEntry?(entry: { action: string; entity: string; userId?: string }): Promise<void>;
}

/**
 * Top-level configuration for `createSearchPlugin()`.
 *
 * All fields are `readonly` — the plugin treats the config as frozen after
 * construction. Always pass to `createSearchPlugin()` rather than storing
 * a reference directly.
 *
 * @remarks
 * **Provider selection** — at least one provider must be configured under a
 * named key. The key `'default'` is used when an entity's search config does
 * not explicitly name a provider. Multiple providers can be configured (e.g.
 * one for fast entity types, another for heavyweight full-text indexes) and
 * entities opt in via their `search.provider` field.
 *
 * **Index prefix** — `indexPrefix` is prepended to every index name derived
 * from an entity's storage name or explicit `search.indexName`. Use it for
 * environment isolation: `staging_`, `test_`, `myapp_`. The prefix is applied
 * by the search manager before any provider sees the name.
 *
 * **Tenant isolation** — when both `tenantResolver` and `tenantField` are set,
 * every search and suggest request is automatically scoped to the current
 * tenant. The tenant ID is extracted from the Hono request context and injected
 * as a filter condition before the query reaches the provider. Entity-level
 * `tenantIsolation: 'index-per-tenant'` overrides this with index routing
 * instead of filter injection.
 *
 * **Transforms** — named transform functions are registered at plugin
 * construction and referenced by name in entity search configs
 * (`search: { transform: 'myTransform' }`). The identity function is used
 * when no transform is configured. Transforms run on every document before
 * it is sent to the search provider.
 *
 * **Admin routes** — when `adminGate` is set, routes for index rebuild
 * (`POST /search/admin/indexes/:entity/rebuild`) and health check
 * (`GET /search/admin/health`) are mounted. All admin requests must pass
 * `adminGate.verifyRequest()` or receive a 403.
 *
 * **Route disabling** — individual route groups can be disabled via
 * `disableRoutes`. Valid values: `'search'`, `'suggest'`, `'federated'`,
 * `'admin'`.
 *
 * @example
 * ```ts
 * import { createSearchPlugin } from '@lastshotlabs/slingshot-search';
 * import type { SearchPluginConfig } from '@lastshotlabs/slingshot-search';
 *
 * const config: SearchPluginConfig = {
 *   providers: {
 *     default: { provider: 'meilisearch', url: 'http://localhost:7700', apiKey: 'key' },
 *     algolia:  { provider: 'algolia', applicationId: 'APP', apiKey: 'KEY' },
 *   },
 *   indexPrefix: 'myapp_',
 *   autoCreateIndexes: true,
 *   tenantResolver: c => c.get('tenantId'),
 *   tenantField: 'orgId',
 *   transforms: {
 *     flattenThread: doc => ({ ...doc, titleLower: String(doc.title).toLowerCase() }),
 *   },
 * };
 * const search = createSearchPlugin(config);
 * ```
 */
export interface SearchPluginConfig {
  /**
   * Named provider configurations. The `'default'` key is used when an entity
   * doesn't specify a provider. At least one provider must be configured.
   *
   * Multiple providers allow different entities to use different backends
   * within the same application.
   */
  readonly providers: Record<string, AnySearchProviderConfig>;

  /**
   * Index name prefix applied to all entity indexes.
   * Useful for environment isolation (e.g., 'staging_', 'test_').
   */
  readonly indexPrefix?: string;

  /**
   * Whether to auto-create/update indexes on startup based on entity search config.
   * Default: true.
   */
  readonly autoCreateIndexes?: boolean;

  /**
   * Tenant resolver function. Extracts the tenant ID from the request context.
   * When set, search queries are automatically decorated with a tenant filter.
   */
  readonly tenantResolver?: (c: Context) => string | undefined;

  /**
   * The document field that holds the tenant ID.
   * Used together with tenantResolver to auto-filter queries.
   */
  readonly tenantField?: string;

  /**
   * Admin gate for index management routes (rebuild, health).
   * Admin routes are only mounted when this is set.
   */
  readonly adminGate?: SearchAdminGate;

  /**
   * Mount path prefix for search routes. Default '/search'.
   */
  readonly mountPath?: string;

  /**
   * Route groups to disable. Values: 'search', 'suggest', 'federated', 'admin'.
   */
  readonly disableRoutes?: ReadonlyArray<string>;

  /**
   * Named document transform functions. Registered on the plugin's internal
   * transform registry at construction time. Entity search configs reference
   * transforms by name (e.g., `search: { transform: 'flattenThread' }`).
   *
   * This is the only way to register transforms on the plugin's registry.
   */
  readonly transforms?: Record<string, (doc: Record<string, unknown>) => Record<string, unknown>>;
}

// ============================================================================
// Zod schema for validatePluginConfig
// ============================================================================

/**
 * Zod schema that validates the structural shape of a `SearchPluginConfig`.
 *
 * Validates at plugin creation time to catch misconfigured provider objects
 * or missing required fields before any network connections are attempted.
 *
 * Function-valued fields (`tenantResolver`, `adminGate`, `transforms`) are
 * accepted as `z.unknown()` — their runtime shape is validated separately by
 * `validateAdapterShape` inside the plugin constructor.
 *
 * The `providers` record is validated to have at least one entry (a provider
 * map with zero entries is always a misconfiguration).
 *
 * Exported so callers can pre-validate configs in their own setup code, use
 * `safeParse` in environment variable bootstrapping, or generate JSON Schema
 * for tooling via `zodToJsonSchema`.
 *
 * @example
 * ```ts
 * import { searchPluginConfigSchema } from '@lastshotlabs/slingshot-search';
 *
 * const result = searchPluginConfigSchema.safeParse(rawConfig);
 * if (!result.success) {
 *   console.error(result.error.issues);
 * }
 * ```
 */
export const searchPluginConfigSchema = z.object({
  providers: z
    .record(
      z.string(),
      z.custom<AnySearchProviderConfig>(
        val =>
          typeof val === 'object' &&
          val !== null &&
          typeof (val as Record<string, unknown>)['provider'] === 'string',
      ),
    )
    .refine(obj => Object.keys(obj).length > 0, {
      message: 'At least one provider must be configured',
    })
    .describe('Named search provider configurations. At least one provider must be configured.'),
  transforms: z
    .record(z.string(), z.custom<(doc: Record<string, unknown>) => Record<string, unknown>>())
    .optional()
    .describe(
      'Named document transform functions referenced by entity search configs. Omit to register no transforms.',
    ),
  indexPrefix: z
    .string()
    .optional()
    .describe(
      'Prefix applied to all generated search index names. Omit to use entity-derived names without a prefix.',
    ),
  autoCreateIndexes: z
    .boolean()
    .optional()
    .describe(
      'Whether indexes are created or updated automatically at startup. Omit to use the plugin default.',
    ),
  tenantResolver: z
    .custom<(c: Context) => string | undefined>()
    .optional()
    .describe(
      'Function that resolves the current tenant ID from the request context. Omit to disable plugin-level tenant filtering.',
    ),
  /**
   * Built-in tenant resolution strategy. Manifest-compatible alternative to tenantResolver.
   * When "framework", reads tenant ID from c.get('tenantId') set by tenancy middleware.
   * Mutually exclusive with tenantResolver — if both are set, tenantResolver takes precedence.
   */
  tenantResolution: z
    .enum(['framework'])
    .optional()
    .describe(
      'Built-in tenant resolution strategy for search queries. ' +
        '"framework" reads the tenant ID from the Hono context variable "tenantId", ' +
        'which is set by the framework tenancy middleware when tenancy.resolution is configured. ' +
        'Requires tenancy to be configured in the manifest. ' +
        'When set, the tenantField config must also be provided. ' +
        'This is the manifest equivalent of tenantResolver: c => c.get("tenantId").',
    ),
  tenantField: z
    .string()
    .optional()
    .describe('Document field containing the tenant ID. Omit unless tenantResolver is configured.'),
  adminGate: z
    .custom<SearchAdminGate>()
    .optional()
    .describe(
      'Admin gate for search management routes. In manifest mode, accepts "superAdmin" or ' +
        '"authenticated" strings which are resolved to SearchAdminGate objects before the plugin ' +
        'factory. Omit to skip mounting admin routes.',
    ),
  mountPath: z
    .string()
    .transform(value => normalizeMountPath(value))
    .optional()
    .describe(
      "URL path prefix for search routes. Must start with '/'. Trailing slashes are trimmed. Omit to use '/search'.",
    ),
  disableRoutes: z
    .array(z.string())
    .optional()
    .describe('Route groups to skip when mounting search routes. Omit to mount all route groups.'),
});
