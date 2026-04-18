/**
 * Middleware that blocks message creation in archived rooms.
 *
 * Runs before other message-create middleware. Reads `roomId` from the
 * request body, fetches the room, and returns 403 if `room.archived === true`.
 *
 * @module
 */
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { RoomAdapter } from '../types';

/**
 * Build the archive guard middleware.
 *
 * @param deps.roomAdapter - Room adapter for fetching room state.
 */
export function createArchiveGuardMiddleware(deps: {
  roomAdapter: RoomAdapter;
}): MiddlewareHandler {
  return async (c, next) => {
    const body = (await c.req.json().catch(() => null)) as { roomId?: string } | null;
    const roomId = body?.roomId ?? c.req.param('roomId');
    if (!roomId) return next();

    const room = await deps.roomAdapter.getById(roomId);
    if (room?.archived) {
      throw new HTTPException(403, { message: 'Room is archived — messages cannot be sent' });
    }
    await next();
  };
}
