import type {
  GroupResolver,
  PluginSeedContext,
  PluginSetupContext,
  PluginStateMap,
  SlingshotPlugin,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  PERMISSIONS_STATE_KEY,
  SUPER_ADMIN_ROLE,
  getPluginState,
  resolveRepo,
} from '@lastshotlabs/slingshot-core';
import type { PermissionsState } from '@lastshotlabs/slingshot-core';
import { permissionsAdapterFactories } from './factories';
import { createPermissionEvaluator } from './lib/evaluator';
import { createPermissionRegistry } from './lib/registry';

export interface PermissionsPluginConfig {
  /**
   * Override the store backend for the permissions adapter.
   * When omitted the plugin falls back to `frameworkConfig.resolvedStores.authStore`.
   */
  adapter?: 'sqlite' | 'postgres' | 'mongo' | 'memory';

  /**
   * Optional group resolver for expanding user → group membership during permission checks.
   * Receives the plugin state map so it can lazily read peer plugin runtime.
   *
   * When omitted, group expansion is disabled — grants to groups never apply to users.
   *
   * To integrate with `slingshot-auth`, pass `createAuthGroupResolver`:
   * @example
   * ```ts
   * import {
   *   createPermissionsPlugin,
   *   createAuthGroupResolver,
   * } from '@lastshotlabs/slingshot-permissions';
   * import { getAuthRuntimePeerOrNull } from '@lastshotlabs/slingshot-core';
   *
   * createPermissionsPlugin({
   *   groupResolver: (pluginState) =>
   *     createAuthGroupResolver(() => getAuthRuntimePeerOrNull(pluginState)),
   * });
   * ```
   */
  groupResolver?: (pluginState: PluginStateMap) => GroupResolver;
}

/**
 * Creates the slingshot-permissions plugin.
 *
 * Resolves the permissions adapter from the active store type during
 * `setupMiddleware` and stores a frozen `PermissionsState`
 * (`{ evaluator, registry, adapter }`) in `ctx.pluginState` under
 * `PERMISSIONS_STATE_KEY`. Plugins that require permissions (e.g.
 * `slingshot-community`, `slingshot-content`) declare `'slingshot-permissions'`
 * as a dependency and read the shared state from `pluginState` instead of
 * constructing their own instances.
 *
 * Group expansion is disabled by default. To resolve user → group membership
 * from `slingshot-auth`, pass a `groupResolver` factory via config.
 *
 * Registration order: declare this plugin before any consumer plugin so the
 * framework's topological sort places its `setupMiddleware` first.
 *
 * @returns A `SlingshotPlugin` ready to register with `createApp()`.
 *
 * @example Standalone (no auth integration)
 * ```ts
 * import { createPermissionsPlugin } from '@lastshotlabs/slingshot-permissions';
 *
 * const { app } = await createApp({
 *   plugins: [createPermissionsPlugin()],
 * });
 * ```
 *
 * @example With slingshot-auth group resolution
 * ```ts
 * import {
 *   createPermissionsPlugin,
 *   createAuthGroupResolver,
 * } from '@lastshotlabs/slingshot-permissions';
 * import { getAuthRuntimePeerOrNull } from '@lastshotlabs/slingshot-core';
 *
 * const { app } = await createApp({
 *   plugins: [
 *     createAuthPlugin({ auth: { roles: ['user', 'admin'] } }),
 *     createPermissionsPlugin({
 *       groupResolver: (pluginState) =>
 *         createAuthGroupResolver(() => getAuthRuntimePeerOrNull(pluginState)),
 *     }),
 *   ],
 * });
 * ```
 */
export function createPermissionsPlugin(config?: PermissionsPluginConfig): SlingshotPlugin {
  return {
    name: 'slingshot-permissions',

    async setupMiddleware({ app, config: frameworkConfig }: PluginSetupContext) {
      const pluginState = getPluginState(app);
      // Idempotent — if another plugin already seeded permissions state, skip.
      if (pluginState.has(PERMISSIONS_STATE_KEY)) return;

      const storeType: StoreType = config?.adapter ?? frameworkConfig.resolvedStores.authStore;
      const infra = frameworkConfig.storeInfra;
      if (storeType === 'redis') {
        throw new Error(
          '[slingshot-permissions] Redis is not supported as a permissions store. Configure permissions with memory, sqlite, mongo, or postgres.',
        );
      }

      const registry = createPermissionRegistry();
      // Some adapter factories are async (e.g. Mongo); await via Promise.resolve
      // so synchronous adapters (SQLite, memory) are handled without special-casing.
      const adapter = await Promise.resolve(
        resolveRepo(permissionsAdapterFactories, storeType, infra),
      );
      const groupResolver = config?.groupResolver?.(pluginState);
      const evaluator = createPermissionEvaluator({ registry, adapter, groupResolver });

      pluginState.set(PERMISSIONS_STATE_KEY, Object.freeze({ evaluator, registry, adapter }));
    },

    async seed({ app, seedState }: PluginSeedContext) {
      const pluginState = getPluginState(app);
      const permsState = pluginState.get(PERMISSIONS_STATE_KEY) as PermissionsState | undefined;
      if (!permsState?.adapter) return;

      for (const [key, value] of seedState) {
        if (!key.startsWith('superAdmin:') || value !== true) continue;
        const email = key.slice('superAdmin:'.length);
        const userId = seedState.get(`user:${email}`) as string | undefined;
        if (!userId) {
          console.warn(
            `[slingshot-permissions seed] superAdmin requested for '${email}' but no user ID found in seedState — grant skipped.`,
          );
          continue;
        }
        await permsState.adapter.createGrant({
          subjectId: userId,
          subjectType: 'user',
          tenantId: null,
          resourceType: null,
          resourceId: null,
          roles: [SUPER_ADMIN_ROLE],
          effect: 'allow',
          grantedBy: 'manifest-seed',
        });
        console.log(`[slingshot-permissions seed] Granted super-admin to '${email}'.`);
      }
    },
  };
}
