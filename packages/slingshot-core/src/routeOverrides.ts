/**
 * A branded route key string in the format `"METHOD /path"` (method always uppercased).
 *
 * Constructed exclusively via `routeKey()` — never hand-typed — to prevent drift between
 * the route constant definition and the `shouldMountRoute` runtime check.
 *
 * @template M - The HTTP method string (e.g. `'GET'`).
 * @template P - The route path string (e.g. `'/items'`).
 */
export type RouteKey<M extends string, P extends string> = `${Uppercase<M>} ${P}`;

/**
 * Construct a typed `RouteKey` from an HTTP method and path.
 *
 * Use this to define `ROUTES` constants in plugin packages. `shouldMountRoute` calls
 * the same function internally, ensuring the constant value and the runtime check always match.
 *
 * @param method - HTTP method string (case-insensitive; uppercased automatically).
 * @param path - Route path string (e.g. `'/items'`, `'/items/:id'`).
 * @returns A `RouteKey<M, P>` string in the form `"METHOD /path"`.
 *
 * @example
 * ```ts
 * import { routeKey } from '@lastshotlabs/slingshot-core';
 *
 * export const MY_ROUTES = [
 *   routeKey('GET', '/items'),
 *   routeKey('POST', '/items'),
 *   routeKey('DELETE', '/items/:id'),
 * ] as const;
 * ```
 */
export function routeKey<M extends string, P extends string>(method: M, path: P): RouteKey<M, P> {
  return `${method.toUpperCase()} ${path}` as RouteKey<M, P>;
}

/**
 * Returns `true` if the route should be mounted — i.e., it is NOT in `disabledRoutes`.
 *
 * Constructs a `RouteKey` from `method` and `path` internally, so the check is always
 * consistent with constants defined using `routeKey()`.
 *
 * @param method - The HTTP method (e.g. `'GET'`).
 * @param path - The route path (e.g. `'/items'`).
 * @param disabledRoutes - Optional array of route keys to exclude from mounting.
 * @returns `true` if the route should be registered, `false` if it is disabled.
 *
 * @example
 * ```ts
 * import { shouldMountRoute } from '@lastshotlabs/slingshot-core';
 *
 * if (shouldMountRoute('GET', '/items', config.disableRoutes)) {
 *   router.openapi(listRoute, listHandler);
 * }
 * ```
 */
export function shouldMountRoute(
  method: string,
  path: string,
  disabledRoutes?: readonly string[],
): boolean {
  if (!disabledRoutes?.length) return true;
  return !disabledRoutes.includes(routeKey(method, path));
}
