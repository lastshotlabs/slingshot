/**
 * Lazy permissions resolver — resolves from explicit config or pluginState fallback.
 *
 * Returns a getter that caches the result after first resolution. Avoids
 * duplicating the fallback logic across setupRoutes and setupPost.
 */
import type {
  PermissionEvaluator,
  PermissionRegistry,
  PermissionsAdapter,
} from '@lastshotlabs/slingshot-core';
import type { PermissionsState } from '@lastshotlabs/slingshot-core';
import { PERMISSIONS_STATE_KEY, getContextOrNull } from '@lastshotlabs/slingshot-core';

/** The shape of the permissions config on EntityPluginConfig. */
export interface ResolvedPermissions {
  evaluator: PermissionEvaluator;
  registry: PermissionRegistry;
  adapter: PermissionsAdapter;
}

/**
 * Create a lazy permissions resolver.
 *
 * On first call, resolves from `explicitPermissions` if provided, otherwise
 * reads from `pluginState[PERMISSIONS_STATE_KEY]`. Caches the result so
 * subsequent calls return the same value without re-reading pluginState.
 *
 * @param explicitPermissions - Permissions passed directly in EntityPluginConfig.
 * @returns A function `(app: object) => ResolvedPermissions | undefined`.
 */
export function createPermissionsResolver(
  explicitPermissions: ResolvedPermissions | undefined,
): (app: object) => ResolvedPermissions | undefined {
  let cached: ResolvedPermissions | undefined;
  let resolved = false;

  return (app: object): ResolvedPermissions | undefined => {
    if (resolved) return cached;
    resolved = true;

    if (explicitPermissions) {
      cached = explicitPermissions;
      return cached;
    }

    const state = getContextOrNull(app)?.pluginState.get(PERMISSIONS_STATE_KEY) as
      | PermissionsState
      | undefined;
    if (state) {
      cached = {
        evaluator: state.evaluator,
        registry: state.registry,
        adapter: state.adapter,
      };
    }

    return cached;
  };
}
