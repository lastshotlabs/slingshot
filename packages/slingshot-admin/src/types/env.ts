import type { AppEnv } from '@lastshotlabs/slingshot-core';
import type { AdminPrincipal } from '@lastshotlabs/slingshot-core';

/**
 * Extra Hono context variables injected by the admin access-guard middleware.
 * After the guard runs, `c.get('adminPrincipal')` is always a valid
 * `AdminPrincipal` — the middleware rejects the request with 401 before
 * reaching a route handler if the principal cannot be resolved.
 */
export type AdminVariables = { adminPrincipal: AdminPrincipal };

/**
 * Hono environment type for admin routes. Extends AppEnv with adminPrincipal.
 * Uses intersection to add the admin variable while keeping AppEnv compatibility.
 * The defaultHook cast (Hook<AppEnv> → Hook<AdminEnv>) is safe because AdminEnv
 * only adds variables; existing AppEnv variables remain accessible.
 */
export type AdminEnv = { Variables: AppEnv['Variables'] & AdminVariables };
