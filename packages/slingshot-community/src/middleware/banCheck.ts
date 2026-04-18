import type { MiddlewareHandler } from 'hono';
import type { EntityAdapter } from '@lastshotlabs/slingshot-core';
import type { CommunityPrincipal } from '../types/env';
import type { Ban } from '../types/models';

/**
 * Create a Hono middleware that enforces container ban status for the current
 * user.
 *
 * The middleware resolves the target container from the request — first from
 * the route parameter `containerId`, then from the JSON body field
 * `containerId` — and queries the `Ban` entity store for an active ban record
 * matching the user and container. If a record is found it short-circuits with
 * a `403 Forbidden` JSON response.
 *
 * Resolution order for `containerId`:
 * 1. Route path parameter (`c.req.param('containerId')`)
 * 2. JSON body field `containerId` (parsed lazily; body parse errors are
 *    silently swallowed so the middleware never throws on malformed bodies)
 *
 * The middleware is a no-op (calls `next()`) when:
 * - No `communityPrincipal` is set on the Hono context — the route is treated
 *   as public.
 * - No `containerId` can be resolved from params or body.
 *
 * Tenant scoping: when `tenantId` is present on the Hono context it is passed
 * to the adapter `list()` call so the ban lookup is restricted to the correct
 * tenant partition.
 *
 * @param deps - Dependencies required by the middleware.
 * @param deps.banAdapter - Adapter for the `Ban` entity used to query active
 *   bans by `userId` and `containerId`.
 * @returns A Hono `MiddlewareHandler` ready to be registered on any route or
 *   router.
 *
 * @throws Never throws directly. Any adapter errors propagate as unhandled
 *   promise rejections and are caught by the Hono error handler upstream.
 *
 * @remarks
 * Register this middleware **after** the auth middleware that populates
 * `communityPrincipal`, and **before** the route handler that performs the
 * community action, so that banned users are rejected before any writes occur.
 *
 * @example
 * ```ts
 * import { createBanCheckMiddleware } from './middleware/banCheck';
 *
 * const banCheck = createBanCheckMiddleware({ banAdapter });
 *
 * // Apply to all thread creation routes:
 * router.post('/containers/:containerId/threads', banCheck, createThreadHandler);
 *
 * // Or apply broadly to a sub-router:
 * containerRouter.use('*', banCheck);
 * ```
 */
export function createBanCheckMiddleware(deps: {
  banAdapter: EntityAdapter<Ban, Record<string, unknown>, Record<string, unknown>>;
}): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get('communityPrincipal') as CommunityPrincipal | undefined;
    if (!principal) return next(); // public route
    const bodyJson = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const containerId =
      c.req.param('containerId') ??
      (typeof bodyJson?.containerId === 'string' ? bodyJson.containerId : undefined);
    if (!containerId) return next();
    const tenantId = c.get('tenantId') as string | undefined;

    const { items } = await deps.banAdapter.list({
      filter: {
        userId: principal.subject,
        containerId,
        unbannedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: 'now' } }],
      },
      limit: 1,
      ...(tenantId && { tenantId }),
    });
    if (items.length > 0) {
      return c.json({ error: 'User is banned from this container' }, 403);
    }
    await next();
  };
}
