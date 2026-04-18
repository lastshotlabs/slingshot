import { z } from 'zod';
import { fnSchema } from './shared';

/**
 * Zod schema for the `tenancy` section of `CreateAppConfig` / `CreateServerConfig`.
 *
 * Enables multi-tenancy support. When this section is present the framework
 * resolves a tenant identifier from every inbound request and makes it
 * available throughout the request lifecycle via `c.get('tenantId')`. Database
 * queries and cache operations are automatically scoped to the resolved tenant.
 *
 * @remarks
 * **Fields:**
 * - `resolution` — **Required.** Strategy used to extract the tenant identifier
 *   from the request:
 *   - `"header"` — Read the tenant ID from an HTTP request header. Defaults to
 *     `X-Tenant-Id`; override with `headerName`.
 *   - `"subdomain"` — Parse the first subdomain component of the `Host` header
 *     (e.g. `acme.app.example.com` → `"acme"`).
 *   - `"path"` — Read the tenant ID from a URL path segment. Defaults to
 *     segment index 1 (the first segment after `/`); override with `pathSegment`.
 * - `headerName` — Custom header name used when `resolution` is `"header"`.
 *   Defaults to `"X-Tenant-Id"`.
 * - `pathSegment` — Zero-based index of the path segment used when `resolution`
 *   is `"path"`. Defaults to `1` (i.e. `/tenantId/rest/of/path`).
 * - `onResolve` — Async hook `(rawTenantId: string, c: Context) => string | null`
 *   invoked after the raw tenant ID is extracted. Return a normalised tenant ID,
 *   or `null` to reject the request (response is controlled by `rejectionStatus`).
 *   Use this to validate tenant existence or map aliases.
 * - `cacheTtlMs` — How long (in milliseconds) a resolved tenant ID is cached in
 *   memory. Defaults to 60000 (1 minute). Set to `0` to disable caching.
 * - `cacheMaxSize` — Maximum number of tenant IDs held in the in-process LRU
 *   cache. Defaults to 1000.
 * - `exemptPaths` — Array of URL path prefixes that bypass tenant resolution
 *   entirely (e.g. `["/health", "/metrics"]`). Requests to exempt paths proceed
 *   without a `tenantId` in the context.
 * - `rejectionStatus` — HTTP status code returned when tenant resolution fails
 *   (raw ID not found, `onResolve` returns `null`, etc.). Defaults to `400`.
 *
 * **Mutual exclusions:**
 * - `headerName` is only meaningful when `resolution` is `"header"`.
 * - `pathSegment` is only meaningful when `resolution` is `"path"`.
 *
 * @example
 * ```ts
 * // In CreateServerConfig:
 * tenancy: {
 *   resolution: 'subdomain',
 *   onResolve: async (id, c) => {
 *     const tenant = await db.tenants.findOne({ slug: id });
 *     return tenant ? tenant.id : null;
 *   },
 *   cacheTtlMs: 30000,
 *   exemptPaths: ['/health'],
 *   rejectionStatus: 404,
 * }
 * ```
 */
export const tenancySchema = z.object({
  resolution: z.enum(['header', 'subdomain', 'path']),
  headerName: z.string().optional(),
  pathSegment: z.number().optional(),
  listEndpoint: z.string().optional(),
  onResolve: fnSchema.optional(),
  cacheTtlMs: z.number().optional(),
  cacheMaxSize: z.number().optional(),
  exemptPaths: z.array(z.string()).optional(),
  rejectionStatus: z.number().optional(),
});
