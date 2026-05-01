import type { MiddlewareHandler } from 'hono';
import type { EntityAdapter } from '@lastshotlabs/slingshot-core';
import type { Thread } from '../types/models';

/**
 * Allow public thread-adjacent reads/writes only for published threads.
 */
export function createPublishedThreadGuardMiddleware(deps: {
  threadAdapter: EntityAdapter<Thread, Record<string, unknown>, Record<string, unknown>>;
}): MiddlewareHandler {
  return async (c, next) => {
    let id = c.req.param('id') || c.req.param('threadId');
    let requestedContainerId = '';
    if (!id && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      try {
        const body = (await c.req.json()) as unknown;
        if (typeof body === 'object' && body !== null) {
          const record = body as Record<string, unknown>;
          const bodyId = record.threadId ?? record.id;
          id = typeof bodyId === 'string' ? bodyId : '';
          requestedContainerId =
            typeof record.containerId === 'string' ? record.containerId : requestedContainerId;
        }
      } catch {
        // Body parse failed; fall through with empty id to skip guard
        id = '';
      }
    }
    if (!id) return next();

    const thread = await deps.threadAdapter.getById(id);
    if (!thread || thread.status !== 'published') {
      return c.json({ error: 'Thread not found' }, 404);
    }
    if (requestedContainerId && thread.containerId !== requestedContainerId) {
      return c.json({ error: 'Thread/container mismatch' }, 400);
    }

    await next();
  };
}
