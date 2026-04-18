// packages/slingshot-chat/src/middleware/dmRoomGuard.ts
import type { MiddlewareHandler } from 'hono';
import type { RoomAdapter } from '../types';

/**
 * Pre-middleware for RoomMember create: reject member additions to DM rooms.
 *
 * DM rooms have fixed two-user membership set at creation time. This middleware
 * reads `roomId` from the URL parameter, looks up the room, and rejects with
 * 400 when the room is a DM.
 *
 * @param deps - Room adapter for looking up the room.
 * @returns A Hono `MiddlewareHandler`.
 * @internal
 */
export function createDmRoomGuardMiddleware(deps: { roomAdapter: RoomAdapter }): MiddlewareHandler {
  const { roomAdapter } = deps;

  return async (c, next) => {
    // Try URL param first, then request body
    const roomId =
      c.req.param('roomId') ??
      ((await c.req.json<Record<string, unknown>>().catch(() => null))?.roomId as
        | string
        | undefined);

    if (!roomId) return next();

    const room = await roomAdapter.getById(roomId);
    if (room?.type === 'dm') {
      return c.json({ error: 'Cannot add members to a DM room' }, 400);
    }

    return next();
  };
}
