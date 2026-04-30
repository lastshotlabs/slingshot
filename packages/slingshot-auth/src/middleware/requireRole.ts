import type { MiddlewareHandler } from 'hono';
import type { Actor, AppEnv } from '@lastshotlabs/slingshot-core';
import { getActor, getActorTenantId } from '@lastshotlabs/slingshot-core';
import { isProd } from '../lib/env';
import { getAuthRuntimeFromRequest } from '../runtime';
import { getAuthenticatedUserActor } from './userAuth';

async function getEffectiveRoles(
  adapter: import('@lastshotlabs/slingshot-core').AuthAdapter,
  userId: string,
  tenantId: string | null,
): Promise<string[]> {
  if (!adapter.getEffectiveRoles)
    throw new Error('Auth adapter does not implement getEffectiveRoles');
  return adapter.getEffectiveRoles(userId, tenantId);
}

/**
 * Middleware factory that enforces role-based access control (RBAC).
 *
 * Must be used after `userAuth` (requires an authenticated actor). Resolves the user's
 * effective role set for the authenticated user actor and returns `403 Forbidden` when
 * none of the required roles are present.
 *
 * Effective roles are written to the actor via `c.set('actor', ...)` for downstream handlers.
 *
 * When a tenant context is active (actor has a `tenantId`), role resolution is scoped
 * to that tenant. Use `requireRole.global()` to bypass tenant scoping and enforce
 * app-wide roles only.
 *
 * @param roles - One or more role names. Access is granted when the user has **any** of them.
 * @returns A Hono `MiddlewareHandler` that enforces the role check.
 *
 * @throws Requires `AuthAdapter.getEffectiveRoles` to be implemented — throws if missing.
 *
 * @example
 * import { userAuth, requireRole } from '@lastshotlabs/slingshot-auth';
 *
 * // Allow any user with the "admin" role
 * app.get('/admin', userAuth, requireRole('admin'), handler);
 *
 * // Allow users with either "admin" or "moderator"
 * app.get('/mod', userAuth, requireRole('admin', 'moderator'), handler);
 *
 * // Bypass tenant scoping for a super-admin gate
 * app.delete('/super-admin', userAuth, requireRole.global('superadmin'), handler);
 */
export const requireRole = Object.assign(
  (...roles: string[]): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
      const actor = getAuthenticatedUserActor(c);
      if (!actor) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const userId = actor.id;

      const runtime = getAuthRuntimeFromRequest(c);
      // Prefer actor tenantId, but fall back to raw context — tenant can be set
      // by route-level middleware after the actor was already resolved.
      const tenantId =
        getActorTenantId(c) ?? (c.get('tenantId') as string | null | undefined) ?? null;
      const effective = await getEffectiveRoles(runtime.adapter, userId, tenantId);

      // Update the actor with hydrated roles.
      const existing = getActor(c);
      c.set('actor', Object.freeze({ ...existing, roles: Object.freeze([...effective]) }) as Actor);

      if (!roles.some(r => effective.includes(r))) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      await next();
    },
  {
    /**
     * Always checks app-wide roles regardless of tenant context.
     * Use for super-admin gates that should ignore tenant scoping.
     *
     * SCOPE CONTRACT: only app-wide direct roles + app-wide group roles count here.
     * Tenant-scoped roles and tenant-scoped group roles are NEVER considered.
     * A user who is "admin" only in a tenant-scoped group is NOT a global admin —
     * they must be assigned the role app-wide.
     *
     * @example
     * app.get("/super-admin", userAuth, requireRole.global("superadmin"), handler)
     */
    global:
      (...roles: string[]): MiddlewareHandler<AppEnv> =>
      async (c, next) => {
        const actor = getAuthenticatedUserActor(c);
        if (!actor) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        const userId = actor.id;

        const runtime = getAuthRuntimeFromRequest(c);
        // In development, log when tenant context is present but intentionally ignored.
        // console.info is used deliberately: console.debug is suppressed by default in most
        // runtimes, so info gives reliably visible output during development without being
        // noisy in production (this branch never executes there).
        if (!isProd() && getActorTenantId(c)) {
          console.info(
            '[requireRole.global] tenant context present but intentionally ignored — checking app-wide roles only',
          );
        }

        const effective = await getEffectiveRoles(runtime.adapter, userId, null);

        // Update the actor with hydrated roles.
        const existing = getActor(c);
        c.set(
          'actor',
          Object.freeze({ ...existing, roles: Object.freeze([...effective]) }) as Actor,
        );

        if (!roles.some(r => effective.includes(r))) {
          return c.json({ error: 'Forbidden' }, 403);
        }

        await next();
      },
  },
);
