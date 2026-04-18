import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

/**
 * Hono middleware that enforces authentication on a route.
 *
 * Checks that `authUserId` has been set on the Hono context by the `identify` middleware
 * (which runs globally and resolves the user from the session cookie or bearer token).
 * Returns `401 Unauthorized` when no authenticated user is present.
 *
 * @remarks
 * This middleware does **not** verify the JWT itself — that is done by `identify` during
 * the `setupMiddleware` phase. `userAuth` is a lightweight gate that simply checks whether
 * identification succeeded.
 *
 * @example
 * import { userAuth } from '@lastshotlabs/slingshot-auth';
 *
 * app.get('/profile', userAuth, async (c) => {
 *   const userId = c.get('authUserId')!;
 *   return c.json({ userId });
 * });
 *
 * // Chain with requireRole for role-gated routes
 * app.delete('/admin/users/:id', userAuth, requireRole('admin'), handler);
 */
export const userAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('authUserId')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};
