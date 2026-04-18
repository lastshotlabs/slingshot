import type { MiddlewareHandler } from 'hono';
import type { PermissionEvaluator } from '@lastshotlabs/slingshot-core';
import type { CommunityPrincipal } from '../types/env';

/**
 * Create a Hono middleware that enforces the container-creation access policy.
 *
 * The `deps.containerCreation` value determines the required permission level:
 * - `'user'`: any authenticated request is allowed through. No permission check
 *   is performed and `next()` is called immediately.
 * - `'admin'`: the `communityPrincipal` context value must be present and the
 *   caller must have `write` permission on `'community:container'` resources. If
 *   the principal is absent a `401` is returned; if the permission check fails a
 *   `403` is returned.
 *
 * @param deps.containerCreation - The creation policy: `'admin'` requires a
 *   permission check; `'user'` allows everyone through.
 * @param deps.permissionEvaluator - The permission evaluator used to check
 *   `write` access on `'community:container'` when `containerCreation === 'admin'`.
 * @returns A Hono `MiddlewareHandler` suitable for use with `app.use()` or
 *   as route-level middleware on the container-creation endpoint.
 */
export function createContainerCreationGuardMiddleware(deps: {
  containerCreation: 'admin' | 'user';
  permissionEvaluator: PermissionEvaluator;
}): MiddlewareHandler {
  return async (c, next) => {
    if (deps.containerCreation === 'admin') {
      const principal = c.get('communityPrincipal') as CommunityPrincipal | undefined;
      if (!principal) return c.json({ error: 'Unauthorized' }, 401);
      const can = await deps.permissionEvaluator.can(
        { subjectId: principal.subject, subjectType: 'user' },
        'write',
        { resourceType: 'community:container' },
      );
      if (!can) return c.json({ error: 'Only admins can create containers' }, 403);
    }
    await next();
  };
}
