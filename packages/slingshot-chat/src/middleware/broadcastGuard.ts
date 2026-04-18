// packages/slingshot-chat/src/middleware/broadcastGuard.ts
import type { MiddlewareHandler } from 'hono';
import type { PermissionEvaluator } from '@lastshotlabs/slingshot-core';
import type { RoomAdapter } from '../types';

/**
 * Pre-middleware for Message create: reject non-admin sends in broadcast rooms.
 *
 * Broadcast rooms are read-only for regular members. Only users with `manage`
 * permission on the room may send messages. This middleware reads `roomId` from
 * the request body, fetches the room, and rejects with 403 when the room is
 * broadcast and the user lacks `manage` permission.
 *
 * @param deps - Room adapter, permission evaluator, and tenantId.
 * @returns A Hono `MiddlewareHandler`.
 * @internal
 */
export function createBroadcastGuardMiddleware(deps: {
  roomAdapter: RoomAdapter;
  evaluator: PermissionEvaluator;
  tenantId: string;
}): MiddlewareHandler {
  const { roomAdapter, evaluator, tenantId } = deps;

  return async (c, next) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const roomId = typeof body?.roomId === 'string' ? body.roomId : undefined;
    if (!roomId) return next();

    const room = await roomAdapter.getById(roomId);
    if (!room || room.type !== 'broadcast') return next();

    const userId = c.get('authUserId') as string | undefined;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const canManage = await evaluator.can({ subjectId: userId, subjectType: 'user' }, 'manage', {
      tenantId,
      resourceType: 'chat:room',
      resourceId: roomId,
    });

    if (!canManage) {
      return c.json({ error: 'Forbidden — broadcast room is read-only for non-admins' }, 403);
    }

    return next();
  };
}
