import type { MiddlewareHandler } from 'hono';
import type { NotificationBuilder } from '@lastshotlabs/slingshot-core';

/**
 * Create a Hono after-middleware that sends a ban notification when a ban is
 * successfully created.
 *
 * The middleware calls `next()` first and only acts on successful responses
 * (HTTP 2xx). It clones the response to read the created `Ban` record JSON
 * without consuming the body for downstream handlers. If the response body
 * lacks `userId` or `id` the middleware exits silently.
 *
 * On a valid ban response it creates a shared notification via the
 * `slingshot-notifications` builder. Delivery adapters (push, SSE, mail) react
 * to the resulting `notifications:notification.created` event.
 *
 * @param deps.builder - Source-scoped notifications builder used to persist
 *   the shared notification.
 * @returns A Hono `MiddlewareHandler` suitable for use with `app.use()` or
 *   as route-level middleware on the ban-creation endpoint.
 */
export function createBanNotifyMiddleware(deps: {
  builder: NotificationBuilder;
}): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status < 200 || c.res.status >= 300) return;
    // Clone the response so the body can still be read downstream.
    const cloned = c.res.clone();
    const ban = (await cloned.json()) as {
      id?: string;
      userId?: string;
      bannedBy?: string;
      containerId?: string;
      reason?: string;
      expiresAt?: string;
    };
    if (!ban.userId || !ban.id) return;

    await deps.builder.notify({
      tenantId: c.get('tenantId') as string | undefined,
      userId: ban.userId,
      type: 'community:ban',
      actorId: ban.bannedBy,
      targetType: 'community:ban',
      targetId: ban.id,
      scopeId: ban.containerId,
      dedupKey: `community:ban:${ban.id}:${ban.userId}`,
      data: {
        containerId: ban.containerId,
        reason: ban.reason,
        expiresAt: ban.expiresAt,
      },
    });
  };
}
