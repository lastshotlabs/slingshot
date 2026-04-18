/**
 * After-middleware that decrements the parent message's `replyCount`
 * when a reply is soft-deleted.
 *
 * Runs after the delete handler succeeds. Fetches the deleted message
 * to check its `replyToId`; if present, atomically decrements the
 * parent's counter.
 *
 * @module
 */
import type { MiddlewareHandler } from 'hono';
import type { MessageAdapter } from '../types';

/**
 * Build the reply-count-decrement after-middleware.
 *
 * @param deps.messageAdapter - Message adapter for decrementing parent's replyCount.
 */
export function createReplyCountDecrementMiddleware(deps: {
  messageAdapter: MessageAdapter;
}): MiddlewareHandler {
  return async (c, next) => {
    // Capture the message BEFORE delete to know its replyToId
    const messageId = c.req.param('id');
    let replyToId: string | undefined;

    if (messageId) {
      const msg = await deps.messageAdapter.getById(messageId);
      replyToId = msg?.replyToId ?? undefined;
    }

    await next();

    if (c.res.status < 200 || c.res.status >= 300) return;
    if (!replyToId) return;

    await deps.messageAdapter.decrementReplyCount(replyToId);
  };
}
