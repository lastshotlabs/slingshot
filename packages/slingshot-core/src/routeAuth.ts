import { type ContextCarrier, resolveContext } from './context/contextAccess';
import type { RouteAuthRegistry } from './coreContracts';

export type { RouteAuthRegistry };

/**
 * Retrieve the `RouteAuthRegistry` registered on a Slingshot app or context instance.
 *
 * The `RouteAuthRegistry` provides Hono middleware for `userAuth`, `requireRole`, and
 * `bearerAuth` — used by framework-owned routes (jobs, metrics, uploads) when configured
 * with `auth: 'userAuth'`. The auth plugin registers its registry during `setupPost`.
 *
 * @param input - A `SlingshotContext` or a Hono app with an attached context.
 * @returns The registered `RouteAuthRegistry`.
 * @throws If no registry has been registered (auth plugin not installed).
 *
 * @example
 * ```ts
 * import { getRouteAuth, getContext } from '@lastshotlabs/slingshot-core';
 *
 * const auth = getRouteAuth(getContext(app));
 * router.use('/admin/*', auth.requireRole('admin'));
 * ```
 */
export function getRouteAuth(input: ContextCarrier): RouteAuthRegistry {
  const registry = resolveContext(input).routeAuth;
  if (registry === null) {
    throw new Error(
      'No RouteAuthRegistry registered for this app instance. The auth plugin must be registered when using auth: "userAuth" in jobs, metrics, or uploads config.',
    );
  }
  return registry;
}

/**
 * Retrieve the `RouteAuthRegistry` registered on a Slingshot app or context instance,
 * returning `null` if none has been registered.
 *
 * @param input - A `SlingshotContext` or a Hono app with an attached context.
 * @returns The registered `RouteAuthRegistry`, or `null` if the auth plugin is absent.
 */
export function getRouteAuthOrNull(input: ContextCarrier): RouteAuthRegistry | null {
  return resolveContext(input).routeAuth;
}
