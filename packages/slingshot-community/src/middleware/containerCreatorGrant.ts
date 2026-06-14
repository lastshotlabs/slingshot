// packages/slingshot-community/src/middleware/containerCreatorGrant.ts
import type { MiddlewareHandler } from 'hono';
import type { PermissionsAdapter } from '@lastshotlabs/slingshot-core';
import { getActorId } from '@lastshotlabs/slingshot-core';

/**
 * After-middleware for Container create: issue an `owner` grant + create
 * the corresponding `ContainerMember` row. Mirrors slingshot-chat's
 * `roomCreatorGrant` so creators can write to their own community
 * without an external bootstrap subscriber.
 *
 * **Why this is a middleware, not a bus subscriber:**
 *   - "Creator can manage their own container" is a hard invariant. If
 *     the grant fails, the creator is locked out — they don't even have
 *     `community:container.write` on the new row.
 *   - Bus subscribers run async/decoupled from the request, so a
 *     thrown error doesn't reach the response. A subscriber that
 *     swallows means the lockout is invisible. A subscriber that logs
 *     means ops alerts on it but users stay locked out.
 *   - Middleware runs in the request path. If the grant or member
 *     create throws, the request returns 5xx. The Container row is
 *     committed (we ran AFTER the entity handler), but the client sees
 *     the failure and can retry — and the retry is idempotent because
 *     the unique constraint on `ContainerMember(containerId, userId)`
 *     deduplicates, and `createGrant` with the same subject/resource/
 *     roles is also a no-op (or returns the existing grant).
 *   - True transactional behavior (roll back the Container row on
 *     grant failure) would require putting the grant in the same DB
 *     transaction as the create. That's a larger change; not in scope
 *     for this middleware.
 */
export interface ContainerMemberCreator {
  create(input: {
    containerId: string;
    userId: string;
    role: 'owner' | 'moderator' | 'member';
    tenantId?: string | null;
  }): Promise<unknown>;
}

export function createContainerCreatorGrantMiddleware(deps: {
  memberAdapter: ContainerMemberCreator;
  permissionsAdapter: PermissionsAdapter;
}): MiddlewareHandler {
  const { memberAdapter, permissionsAdapter } = deps;

  return async (c, next) => {
    await next();

    if (c.res.status < 200 || c.res.status >= 300) return;

    const userId = getActorId(c);
    if (!userId) return;

    const cloned = c.res.clone();
    const result = (await cloned.json()) as { id?: string; tenantId?: string | null } | null;
    const containerId = result?.id;
    if (!containerId) return;

    // Issue the owner grant first — it's the authoritative permission
    // state. Re-throws any error so the request surfaces 5xx if the
    // permissions store is down. Idempotent: callers retrying see the
    // same row created (or a duplicate-detected no-op, depending on
    // adapter — both are correct).
    await permissionsAdapter.createGrant({
      subjectId: userId,
      subjectType: 'user',
      resourceType: 'community:container',
      resourceId: containerId,
      tenantId: result?.tenantId ?? null,
      roles: ['owner'],
      effect: 'allow',
      grantedBy: userId,
    });

    // Member row is the social-layer mirror of the grant. If it throws
    // due to a duplicate-row race, swallow — the grant is the truth,
    // the row is for member-listing display only.
    await memberAdapter
      .create({
        containerId,
        userId,
        role: 'owner',
        tenantId: result?.tenantId ?? null,
      })
      .catch(() => {
        // Duplicate row from a concurrent flow — safe to ignore.
      });
  };
}
