import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { getActor } from '@lastshotlabs/slingshot-core';

/**
 * Publish the resolved actor onto the request context.
 *
 * Downstream routes can then read `c.get('actor')` directly when auth has
 * already published the upstream identity inputs for the request.
 */
export function createActorResolutionMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('actor', getActor(c));
    await next();
  };
}
