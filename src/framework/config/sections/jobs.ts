import { z } from 'zod';

/**
 * Zod schema for the `jobs` section of `CreateAppConfig` / `CreateServerConfig`.
 *
 * Controls the background-job status endpoint and access-control rules applied
 * to it. The endpoint lists queued, active, and completed jobs for debugging
 * and observability purposes.
 *
 * @remarks
 * **Fields:**
 * - `statusEndpoint` — When `true`, mounts a `GET /jobs/status` endpoint that
 *   exposes job queue state. Defaults to `false` (endpoint is not mounted).
 * - `auth` — Access-control strategy for the status endpoint:
 *   - `"userAuth"` — Require an authenticated session (default when omitted).
 *   - `"none"` — No authentication check (combine with `roles` or
 *     `unsafePublic` only).
 *   - `Array` — Custom middleware chain; elements are Hono middleware handlers.
 * - `roles` — Array of role strings (e.g. `["admin"]`) that must appear on the
 *   authenticated user to access the endpoint. Checked after `auth`. Only
 *   meaningful when `auth` is `"userAuth"` or a custom middleware that populates
 *   the user context.
 * - `allowedQueues` — Whitelist of queue names visible through the status
 *   endpoint. When omitted, all queues are exposed. Use this to restrict
 *   visibility in multi-tenant or multi-service deployments.
 * - `scopeToUser` — When `true`, the status endpoint returns only jobs
 *   belonging to the currently authenticated user. Requires `auth: "userAuth"`.
 * - `unsafePublic` — When `true`, the status endpoint is accessible without
 *   any authentication. **Do not enable in production** unless protected by an
 *   external layer (e.g. IP allowlist at the edge).
 *
 * **Mutual exclusions:**
 * - `unsafePublic: true` and `auth: "userAuth"` are contradictory; the
 *   framework will warn and ignore `auth` when `unsafePublic` is set.
 * - `scopeToUser: true` requires `auth: "userAuth"` to have a user context
 *   available; route construction fails closed for any other auth mode.
 *
 * @example
 * ```ts
 * // In CreateServerConfig:
 * jobs: {
 *   statusEndpoint: true,
 *   auth: 'userAuth',
 *   roles: ['admin'],
 *   allowedQueues: ['email', 'reports'],
 * }
 * ```
 */
export const jobsSchema = z.object({
  statusEndpoint: z.boolean().optional(),
  auth: z.union([z.enum(['userAuth', 'none']), z.array(z.unknown())]).optional(),
  roles: z.array(z.string()).optional(),
  allowedQueues: z.array(z.string()).optional(),
  scopeToUser: z.boolean().optional(),
  unsafePublic: z.boolean().optional(),
});
