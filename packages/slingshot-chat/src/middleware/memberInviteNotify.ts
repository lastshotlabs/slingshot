import type { MiddlewareHandler } from 'hono';
import type { NotificationBuilder } from '@lastshotlabs/slingshot-core';
import { getActorId } from '@lastshotlabs/slingshot-core';
import type { RoomAdapter } from '../types';

/**
 * After-middleware for RoomMember create that stores invite notifications in
 * `slingshot-notifications`.
 *
 * @param deps - Resolved room adapter and source-scoped notification builder.
 * @returns Hono middleware.
 * @internal
 */
export function createMemberInviteNotifyMiddleware(deps: {
  builder: NotificationBuilder;
  roomAdapter: RoomAdapter;
}): MiddlewareHandler {
  const { builder, roomAdapter } = deps;

  return async (c, next) => {
    await next();

    if (c.res.status < 200 || c.res.status >= 300) return;

    const actorId = getActorId(c);
    const result = (await c.res.clone().json()) as {
      roomId?: string;
      userId?: string;
    } | null;

    if (!actorId || !result?.roomId || !result.userId || actorId === result.userId) return;

    const room = await roomAdapter.getById(result.roomId);

    await builder.notify({
      userId: result.userId,
      tenantId: room?.tenantId ?? undefined,
      type: 'chat:invite',
      actorId,
      targetType: 'chat:room',
      targetId: result.roomId,
      scopeId: result.roomId,
      dedupKey: `chat:invite:${result.roomId}:${result.userId}`,
      data: {
        roomId: result.roomId,
        roomName: room?.name ?? null,
        roomType: room?.type ?? null,
      },
    });
  };
}
