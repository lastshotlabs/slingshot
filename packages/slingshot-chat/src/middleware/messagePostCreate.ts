// packages/slingshot-chat/src/middleware/messagePostCreate.ts
import type { MiddlewareHandler } from 'hono';
import {
  type PermissionsAdapter,
  getActorId,
  getRequestTenantId,
  getSlingshotCtx,
} from '@lastshotlabs/slingshot-core';
import type { RoomAdapter } from '../types';

/**
 * After-middleware for Message create: issue an author grant and update the
 * room's `lastMessage` pointer.
 *
 * Runs after the entity handler creates the message. Side effects:
 * 1. Issues an `author` RBAC grant on the new message so the creator can
 *    later edit or delete it.
 * 2. Updates the room's `lastMessageAt` and `lastMessageId` fields.
 *
 * @param deps - Room adapter, permissions adapter, and tenantId.
 * @returns A Hono `MiddlewareHandler`.
 * @internal
 */
export function createMessagePostCreateMiddleware(deps: {
  roomAdapter: RoomAdapter;
  permissionsAdapter: PermissionsAdapter;
  tenantId: string;
}): MiddlewareHandler {
  const { roomAdapter, permissionsAdapter, tenantId } = deps;

  return async (c, next) => {
    await next();

    if (c.res.status < 200 || c.res.status >= 300) return;

    const userId = getActorId(c);
    if (!userId) return;

    const cloned = c.res.clone();
    const result = (await cloned.json()) as {
      id?: string;
      roomId?: string;
      authorId?: string;
      createdAt?: string;
      scheduledAt?: string | null;
    } | null;

    if (!result || !result.id || !result.roomId) return;

    // Scheduled messages: emit scheduled event, skip grant + lastMessage update.
    // The scheduler will deliver them later and update lastMessage at that point.
    const isScheduled = result.scheduledAt && new Date(result.scheduledAt).getTime() > Date.now();
    if (isScheduled) {
      getSlingshotCtx(c).events.publish(
        'chat:message.scheduled.created',
        {
          id: result.id,
          authorId: result.authorId ?? userId,
          roomId: result.roomId,
          scheduledAt: result.scheduledAt,
        },
        {
          source: 'http',
          userId,
          actorId: userId,
          requestTenantId: getRequestTenantId(c),
        },
      );
      return;
    }

    // Issue author grant so the message creator can edit/delete
    await permissionsAdapter.createGrant({
      subjectId: userId,
      subjectType: 'user',
      resourceType: 'chat:message',
      resourceId: result.id,
      tenantId,
      roles: ['author'],
      effect: 'allow',
      grantedBy: userId,
    });

    // Update room's lastMessage pointer
    await roomAdapter.updateLastMessage(
      { id: result.roomId },
      { lastMessageAt: result.createdAt ?? null, lastMessageId: result.id },
    );
  };
}
