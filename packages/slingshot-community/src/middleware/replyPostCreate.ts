// packages/slingshot-community/src/middleware/replyPostCreate.ts
import type { MiddlewareHandler } from 'hono';

/**
 * After-middleware on Reply.create that extracts mention metadata from
 * the reply body and updates the reply with sidecar fields.
 *
 * Placeholder — client-provided mention fields pass through as-is.
 * Full content-model parsing wired in a later phase.
 *
 * @internal
 */
export function createReplyPostCreateMiddleware(): MiddlewareHandler {
  return async (_c, next) => {
    await next();
  };
}
