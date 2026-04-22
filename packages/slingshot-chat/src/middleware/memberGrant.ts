// packages/slingshot-chat/src/middleware/memberGrant.ts
import type { MiddlewareHandler } from 'hono';
import type { PermissionsAdapter } from '@lastshotlabs/slingshot-core';
import { getActorId } from '@lastshotlabs/slingshot-core';

/**
 * After-middleware for RoomMember create: issue a member-level RBAC grant.
 *
 * Runs after the entity handler creates the membership row. Reads the created
 * member from the response body and issues a `member` grant so the newly added
 * user has read/write access to the room.
 *
 * @param deps - Permissions adapter and tenantId.
 * @returns A Hono `MiddlewareHandler`.
 * @internal
 */
export function createMemberGrantMiddleware(deps: {
  permissionsAdapter: PermissionsAdapter;
  tenantId: string;
}): MiddlewareHandler {
  const { permissionsAdapter, tenantId } = deps;

  return async (c, next) => {
    await next();

    if (c.res.status < 200 || c.res.status >= 300) return;

    const grantedBy = getActorId(c);
    if (!grantedBy) return;

    const cloned = c.res.clone();
    const result = (await cloned.json()) as {
      userId?: string;
      roomId?: string;
    } | null;

    if (!result || !result.userId || !result.roomId) return;

    await permissionsAdapter.createGrant({
      subjectId: result.userId,
      subjectType: 'user',
      resourceType: 'chat:room',
      resourceId: result.roomId,
      tenantId,
      roles: ['member'],
      effect: 'allow',
      grantedBy,
    });
  };
}
