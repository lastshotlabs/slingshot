// packages/slingshot-community/src/middleware/replyCountDecrement.ts
import type { MiddlewareHandler } from 'hono';

/**
 * Before+after middleware on Reply.delete that decrements the parent thread's
 * `replyCount`. Reads the reply before delete to capture `threadId`, then
 * decrements after the delete succeeds.
 *
 * @internal
 */
export function createReplyCountDecrementMiddleware(deps: {
  replyAdapter: {
    getById(id: string): Promise<{ threadId?: string } | null>;
  };
  threadAdapter: {
    decrementReplyCount(id: string): Promise<unknown>;
  };
}): MiddlewareHandler {
  return async (c, next) => {
    // Read the reply before delete to capture threadId
    const id = c.req.param('id');
    let threadId: string | undefined;
    if (id) {
      const reply = await deps.replyAdapter.getById(id);
      threadId = reply?.threadId;
    }

    await next();
    if (c.res.status < 200 || c.res.status >= 300) return;

    if (threadId) {
      await deps.threadAdapter.decrementReplyCount(threadId);
    }
  };
}
