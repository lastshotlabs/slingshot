import type {
  GroupResolver,
  Logger,
  PluginSeedContext,
  PluginSetupContext,
  PluginStateMap,
  SlingshotPlugin,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  SUPER_ADMIN_ROLE,
  createConsoleLogger,
  getContext,
  getPermissionsStateOrNull,
  getPluginState,
  provideCapability,
  registerPluginCapabilities,
  resolveRepoAsync,
} from '@lastshotlabs/slingshot-core';
import {
  PermissionsAdapterCap,
  PermissionsEvaluatorCap,
  PermissionsRegistryCap,
} from './public';
import { permissionsAdapterFactories } from './factories';
import {
  type EvaluatorHealth,
  type EvaluatorWithHealth,
  createPermissionEvaluator,
} from './lib/evaluator';
import { createPermissionRegistry } from './lib/registry';

/**
 * Aggregated health snapshot for `slingshot-permissions`. Returned by the
 * `getHealth()` method on the plugin instance.
 *
 * `status` is derived from the underlying signals:
 *   - `'unhealthy'` when no permissions adapter has been resolved yet (the
 *     plugin hasn't completed `setupMiddleware`, or another plugin pre-seeded
 *     state without an adapter).
 *   - `'degraded'` when the evaluator has observed any query timeouts or
 *     group-expansion errors since startup, or when the backing adapter
 *     reports a disconnected state.
 *   - `'healthy'` otherwise.
 */
export interface PermissionsHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly details: {
    /** `true` when a `PermissionsAdapter` has been resolved into plugin state. */
    readonly adapterAvailable: boolean;
    /** Adapter implementation name (best-effort). `null` when unavailable. */
    readonly adapterName: string | null;
    /** Per-evaluator counters surfaced from the most recently created evaluator. */
    readonly evaluator: EvaluatorHealth | null;
    /**
     * Adapter-level health snapshot. Present when the backing adapter
     * exposes a `healthCheck()` method (currently the Postgres adapter).
     * `undefined` for adapters that do not support health checks (memory,
     * SQLite).
     */
    readonly adapter:
      | {
          readonly status: 'connected' | 'disconnected';
        }
      | undefined;
    /** Unix timestamp (ms) of the last adapter health check. `undefined` if never checked. */
    readonly adapterHealthLastChecked: number | undefined;
  };
}

