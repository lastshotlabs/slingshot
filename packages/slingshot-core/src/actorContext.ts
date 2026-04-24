import type { Context } from 'hono';
import type { AppEnv } from './context';
import { ANONYMOUS_ACTOR, type Actor } from './identity';

/**
 * Resolve the canonical actor for a Hono request context.
 *
 * Reads the `actor` variable published by the auth middleware (identify,
 * bearerAuth, or a custom identity middleware). Returns {@link ANONYMOUS_ACTOR}
 * when no actor has been published.
 *
 * @param c - The Hono request context.
 * @returns The resolved {@link Actor} — never `null`.
 */
export function getActor(c: Context<AppEnv>): Actor {
  return c.get('actor') ?? ANONYMOUS_ACTOR;
}

/**
 * Resolve the current actor ID from request context.
 *
 * Returns `null` for anonymous requests.
 */
export function getActorId(c: Context<AppEnv>): string | null {
  return getActor(c).id;
}

/**
 * Resolve the current actor tenant scope from request context.
 *
 * Returns `null` for tenantless actors and single-tenant requests.
 */
export function getActorTenantId(c: Context<AppEnv>): string | null {
  return getActor(c).tenantId;
}

/**
 * Resolve the request-scoped tenant ID from the Hono context.
 *
 * This is the tenant context set by tenant-resolution middleware (e.g. from
 * a header or subdomain), distinct from `getActorTenantId` which returns
 * the tenant the actor belongs to. They usually match but can differ for
 * cross-tenant operations.
 *
 * Returns `null` in single-tenant mode or when tenant resolution is not active.
 */
export function getRequestTenantId(c: Context<AppEnv>): string | null {
  const value = c.get('tenantId');
  return typeof value === 'string' && value.length > 0 ? value : null;
}
