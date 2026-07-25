import type { MiddlewareHandler } from 'hono';
import type { ReplyAdapter, ThreadAdapter } from '../entities/runtime';

type GuardOptions = {
  allowUserTarget?: boolean;
  attachContainerId?: boolean;
  requireContainerIdMatch?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Guard routes that refer to community content by ID.
 *
 * It prevents user-owned side tables (bookmarks, reactions, reports, tags)
 * from proving that a draft/deleted thread or reply exists. When requested,
 * it also verifies that body.containerId matches the target's real container.
 *
 * TAKES THE TARGET FROM PATH PARAMS OR THE BODY, in that order. It used to read
 * the body unconditionally, which made it unusable on any GET route: with no
 * body, `c.req.json()` throws and the request dies as `400 Invalid JSON body`
 * before the handler runs. `Reaction.listByTarget` is exactly such a route —
 * `GET /community/reactions/list-by-target/:targetId/:targetType`, declared with
 * `fields: { targetId: 'param:targetId', targetType: 'param:targetType' }` — so
 * reaction counts NEVER loaded anywhere in a consumer app. Every feed row
 * showed zero regardless of the real counts, and un-reacting was broken too,
 * because the client resolves the row id for DELETE from that same response.
 *
 * Body-carrying POST call sites are unaffected: they have no such params, so
 * the lookup falls through to the body exactly as before.
 */
export function createContentTargetGuardMiddleware(
  deps: {
    threadAdapter: ThreadAdapter;
    replyAdapter: ReplyAdapter;
  },
  options: GuardOptions = {},
): MiddlewareHandler {
  return async (c, next) => {
    // Path params first. A route that identifies its target in the URL has no
    // reason to carry a body, and demanding one is what broke GET.
    const paramTargetId = c.req.param('targetId') ?? '';
    const paramTargetType = c.req.param('targetType') ?? '';
    const hasParamTarget = paramTargetId !== '' && paramTargetType !== '';

    let body: Record<string, unknown> = {};
    if (!hasParamTarget) {
      try {
        const raw = (await c.req.json()) as unknown;
        if (!isRecord(raw)) return c.json({ error: 'Invalid JSON body' }, 400);
        body = raw;
      } catch {
        // Body is not valid JSON; reject with 400
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
    }

    const targetType =
      paramTargetType ||
      readString(body, 'targetType') ||
      (readString(body, 'threadId') ? 'thread' : '');
    const targetId = paramTargetId || readString(body, 'targetId') || readString(body, 'threadId');
    if (!targetType || !targetId) {
      return c.json({ error: 'targetType and targetId are required' }, 400);
    }

    if (targetType === 'user') {
      if (!options.allowUserTarget) return c.json({ error: 'Unsupported targetType' }, 400);
      await next();
      return;
    }

    let containerId: string;
    if (targetType === 'thread') {
      const thread = await deps.threadAdapter.getById(targetId);
      if (!thread || thread.status !== 'published') {
        return c.json({ error: 'Target not found' }, 404);
      }
      containerId = thread.containerId;
    } else if (targetType === 'reply') {
      const reply = await deps.replyAdapter.getById(targetId);
      if (!reply || reply.status !== 'published') {
        return c.json({ error: 'Target not found' }, 404);
      }
      if (reply.threadId) {
        const thread = await deps.threadAdapter.getById(reply.threadId);
        if (!thread || thread.status !== 'published') {
          return c.json({ error: 'Target not found' }, 404);
        }
      }
      containerId = reply.containerId;
    } else {
      return c.json({ error: 'Unsupported targetType' }, 400);
    }

    // `requireContainerIdMatch` exists to stop a client asserting a containerId
    // that doesn't belong to the target it names. A param-addressed route
    // asserts nothing — the guard resolved the real container from the target
    // above — so there is nothing to cross-check and demanding a body here
    // would just reinstate the 400 this fix removes.
    const requestedContainerId = readString(body, 'containerId');
    if (options.requireContainerIdMatch && !hasParamTarget) {
      if (!requestedContainerId) return c.json({ error: 'containerId is required' }, 400);
      if (requestedContainerId !== containerId) {
        return c.json({ error: 'Target/container mismatch' }, 400);
      }
    }

    if (options.attachContainerId && containerId && !hasParamTarget) {
      const normalized = { ...body, containerId };
      (c.req as unknown as { json: () => Promise<Record<string, unknown>> }).json = () =>
        Promise.resolve(normalized);
    }

    await next();
  };
}
