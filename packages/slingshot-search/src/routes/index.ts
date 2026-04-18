/**
 * Named route group identifiers for the search plugin.
 *
 * Pass values to `SearchPluginConfig.disableRoutes` to suppress specific
 * route groups at startup.
 *
 * @example
 * ```ts
 * import { createSearchPlugin, SEARCH_ROUTES } from '@lastshotlabs/slingshot-search';
 *
 * const search = createSearchPlugin({
 *   providers: { default: { provider: 'db-native' } },
 *   disableRoutes: [SEARCH_ROUTES.ADMIN, SEARCH_ROUTES.FEDERATED],
 * });
 * ```
 */
export const SEARCH_ROUTES = {
  SEARCH: 'search',
  SUGGEST: 'suggest',
  FEDERATED: 'federated',
  ADMIN: 'admin',
} as const;

/**
 * Union type of valid search route group names.
 *
 * @see SEARCH_ROUTES
 */
export type SearchRoute = (typeof SEARCH_ROUTES)[keyof typeof SEARCH_ROUTES];
