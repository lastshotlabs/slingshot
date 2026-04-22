import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HttpError, getActorId } from '@lastshotlabs/slingshot-core';
import { getAuthRuntimeFromRequest } from '../runtime';

const EXEMPT_PREFIXES = ['/auth/', '/health', '/docs', '/openapi.json'];

/**
 * Middleware that blocks authenticated users who have not completed MFA setup.
 *
 * When `auth.mfa.required` is `true`, this middleware is applied globally by
 * `createApp`. It can also be applied per-route for finer control:
 *
 * @example
 * import { requireMfaSetup } from "@lastshotlabs/slingshot";
 * router.use("/dashboard", userAuth, requireMfaSetup);
 *
 * Exempt paths: `/auth/*`, `/health`, `/docs`, `/openapi.json`, and the root `/`.
 * Unauthenticated requests pass through — use `userAuth` to block those.
 */
export const requireMfaSetup: MiddlewareHandler<AppEnv> = async (c, next) => {
  const rawPath = c.req.path;

  // Strip version prefix if present (e.g., /v1/auth/... → /auth/...)
  const path = rawPath.replace(/^\/v\d+/, '');

  // Exempt paths — auth routes (including MFA setup), health, docs, root
  if (path === '/' || EXEMPT_PREFIXES.some(p => path.startsWith(p))) {
    return next();
  }

  // Only applies to authenticated users — unauthenticated requests pass through
  const userId = getActorId(c);
  if (!userId) {
    return next();
  }

  const adapter = getAuthRuntimeFromRequest(c).adapter;
  if (!adapter.isMfaEnabled) {
    return next();
  }

  const enabled = await adapter.isMfaEnabled(userId);
  if (!enabled) {
    throw new HttpError(403, 'MFA setup required', 'MFA_SETUP_REQUIRED');
  }

  return next();
};
