import type { MiddlewareHandler } from 'hono';
import type { RoomBanAdapter } from '../types';

/** Prevent a currently banned user from being added back to a room. */
export function createRoomBanGuardMiddleware(deps: { banAdapter: RoomBanAdapter; now?: () => number }): MiddlewareHandler {
  const now = deps.now ?? Date.now;
  return async (c, next) => {
    const body = await c.req.json().catch(() => null) as { roomId?: string; userId?: string } | null;
    if (!body?.roomId || !body.userId) return next();
    const ban = await deps.banAdapter.findByRoomUser(body.roomId, body.userId);
    const active = ban && !ban.liftedAt && (!ban.expiresAt || new Date(ban.expiresAt).getTime() > now());
    if (active) return c.json({ error: 'This user is banned from the room', code: 'ROOM_USER_BANNED' }, 409);
    return next();
  };
}
