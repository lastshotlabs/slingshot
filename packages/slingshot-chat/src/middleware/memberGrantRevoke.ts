import type { MiddlewareHandler } from 'hono';
import { getActorId } from '@lastshotlabs/slingshot-core';
import type { PermissionsAdapter } from '@lastshotlabs/slingshot-core';
import type { RoomMemberAdapter } from '../types';

/** Revoke room access grants after a membership is successfully removed. */
export function createMemberGrantRevokeMiddleware(deps: {
  permissionsAdapter: PermissionsAdapter;
  memberAdapter: RoomMemberAdapter;
  tenantId: string | null;
}): MiddlewareHandler {
  return async (c, next) => {
    const id = c.req.param('id');
    const member = id ? await deps.memberAdapter.getById(id) : null;
    await next();
    if (!member || c.res.status < 200 || c.res.status >= 300) return;
    const revokedBy = getActorId(c) ?? 'system';
    const grants = await deps.permissionsAdapter.getGrantsForSubject(member.userId, 'user', {
      tenantId: deps.tenantId,
      resourceType: 'chat:room',
      resourceId: member.roomId,
    });
    await Promise.all(
      grants
        .filter(grant => !grant.revokedAt && grant.effect === 'allow')
        .map(grant =>
          deps.permissionsAdapter.revokeGrant(
            grant.id,
            revokedBy,
            deps.tenantId ?? undefined,
            'Room membership removed',
          ),
        ),
    );
  };
}
