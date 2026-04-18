// packages/slingshot-community/src/middleware/replyCountUpdate.ts
import type { MiddlewareHandler } from 'hono';

/**
 * After-middleware on Reply.create that increments the parent thread's
 * `replyCount` and updates `lastActivityAt` / `lastReplyById` / `lastReplyAt`.
 *
 * @internal
 */
export function createReplyCountUpdateMiddleware(deps: {
  threadAdapter: {
    incrementReplyCount(id: string): Promise<unknown>;
    updateLastActivity(
      match: { id: string },
      data: { lastActivityAt?: string; lastReplyById?: string; lastReplyAt?: string },
    ): Promise<unknown>;
  };
}): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status < 200 || c.res.status >= 300) return;

    const cloned = c.res.clone();
    const result = (await cloned.json()) as {
      threadId?: string;
      authorId?: string;
      createdAt?: string;
    } | null;
    if (!result?.threadId) return;

    await deps.threadAdapter.incrementReplyCount(result.threadId);
    await deps.threadAdapter.updateLastActivity(
      { id: result.threadId },
      {
        lastActivityAt: result.createdAt ?? new Date().toISOString(),
        lastReplyById: result.authorId,
        lastReplyAt: result.createdAt ?? new Date().toISOString(),
      },
    );
  };
}
