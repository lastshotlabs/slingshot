import type { MiddlewareHandler } from 'hono';
import { getActorId } from '@lastshotlabs/slingshot-core';
import type { MessageAdapter, RoomAdapter } from '../types';

/** Enforce a room's configured per-author posting interval. */
export function createSlowModeGuardMiddleware(deps: {
  roomAdapter: RoomAdapter;
  messageAdapter: MessageAdapter;
  now?: () => number;
}): MiddlewareHandler {
  const now = deps.now ?? Date.now;
  const lastAcceptedAt = new Map<string, number>();
  return async (c, next) => {
    const body = (await c.req.json().catch(() => null)) as { roomId?: string } | null;
    const roomId = body?.roomId;
    const actorId = getActorId(c);
    if (!roomId || !actorId) return next();
    const room = await deps.roomAdapter.getById(roomId);
    const interval = room?.slowModeSeconds ?? 0;
    if (interval <= 0) return next();
    const cacheKey = `${roomId}:${actorId}`;
    const cachedAt = lastAcceptedAt.get(cacheKey);
    const messages = await deps.messageAdapter.listByRoom({ roomId, limit: 50 });
    const latest = messages.items
      .filter((message) => message.authorId === actorId && !message.deletedAt)
      .reduce<(typeof messages.items)[number] | null>((candidate, message) =>
        !candidate || new Date(message.createdAt).getTime() > new Date(candidate.createdAt).getTime()
          ? message
          : candidate, null);
    const latestAt = Math.max(cachedAt ?? 0, latest ? new Date(latest.createdAt).getTime() : 0);
    if (latestAt > 0) {
      const elapsed = Math.floor((now() - latestAt) / 1000);
      const remaining = interval - elapsed;
      if (remaining > 0) {
        return c.json(
          { error: `Slow mode — try again in ${remaining}s` },
          429,
          { 'Retry-After': String(remaining) },
        );
      }
    }
    await next();
    if (c.res.status >= 200 && c.res.status < 300) lastAcceptedAt.set(cacheKey, now());
  };
}
