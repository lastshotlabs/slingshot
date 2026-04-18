/**
 * After-middleware that increments the parent message's `replyCount`
 * when a reply is created.
 *
 * Runs after the create handler succeeds. Reads `replyToId` from the
 * response body; if present, atomically increments the parent's counter.
 *
 * @module
 */
import type { MiddlewareHandler } from 'hono';
import type { MessageAdapter } from '../types';

/**
 * Build the reply-count-update after-middleware.
 *
 * @param deps.messageAdapter - Message adapter for incrementing parent's replyCount.
 */
export function createReplyCountUpdateMiddleware(deps: {
  messageAdapter: MessageAdapter;
}): MiddlewareHandler {
  return async (_c, next) => {
    await next();

    if (_c.res.status < 200 || _c.res.status >= 300) return;

    const body = (await _c.res.clone().json()) as { replyToId?: string };
    const replyToId = body.replyToId;
    if (!replyToId) return;

    await deps.messageAdapter.incrementReplyCount(replyToId);
  };
}