/**
 * Configuration for the permissions plugin wrapper.
 *
 * Controls the backing adapter, optional group expansion, and evaluator limits
 * used when resolving role grants for user, group, and service-account subjects.
 */
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

  /**
   * Maximum number of groups to expand per permission check for a user.
   *
   * Passed to `createPermissionEvaluator` as `maxGroups`. Defaults to `50`.
   * Increase this for org models where users can belong to many groups.
   */
  maxGroups?: number;
  /**
   * Maximum time in milliseconds to wait for each permissions adapter query.
   * When omitted, evaluator queries are not timed out.
   */
  queryTimeoutMs?: number;

  /**
   * Set true to keep the previous fail-open group-expansion behavior.
   * Defaults to false so missing group grants cannot hide deny permissions.
   */
  failOpenOnGroupExpansionError?: boolean;

  /**
   * Injected structured logger for plugin-level operational messages.
   * When omitted, messages are silently discarded (noop logger).
   * The logger is also forwarded to the evaluator for permission check warnings.
   */
  logger?: Logger;
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
export function createPermissionsPlugin(
  config?: PermissionsPluginConfig,
): SlingshotPlugin & { getHealth(): PermissionsHealth } {
  // Captured from setupMiddleware so getHealth() can return a non-trivial
  // snapshot without re-resolving the adapter.
  const logger: Logger =
    config?.logger ?? createConsoleLogger({ base: { plugin: 'slingshot-permissions' } });
  let evaluatorRef: EvaluatorWithHealth | undefined;
  let adapterNameRef: string | null = null;
  let adapterAvailable = false;
  // Adapter-level health detail — populated when the adapter exposes a
  // healthCheck() method (e.g. the Postgres adapter). Refreshed lazily
  // on getHealth() when the cached value is older than 30s.
  let adapterHealth: PermissionsHealth['details']['adapter'] = undefined;
  let adapterHealthRef: {
    healthCheck: () => Promise<{ status: 'connected' | 'disconnected' }>;
  } | null = null;
  let lastAdapterHealthCheck = 0;
  const ADAPTER_HEALTH_TTL_MS = 30_000;

  return {
    name: 'slingshot-permissions',

    getHealth(): PermissionsHealth {
      const evaluatorHealth = evaluatorRef?.getHealth() ?? null;

      // Refresh adapter health if the cached value is stale.
      if (adapterHealthRef && Date.now() - lastAdapterHealthCheck > ADAPTER_HEALTH_TTL_MS) {
        void adapterHealthRef
          .healthCheck()
          .then(aHealth => {
            adapterHealth = aHealth;
            lastAdapterHealthCheck = Date.now();
          })
          .catch(() => {
            adapterHealth = { status: 'disconnected' as const };
            lastAdapterHealthCheck = Date.now();
          });
      }

      let status: PermissionsHealth['status'] = 'healthy';
      if (!adapterAvailable) {
        status = 'unhealthy';
      } else if (
        evaluatorHealth &&
        (evaluatorHealth.queryTimeoutCount > 0 || evaluatorHealth.groupExpansionErrorCount > 0)
      ) {
        status = 'degraded';
      } else if (adapterHealth && adapterHealth.status !== 'connected') {
        status = 'degraded';
      }
      return {
        status,
        details: {
          adapterAvailable,
          adapterName: adapterNameRef,
          evaluator: evaluatorHealth,
          adapter: adapterHealth,
          adapterHealthLastChecked: lastAdapterHealthCheck || undefined,
        },
      };
    },

    async setupMiddleware({ app, config: frameworkConfig }: PluginSetupContext) {
      const pluginState = getPluginState(app);
      // Idempotent — if another plugin (or a test fixture) already published the
      // permissions contract capabilities, skip re-publishing.
      const existing = getPermissionsStateOrNull(pluginState);
      if (existing) {
        // Reflect the externally-seeded state so getHealth() doesn't lie.
        if (existing.adapter) {
          adapterAvailable = true;
          adapterNameRef =
            (existing.adapter as { name?: string }).name ??
            existing.adapter.constructor?.name ??
            null;
        }
        return;
      }

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
      const adapter = await resolveRepoAsync(permissionsAdapterFactories, storeType, infra);
      const groupResolver = config?.groupResolver?.(pluginState);
      const evaluator = createPermissionEvaluator({
        registry,
        adapter,
        groupResolver,
        maxGroups: config?.maxGroups,
        queryTimeoutMs: config?.queryTimeoutMs,
        logger,
        failOpenOnGroupExpansionError: config?.failOpenOnGroupExpansionError,
      });

      evaluatorRef = evaluator;
      adapterAvailable = true;
      adapterNameRef = (adapter as { name?: string }).name ?? adapter.constructor?.name ?? null;

      // Capture adapter-level health detail if the adapter exposes a health check.
      const adapterAny = adapter as unknown as Record<string, unknown>;
      if (typeof adapterAny.healthCheck === 'function') {
        adapterHealthRef = adapterAny as {
          healthCheck: () => Promise<{ status: 'connected' | 'disconnected' }>;
        };
        try {
          adapterHealth = await adapterHealthRef.healthCheck();
          lastAdapterHealthCheck = Date.now();
        } catch {
          adapterHealth = { status: 'disconnected' as const };
          lastAdapterHealthCheck = Date.now();
        }
      }

      // Contract-bound capability publish. Cross-package consumers do
      // `ctx.capabilities.require(PermissionsEvaluatorCap)` etc., or fetch the
      // bundled `{ evaluator, registry, adapter }` shape via `getPermissionsState(...)`
      // (which resolves through the same contract slot internally).
      await registerPluginCapabilities(getContext(app), 'slingshot-permissions', [
        provideCapability(PermissionsEvaluatorCap, () => evaluator),
        provideCapability(PermissionsRegistryCap, () => registry),
        provideCapability(PermissionsAdapterCap, () => adapter),
      ]);
    },

    setupPost({ app, bus }: PluginSetupContext) {
      const permsState = getPermissionsStateOrNull(getPluginState(app));
      if (!permsState?.adapter) return;
      bus.on('auth:user.deleted', async ({ userId }) => {
        try {
          await permsState.adapter.deleteAllGrantsForSubject({
            subjectId: userId,
            subjectType: 'user',
          });
        } catch (err) {
          logger.error(
            '[slingshot-permissions] Failed to delete grants for deleted user: ' +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      });
    },

    async seed({ app, seedState }: PluginSeedContext) {
      const permsState = getPermissionsStateOrNull(getPluginState(app));
      if (!permsState?.adapter) return;

      for (const [key, value] of seedState) {
        if (!key.startsWith('superAdmin:') || value !== true) continue;
        const email = key.slice('superAdmin:'.length);
        const userId = seedState.get(`user:${email}`) as string | undefined;
        if (!userId) {
          logger.warn(
            `[slingshot-permissions seed] superAdmin requested for '${email}' but no user ID found in seedState — grant skipped.`,
          );
          continue;
        }
        const existing = await permsState.adapter.getGrantsForSubject(userId, 'user', {
          tenantId: null,
          resourceType: null,
          resourceId: null,
        });
        const alreadyAdmin = existing.some(
          g => g.roles.includes(SUPER_ADMIN_ROLE) && g.effect === 'allow' && !g.revokedAt,
        );
        if (alreadyAdmin) {
          logger.info(`[slingshot-permissions seed] '${email}' already has super-admin — skipped.`);
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
        logger.info(`[slingshot-permissions seed] Granted super-admin to '${email}'.`);
      }
    },
  };
}
