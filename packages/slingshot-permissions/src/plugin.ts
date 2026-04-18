import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { PERMISSIONS_STATE_KEY, getContext, resolveRepo } from '@lastshotlabs/slingshot-core';
import { permissionsAdapterFactories } from './factories';
import { createAuthGroupResolver } from './lib/authGroupResolver';
import { createPermissionEvaluator } from './lib/evaluator';
import { createPermissionRegistry } from './lib/registry';

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
 * Registration order: declare this plugin before any consumer plugin so the
 * framework's topological sort places its `setupMiddleware` first.
 *
 * @returns A `SlingshotPlugin` ready to register with `createApp()`.
 *
 * @example
 * ```ts
 * import { createPermissionsPlugin } from '@lastshotlabs/slingshot-permissions';
 *
 * const { app } = await createApp({
 *   plugins: [
 *     createPermissionsPlugin(),
 *     createCommunityPlugin({ containerCreation: 'admin' }),
 *   ],
 * });
 * ```
 */
export function createPermissionsPlugin(): SlingshotPlugin {
  return {
    name: 'slingshot-permissions',

    async setupMiddleware({ app, config: frameworkConfig }: PluginSetupContext) {
      const ctx = getContext(app);
      // Idempotent — if another plugin already seeded permissions state, skip.
      if (ctx.pluginState.has(PERMISSIONS_STATE_KEY)) return;

      const storeType = frameworkConfig.resolvedStores.authStore;
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
      const evaluator = createPermissionEvaluator({
        registry,
        adapter,
        groupResolver: createAuthGroupResolver(
          () => ctx.pluginState.get('slingshot-auth') as { adapter?: object } | null | undefined,
        ),
      });

      ctx.pluginState.set(PERMISSIONS_STATE_KEY, Object.freeze({ evaluator, registry, adapter }));
    },
  };
}
