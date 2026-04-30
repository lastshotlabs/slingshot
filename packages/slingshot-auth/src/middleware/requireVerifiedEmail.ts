import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { getAuthRuntimeFromRequest } from '../runtime';
import { getAuthenticatedUserActor } from './userAuth';

/**
 * Middleware that blocks access for users whose email address has not been verified.
 *
 * Must run after `userAuth` (requires an authenticated actor). The adapter must implement
 * the optional `getEmailVerified` method for the check to succeed.
 *
 * @throws Returns `401 Unauthorized` (JSON) — when no authenticated actor is present
 *   (i.e., `getActorId(c)` is null). This is a soft rejection, not an exception.
 * @throws `HttpError(500, 'Internal server error')` — when the auth adapter does not
 *   implement `getEmailVerified`. Configure an adapter that supports email verification
 *   (e.g., the built-in SQLite/Postgres/MongoDB adapters) before using this middleware.
 * @throws Returns `403 Forbidden` (JSON, `{ error: 'Email not verified' }`) — when the
 *   user is authenticated but their email address has not been verified yet. The client
 *   should prompt the user to check their inbox and click the verification link.
 *
 * @example
 * import { userAuth, requireVerifiedEmail } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * router.use('/dashboard', userAuth, requireVerifiedEmail);
 * router.post('/posts', userAuth, requireVerifiedEmail, createPostHandler);
 */
export const requireVerifiedEmail: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = getAuthenticatedUserActor(c);
  if (!actor) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const userId = actor.id;

  const adapter = getAuthRuntimeFromRequest(c).adapter;
  if (!adapter.getEmailVerified) {
    throw new HttpError(500, 'Internal server error');
  }

  const verified = await adapter.getEmailVerified(userId);
  if (!verified) {
    return c.json({ error: 'Email not verified' }, 403);
  }

  await next();
};
