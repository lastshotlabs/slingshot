// packages/slingshot-community/src/middleware/threadPostCreate.ts
import type { MiddlewareHandler } from 'hono';

/**
 * No-op middleware retained as a manifest hook point.
 *
 * Server-truth normalization of body tokens into the thread's
 * `mentions` / `broadcastMentions` / `mentionedRoleIds` sidecar fields
 * is handled by a `community:thread.created` bus subscriber in the
 * plugin (calls `parseBody(body, format)` from slingshot-core, then
 * the entity's `attachMentions` field-update operation). Not a
 * middleware because:
 *   1. Bus subscribers run alongside the embed unfurl subscriber with
 *      identical adapter access — one pattern across all sidecars.
 *   2. After-create middleware needs to read the response body and
 *      then call an adapter operation; the bus path already has the
 *      adapter ref in closure with no response-cloning required.
 *
 * This middleware stub is kept so the manifest's `middleware:` map
 * stays addressable for future per-create concerns that DO want
 * request-scoped state (e.g. ban-check augmentation, audit logs that
 * need request headers).
 *
 * @internal
 */
export function createThreadPostCreateMiddleware(): MiddlewareHandler {
  return async (_c, next) => {
    await next();
  };
}
