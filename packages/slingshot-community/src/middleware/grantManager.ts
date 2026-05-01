import type { MiddlewareHandler } from 'hono';
import type { PermissionsAdapter } from '@lastshotlabs/slingshot-core';
import { getActorTenantId } from '@lastshotlabs/slingshot-core';
import type { CommunityPrincipal } from '../types/env';

type ContainerMemberSnapshot = {
  role?: string;
  userId?: string;
  containerId?: string;
} | null;

const PERMISSION_ROLES = new Set(['member', 'moderator', 'owner']);

function resolveMemberId(c: Parameters<MiddlewareHandler>[0]): string | null {
  const fromParam = c.req.param('id');
  if (fromParam) return fromParam;
  const parts = c.req.path.split('/').filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
}

/**
 * Create a Hono after-middleware that reconciles permission grants with the
 * current container membership role.
 *
 * The middleware runs after successful membership mutations and keeps the
 * permissions store aligned with the resolved role:
 * - `create` / `assignRole` revoke old container-role grants and add the new
 *   role grant when the result is `member`, `moderator`, or `owner`
 * - `delete` revokes any managed grants for the removed member
 *
 * Grants are reconciled using the membership record itself rather than trusting
 * the request body, so stale owner/moderator grants are removed on demotion and
 * member removal as well as promotion.
 * @returns A Hono `MiddlewareHandler` suitable for use with `app.use()` or
 *   as route-level middleware on membership mutation endpoints.
 */
export function createGrantManagerMiddleware(deps: {
  permissionsAdapter: PermissionsAdapter;
  getMemberById(memberId: string): Promise<ContainerMemberSnapshot>;
}): MiddlewareHandler {
  return async (c, next) => {
    const opNameBefore = c.req.method === 'DELETE' ? 'delete' : undefined;
    const memberId = resolveMemberId(c);
    const memberBeforeDelete =
      opNameBefore === 'delete' && memberId ? await deps.getMemberById(memberId) : null;

    await next();
    if (c.res.status < 200 || c.res.status >= 300) return;

    const opName = (c.get('__opName' as never) as string | undefined) ?? opNameBefore ?? '';
    const principal = c.get('communityPrincipal') as CommunityPrincipal | undefined;
    const grantedBy = principal?.subject ?? 'system';
    const tenantId = getActorTenantId(c);

    const member =
      opName === 'delete' ? memberBeforeDelete : await readMemberFromResponse(c.res.clone());
    const containerId = member?.containerId ?? c.req.param('containerId');

    if (!member?.userId || !containerId) return;

    await revokeManagedRoleGrants(
      deps.permissionsAdapter,
      member.userId,
      containerId,
      grantedBy,
      tenantId,
    );

    if (opName === 'delete') return;

    if (member.role === 'member' || member.role === 'moderator' || member.role === 'owner') {
      await createRoleGrant(
        deps.permissionsAdapter,
        member.role,
        member.userId,
        containerId,
        grantedBy,
        tenantId,
      );
    }
  };
}

async function readMemberFromResponse(res: Response): Promise<ContainerMemberSnapshot> {
  try {
    return (await res.json()) as ContainerMemberSnapshot;
  } catch {
    // Response body is not valid JSON; treat as no member data
    return null;
  }
}

async function createRoleGrant(
  adapter: PermissionsAdapter,
  role: 'member' | 'moderator' | 'owner',
  userId: string,
  containerId: string,
  grantedBy: string,
  tenantId: string | null,
): Promise<void> {
  await adapter.createGrant({
    subjectId: userId,
    subjectType: 'user',
    tenantId,
    resourceType: 'community:container',
    resourceId: containerId,
    roles: [role],
    effect: 'allow',
    grantedBy,
  });
}

async function revokeManagedRoleGrants(
  adapter: PermissionsAdapter,
  userId: string,
  containerId: string,
  revokedBy: string,
  tenantId: string | null,
): Promise<void> {
  const existing = await adapter.getGrantsForSubject(userId, 'user', {
    tenantId,
    resourceType: 'community:container',
    resourceId: containerId,
  });

  const active = existing.filter(
    g =>
      g.effect === 'allow' &&
      !g.revokedAt &&
      g.roles.length > 0 &&
      g.roles.every(grantRole => PERMISSION_ROLES.has(grantRole)),
  );
  for (const grant of active) {
    await adapter.revokeGrant(grant.id, revokedBy, tenantId ?? undefined);
  }
}
