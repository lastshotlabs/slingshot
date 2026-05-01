import type { MiddlewareHandler } from 'hono';
import type { EntityAdapter } from '@lastshotlabs/slingshot-core';
import type { Thread } from '../types/models';

function readThreadIdFromBody(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return '';
  }

  const candidate = (body as { threadId?: unknown }).threadId;
  return typeof candidate === 'string' ? candidate : '';
}

function readContainerIdFromBody(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return '';
  }

  const candidate = (body as { containerId?: unknown }).containerId;
  return typeof candidate === 'string' ? candidate : '';
}

/**
 * Create a Hono middleware that guards reply creation against thread state.
 *
 * Reads the `threadId` route parameter and fetches the thread via
 * `deps.threadAdapter.getById()`. If no `threadId` is present in the path the
 * middleware passes through without a check. Otherwise:
 * - Thread not found or `status !== 'published'`: returns `404 { error: 'Thread not found' }`.
 * - `thread.locked === true`: returns `403 { error: 'Thread is locked' }`.
 * - Otherwise: calls `next()`.
 *
 * This middleware should be applied to the `POST /threads/:threadId/replies`
 * route (or any sub-route that creates content scoped to a thread).
 *
 * @param deps.threadAdapter - Entity adapter for the `Thread` entity, used to
 *   fetch the thread by ID.
 * @returns A Hono `MiddlewareHandler` suitable for use with `app.use()` or
 *   as route-level middleware.
 */
export function createThreadStateGuardMiddleware(deps: {
  threadAdapter: EntityAdapter<Thread, Record<string, unknown>, Record<string, unknown>>;
}): MiddlewareHandler {
  return async (c, next) => {
    let threadId = c.req.param('threadId');
    let requestedContainerId = '';
    if (!threadId) {
      try {
        const body: unknown = await c.req.json();
        threadId = readThreadIdFromBody(body);
        requestedContainerId = readContainerIdFromBody(body);
      } catch {
        // Body parse failed; fall through with empty threadId to skip guard
        threadId = '';
      }
    }
    if (!threadId) return next();
    const thread = await deps.threadAdapter.getById(threadId);
    if (!thread || thread.status !== 'published') {
      return c.json({ error: 'Thread not found' }, 404);
    }
    if (thread.locked) {
      return c.json({ error: 'Thread is locked' }, 403);
    }
    if (requestedContainerId && thread.containerId !== requestedContainerId) {
      return c.json({ error: 'Thread/container mismatch' }, 400);
    }
    await next();
  };
}
