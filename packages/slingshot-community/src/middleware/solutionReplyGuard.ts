import type { MiddlewareHandler } from 'hono';
import type { EntityAdapter } from '@lastshotlabs/slingshot-core';
import type { Reply } from '../types/models';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Ensure a selected solution reply belongs to the thread being updated.
 */
export function createSolutionReplyGuardMiddleware(deps: {
  replyAdapter: EntityAdapter<Reply, Record<string, unknown>, Record<string, unknown>>;
}): MiddlewareHandler {
  return async (c, next) => {
    let body: Record<string, unknown>;
    try {
      const raw = (await c.req.json()) as unknown;
      if (!isRecord(raw)) return c.json({ error: 'Invalid JSON body' }, 400);
      body = raw;
    } catch {
      // Body is not valid JSON; reject with 400
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const threadId = typeof body.id === 'string' ? body.id : c.req.param('id');
    const replyId = typeof body.solutionReplyId === 'string' ? body.solutionReplyId : '';
    if (!threadId || !replyId) {
      return c.json({ error: 'thread id and solutionReplyId are required' }, 400);
    }

    const reply = await deps.replyAdapter.getById(replyId);
    if (!reply || reply.status !== 'published') {
      return c.json({ error: 'Reply not found' }, 404);
    }
    if (reply.threadId !== threadId) {
      return c.json({ error: 'Solution reply does not belong to thread' }, 400);
    }

    const normalized = { ...body, solutionMarkedAt: new Date().toISOString() };
    (c.req as unknown as { json: () => Promise<Record<string, unknown>> }).json = () =>
      Promise.resolve(normalized);

    await next();
  };
}
