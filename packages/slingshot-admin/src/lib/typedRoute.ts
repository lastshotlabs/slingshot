import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRouter } from '@lastshotlabs/slingshot-core';
import type { AdminEnv } from '../types/env';

/**
 * Register an OpenAPI route on an `OpenAPIHono<AdminEnv>` router, working
 * around the generic type erasure that occurs when route definitions are
 * produced by `createRoute()` from `@hono/zod-openapi`.
 *
 * `@hono/zod-openapi`'s `router.openapi()` overload resolution breaks when
 * the route object is typed as the inferred return type of `createRoute()`
 * rather than an inline literal — TypeScript widens the generics and the
 * handler's request/response types no longer align. This wrapper consolidates
 * the single unavoidable cast in one place so that all route files remain
 * cast-free.
 *
 * The `as unknown as CallSite` two-step is the canonical escape hatch at
 * opaque optional-dep type boundaries where overloaded generics cannot be
 * preserved through type inference (see engineering-rules §4).
 *
 * @remarks
 * This helper is an internal implementation detail of `slingshot-admin`.
 * It is **not** part of the public package entry point. Route files within
 * `slingshot-admin` import it from `'../lib/typedRoute'`.
 *
 * @param router - The `OpenAPIHono<AdminEnv>` instance to register the route on.
 * @param route - Route definition produced by `createRoute()`.
 * @param handler - Hono route handler typed for `AdminEnv`.
 * @returns The router itself (for chaining), as returned by `router.openapi()`.
 *
 * @example
 * ```ts
 * import { createTypedRouter, registerRoute } from '../lib/typedRoute';
 * import { createRoute } from '@lastshotlabs/slingshot-core';
 *
 * const router = createTypedRouter();
 * const getUser = createRoute({ method: 'get', path: '/users/:id', ... });
 * registerRoute(router, getUser, async (c) => c.json({ id: c.req.param('id') }));
 * ```
 */
export function registerRoute(
  router: OpenAPIHono<AdminEnv>,
  route: Parameters<OpenAPIHono<AdminEnv>['openapi']>[0],
  handler: Parameters<OpenAPIHono<AdminEnv>['openapi']>[1],
): OpenAPIHono<AdminEnv> {
  type CallSite = (
    route: Parameters<OpenAPIHono<AdminEnv>['openapi']>[0],
    handler: Parameters<OpenAPIHono<AdminEnv>['openapi']>[1],
  ) => OpenAPIHono<AdminEnv>;
  return (router.openapi as unknown as CallSite)(route, handler);
}

/**
 * Create a typed `OpenAPIHono` router scoped to `AdminEnv`.
 *
 * Calls `createRouter()` from `slingshot-core` (which produces a plain
 * `OpenAPIHono` instance) and narrows it to `OpenAPIHono<AdminEnv>` via a
 * double-cast. This cast is safe because `AdminEnv` only adds variables
 * (`adminPrincipal`, etc.) that are populated by the admin middleware before
 * any route handler runs.
 *
 * @remarks
 * All internal admin route factories should call this instead of
 * `createRouter()` directly so that every route handler in the admin package
 * has fully-typed access to `c.get('adminPrincipal')` and related env vars.
 *
 * @returns An `OpenAPIHono<AdminEnv>` router ready for route registration.
 *
 * @example
 * ```ts
 * import { createTypedRouter } from '../lib/typedRoute';
 *
 * export function createAdminRouter(config: AdminRouterConfig) {
 *   const router = createTypedRouter();
 *   // registerRoute(router, ...) calls here
 *   return router;
 * }
 * ```
 */
export function createTypedRouter(): OpenAPIHono<AdminEnv> {
  return createRouter() as unknown as OpenAPIHono<AdminEnv>;
}
