import type { MiddlewareHandler } from 'hono';
import type { EntityAdapter } from '@lastshotlabs/slingshot-core';
import type { Reply, Thread } from '../types/models';

type ThreadAdapter = EntityAdapter<Thread, Record<string, unknown>, Record<string, unknown>>;
type ReplyAdapter = EntityAdapter<Reply, Record<string, unknown>, Record<string, unknown>>;

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
 */
export function createContentTargetGuardMiddleware(
  deps: {
    threadAdapter: ThreadAdapter;
    replyAdapter: ReplyAdapter;
  },
  options: GuardOptions = {},
): MiddlewareHandler {
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

    const targetType =
      readString(body, 'targetType') || (readString(body, 'threadId') ? 'thread' : '');
    const targetId = readString(body, 'targetId') || readString(body, 'threadId');
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

    const requestedContainerId = readString(body, 'containerId');
    if (options.requireContainerIdMatch) {
      if (!requestedContainerId) return c.json({ error: 'containerId is required' }, 400);
      if (requestedContainerId !== containerId) {
        return c.json({ error: 'Target/container mismatch' }, 400);
      }
    }

    if (options.attachContainerId && containerId) {
      const normalized = { ...body, containerId };
      (c.req as unknown as { json: () => Promise<Record<string, unknown>> }).json = () =>
        Promise.resolve(normalized);
    }

    await next();
  };
}
