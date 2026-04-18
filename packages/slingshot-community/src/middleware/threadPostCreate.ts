// packages/slingshot-community/src/middleware/threadPostCreate.ts
import type { MiddlewareHandler } from 'hono';

/**
 * After-middleware on Thread.create that extracts mention metadata from
 * the thread body and updates the thread with sidecar fields.
 *
 * This is a placeholder — actual content-model parsing (via slingshot-core
 * `parseBody()`) will be wired when the content-model dependency ships.
 * For now, it passes through the client-provided mention fields as-is.
 *
 * @internal
 */
export function createThreadPostCreateMiddleware(): MiddlewareHandler {
  return async (_c, next) => {
    // Pass through — mention fields are set directly by client.
    // Full content-model parsing (parseBody) wired in a later phase.
    await next();
  };
}
