import type { MiddlewareHandler } from 'hono';
import { getActorTenantId } from '@lastshotlabs/slingshot-core';
import type { CommunityAdminGate } from '../types/config';
import type { CommunityPrincipal } from '../types/env';

/**
 * Create a Hono after-middleware that logs successful moderation actions via
 * the admin gate.
 *
 * The middleware is a no-op when `deps.adminGate` is not provided. When
 * present it calls `next()` first and then, on HTTP 2xx responses, calls
 * `deps.adminGate.logAuditEntry()` with:
 * - `action`: `"{METHOD} {path}"` (e.g. `"POST /containers/abc/bans"`).
 * - `resource`: `'community'`.
 * - `actorId`: the `communityPrincipal.subject` from context, or `'unknown'`.
 * - `targetId`: the `:id` or `:reportId` route parameter (whichever is set).
 * - `meta.tenantId`: the actor's tenant ID if present.
 *
 * @param deps.adminGate - Optional `CommunityAdminGate` implementation. When
 *   absent the returned middleware calls `next()` with no side effects.
 * @returns A Hono `MiddlewareHandler` suitable for use with `app.use()` or
 *   as route-level middleware on moderation endpoints (ban, report, etc.).
 */
export function createAuditLogMiddleware(deps: {
  adminGate?: CommunityAdminGate;
}): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (!deps.adminGate) return;
    if (c.res.status >= 200 && c.res.status < 300) {
      const principal = c.get('communityPrincipal') as CommunityPrincipal | undefined;
      await deps.adminGate.logAuditEntry({
        action: c.req.method + ' ' + c.req.path,
        resource: 'community',
        actorId: principal?.subject ?? 'unknown',
        targetId: c.req.param('id') ?? c.req.param('reportId'),
        meta: { tenantId: getActorTenantId(c) ?? undefined },
      });
    }
  };
}
