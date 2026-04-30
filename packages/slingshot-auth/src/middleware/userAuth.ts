import type { MiddlewareHandler } from 'hono';
import type { Actor, AppEnv } from '@lastshotlabs/slingshot-core';
import { getActor } from '@lastshotlabs/slingshot-core';

export type AuthenticatedUserActor = Actor & { kind: 'user'; id: string };

export function getAuthenticatedUserActor(
  c: Parameters<typeof getActor>[0],
): AuthenticatedUserActor | null {
  const actor = getActor(c);
  return actor.kind === 'user' && actor.id ? (actor as AuthenticatedUserActor) : null;
}

/**
 * Hono middleware that enforces authentication on a route.
 *
 * Checks that the current actor is an interactive user (`actor.kind === 'user'`) with a
 * non-null ID as resolved by the `identify` middleware. Machine-to-machine service
 * accounts and static API-key actors are intentionally rejected; use M2M scope guards
 * or bearer auth for those routes instead.
 *
 * @remarks
 * This middleware does **not** verify the JWT itself — that is done by `identify` during
 * the `setupMiddleware` phase. `userAuth` is a lightweight gate that checks whether
 * identification succeeded as a user actor.
 *
 * @example
 * import { userAuth } from '@lastshotlabs/slingshot-auth';
 * import { getActorId } from '@lastshotlabs/slingshot-core';
 *
 * app.get('/profile', userAuth, async (c) => {
 *   const userId = getActorId(c)!;
 *   return c.json({ userId });
 * });
 *
 * // Chain with requireRole for role-gated routes
 * app.delete('/admin/users/:id', userAuth, requireRole('admin'), handler);
 */
export const userAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!getAuthenticatedUserActor(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};
