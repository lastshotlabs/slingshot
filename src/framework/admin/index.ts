import type { AdminPluginConfig } from '@lastshotlabs/slingshot-admin';
import {
  createSlingshotAuthAccessProvider,
  createSlingshotManagedUserProvider,
  getAuthRuntimeContext,
} from '@lastshotlabs/slingshot-auth';
import {
  PERMISSIONS_STATE_KEY,
  type PermissionsState,
  type PluginSetupContext,
  type SlingshotPlugin,
  getPermissionsStateOrNull,
  getPluginState,
} from '@lastshotlabs/slingshot-core';

/**
 * Configuration for the Slingshot-integrated admin plugin.
 *
 * Extends `AdminPluginConfig` with optional overrides for `accessProvider`,
 * `managedUserProvider`, and `permissions`. When these are omitted, sensible
 * framework defaults are resolved automatically:
 *
 * - `accessProvider` defaults to {@link createSlingshotAuthAccessProvider}, which
 *   reads permissions from the auth runtime context.
 * - `managedUserProvider` defaults to {@link createSlingshotManagedUserProvider},
 *   constructed from the auth runtime adapter, config, and session repository.
 * - `permissions` defaults to the value stored under `PERMISSIONS_STATE_KEY` in
 *   `ctx.pluginState` — set by the community plugin or another permissions source
 *   during its `setupRoutes` phase.
 *
 * All three are required at route-registration time. If `permissions` is not provided
 * and no plugin has populated `PERMISSIONS_STATE_KEY`, `setupPost` throws.
 */
export interface SlingshotAdminPluginConfig extends Omit<
  AdminPluginConfig,
  'accessProvider' | 'managedUserProvider' | 'permissions'
> {
  /** Custom access provider. Defaults to the slingshot-auth access provider. */
  accessProvider?: AdminPluginConfig['accessProvider'];
  /** Custom managed-user provider. Defaults to the slingshot-auth managed-user provider. */
  managedUserProvider?: AdminPluginConfig['managedUserProvider'];
  /**
   * Explicit permissions object. When omitted, resolved from `ctx.pluginState`
   * under `PERMISSIONS_STATE_KEY` (populated by community or another plugin).
   */
  permissions?: AdminPluginConfig['permissions'];
}

/**
 * Create the Slingshot admin plugin with automatic framework wiring.
 *
 * This is a thin adapter around `createAdminPlugin` (from `@lastshotlabs/slingshot-admin`)
 * that defers route registration to the `setupPost` lifecycle phase. This is intentional:
 * plugins register their `PERMISSIONS_STATE_KEY` in `setupRoutes`, and `setupPost` runs
 * after all `setupRoutes` phases have completed, ensuring the permissions state is fully
 * populated before admin routes are mounted.
 *
 * **Lifecycle note (Rule 17):** `setupRoutes` is intentionally a no-op here. Route
 * registration happens in `setupPost` after all other plugins' `setupRoutes` have run.
 * The `setup` convenience method delegates to `setupPost` for standalone usage.
 *
 * **Cross-plugin state:** Resolved `permissions` are published back to
 * `ctx.pluginState` under `PERMISSIONS_STATE_KEY` (if not already set) so other
 * plugins that run after admin can read the canonical permissions object.
 *
 * @param config - Admin plugin configuration. See {@link SlingshotAdminPluginConfig}.
 * @returns A `SlingshotPlugin` compatible with `createApp({ plugins: [...] })`.
 * @throws If `permissions` is not provided and `PERMISSIONS_STATE_KEY` is absent
 *   from `ctx.pluginState` when `setupPost` runs.
 *
 * @example
 * ```ts
 * const app = createApp({
 *   plugins: [
 *     createCommunityPlugin({ ... }),  // sets PERMISSIONS_STATE_KEY
 *     createSlingshotAdminPlugin({
 *       title: 'My Admin',
 *       basePath: '/admin',
 *     }),
 *   ],
 * });
 * ```
 */
export function createSlingshotAdminPlugin(config: SlingshotAdminPluginConfig): SlingshotPlugin {
  return {
    name: 'slingshot-admin',

    // setupRoutes intentionally does NOT read pluginState here — community and other
    // plugins set PERMISSIONS_STATE_KEY during their own setupRoutes, which may not
    // have run yet when admin's setupRoutes executes (plugin registration order is
    // not guaranteed). Actual route registration is deferred to setupPost (Rule 17).

    async setupPost({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      const { createAdminPlugin } = await import('@lastshotlabs/slingshot-admin');
      const pluginState = getPluginState(app);
      const runtime = getAuthRuntimeContext(pluginState);

      // All setupRoutes phases have now completed — safe to read cross-plugin state.
      let permissions = config.permissions;
      if (!permissions) {
        const state = getPermissionsStateOrNull(pluginState) as PermissionsState | null;
        if (!state) {
          throw new Error(
            '[slingshot-admin] permissions not provided and not found in pluginState. ' +
              'Either pass permissions explicitly or ensure another plugin (e.g. community) ' +
              'registers PERMISSIONS_STATE_KEY before admin runs.',
          );
        }
        permissions = state;
      }

      // Publish resolved permissions so other plugins can read them.
      if (!getPermissionsStateOrNull(pluginState)) {
        pluginState.set(PERMISSIONS_STATE_KEY, permissions);
      }

      // Register routes in setupPost — all plugins' setupRoutes have completed and
      // no requests can arrive until the server starts (after all setup phases).
      const plugin = createAdminPlugin({
        ...config,
        permissions,
        accessProvider: config.accessProvider ?? createSlingshotAuthAccessProvider(),
        managedUserProvider:
          config.managedUserProvider ??
          createSlingshotManagedUserProvider(
            runtime.adapter,
            runtime.config,
            runtime.repos.session,
          ),
      });
      await plugin.setupRoutes?.({ app, config: frameworkConfig, bus, events });
    },

    async setup(ctx: PluginSetupContext) {
      await this.setupPost?.(ctx);
    },
  };
}
