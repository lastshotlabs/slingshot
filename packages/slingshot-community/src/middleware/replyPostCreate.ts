// packages/slingshot-community/src/middleware/replyPostCreate.ts
import type { MiddlewareHandler } from 'hono';

/**
 * No-op middleware retained as a manifest hook point. See
 * {@link createThreadPostCreateMiddleware} for rationale — the actual
 * server-truth mention normalization runs as a
 * `community:reply.created` bus subscriber in the plugin.
 *
 * @internal
 */
export function createReplyPostCreateMiddleware(): MiddlewareHandler {
  return async (_c, next) => {
    await next();
  };
}
