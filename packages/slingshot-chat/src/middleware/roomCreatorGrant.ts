// packages/slingshot-chat/src/middleware/roomCreatorGrant.ts
import type { MiddlewareHandler } from 'hono';
import type { PermissionsAdapter } from '@lastshotlabs/slingshot-core';
import { getActorId } from '@lastshotlabs/slingshot-core';
import type { RoomMemberAdapter } from '../types';

/**
 * After-middleware for Room create: add creator as owner member and issue
 * an RBAC owner grant.
 *
 * Runs after the entity handler creates the room. Reads the created room from
 * the response body, creates an owner membership row, and issues an owner-level
 * RBAC grant so the creator has full control over the room.
 *
 * @param deps - Member adapter, permissions adapter, and tenantId.
 * @returns A Hono `MiddlewareHandler`.
 * @internal
 */
export function createRoomCreatorGrantMiddleware(deps: {
  memberAdapter: RoomMemberAdapter;
  permissionsAdapter: PermissionsAdapter;
  tenantId: string;
}): MiddlewareHandler {
  const { memberAdapter, permissionsAdapter, tenantId } = deps;

  return async (c, next) => {
    await next();

    if (c.res.status < 200 || c.res.status >= 300) return;

    const userId = getActorId(c);
    if (!userId) return;

    const cloned = c.res.clone();
    const result = (await cloned.json()) as { id?: string } | null;
    const roomId = result?.id;
    if (!roomId) return;

    // Add creator as owner member
    await memberAdapter.create({ roomId, userId, role: 'owner' });

    // Issue owner RBAC grant
    await permissionsAdapter.createGrant({
      subjectId: userId,
      subjectType: 'user',
      resourceType: 'chat:room',
      resourceId: roomId,
      tenantId,
      roles: ['owner'],
      effect: 'allow',
      grantedBy: userId,
    });
  };
}
