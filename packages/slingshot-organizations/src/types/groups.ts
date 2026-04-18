import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

/**
 * Fine-grained access-control options for the groups management routes.
 *
 * Either `adminRole` or `middleware` can be used to protect the routes —
 * providing `middleware` overrides `adminRole` entirely.
 */
export interface GroupsManagementConfig {
  /**
   * Role required to access all management routes.
   * Applied via `requireRole.global(adminRole)`. Default: `"admin"`.
   * Ignored if `middleware` is provided.
   */
  adminRole?: string;
  /**
   * Fully replaces the default auth middleware stack
   * `[userAuth, requireRole.global(adminRole)]`. Use only when a single role
   * check is insufficient (e.g. multi-role OR logic, claim-based checks).
   * When provided, `adminRole` is ignored.
   */
  middleware?: MiddlewareHandler<AppEnv>[];
}

/**
 * Configuration for the groups sub-system within the organizations plugin.
 *
 * Set `managementRoutes` to mount group CRUD and membership management routes.
 * Pass `true` to use all defaults (`adminRole: "admin"`).
 */
export interface GroupsConfig {
  /**
   * Mount group management routes. Pass `true` to use all defaults, or a
   * `GroupsManagementConfig` object for custom access-control.
   */
  managementRoutes?: GroupsManagementConfig | true;
}
