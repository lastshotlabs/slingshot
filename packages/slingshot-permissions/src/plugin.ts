import type {
  GroupResolver,
  Logger,
  PermissionRegistry,
  PermissionsAdapter,
  PluginSeedContext,
  PluginSetupContext,
  PluginStateMap,
  SlingshotPackageDefinition,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  SUPER_ADMIN_ROLE,
  createConsoleLogger,
  definePackage,
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
  PermissionsHealthCap,
  PermissionsRegistryCap,
} from './public';
import type { PermissionsHealth } from './public';
import { permissionsAdapterFactories } from './factories';
import {
  type EvaluatorWithHealth,
  createPermissionEvaluator,
} from './lib/evaluator';
import { createPermissionRegistry } from './lib/registry';

export type { PermissionsHealth } from './public';

/**
 * Configuration for the permissions package.
 *
 * Controls the backing adapter, optional group expansion, and evaluator limits
 * used when resolving role grants for user, group, and service-account subjects.
 */
export interface PermissionsPluginConfig {
  /**
   * Override the store backend for the permissions adapter.
   * When omitted the package falls back to `frameworkConfig.resolvedStores.authStore`.
   */
  adapter?: 'sqlite' | 'postgres' | 'mongo' | 'memory';

  /**
   * Optional group resolver for expanding user → group membership during permission checks.
   * Receives the plugin state map so it can lazily read peer package runtime.
   *
   * When omitted, group expansion is disabled — grants to groups never apply to users.
   *
   * To integrate with `slingshot-auth`, pass `createAuthGroupResolver`:
   * @example
   * ```ts
   * import {
   *   createPermissionsPackage,
   *   createAuthGroupResolver,
   * } from '@lastshotlabs/slingshot-permissions';
   * import { getAuthRuntimePeerOrNull } from '@lastshotlabs/slingshot-core';
   *
   * createPermissionsPackage({
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
   * Injected structured logger for package-level operational messages.
   * When omitted, messages go through the default console logger.
   * The logger is also forwarded to the evaluator for permission check warnings.
   */
  logger?: Logger;
}

/**
 * Creates the slingshot-permissions package.
 *
 * Resolves the permissions adapter from the active store type during
 * `setupMiddleware` and stores a frozen `PermissionsState`
 * (`{ evaluator, registry, adapter }`) in `ctx.pluginState` under the
 * package capabilities slot. Packages that require permissions (e.g.
 * `slingshot-community`, `slingshot-content`) declare `'slingshot-permissions'`
 * as a dependency and read the shared state from `pluginState` (or resolve via
 * `ctx.capabilities.require(PermissionsEvaluatorCap)`) instead of
 * constructing their own instances.
 *
 * Group expansion is disabled by default. To resolve user → group membership
 * from `slingshot-auth`, pass a `groupResolver` factory via config.
 *
 * Registration order: declare this package before any consumer package so the
 * framework's topological sort places its `setupMiddleware` first.
 *
 * @returns A `SlingshotPackageDefinition` ready for `createApp({ packages })`.
 *
 * @example Standalone (no auth integration)
 * ```ts
 * import { createPermissionsPackage } from '@lastshotlabs/slingshot-permissions';
 *
 * const { app } = await createApp({
 *   packages: [createPermissionsPackage()],
 * });
 * ```
 *
 * @example With slingshot-auth group resolution
 * ```ts
 * import {
 *   createPermissionsPackage,
 *   createAuthGroupResolver,
 * } from '@lastshotlabs/slingshot-permissions';
 * import { getAuthRuntimePeerOrNull } from '@lastshotlabs/slingshot-core';
 *
 * const { app } = await createApp({
 *   plugins: [createAuthPlugin({ auth: { roles: ['user', 'admin'] } })],
 *   packages: [
 *     createPermissionsPackage({
 *       groupResolver: (pluginState) =>
 *         createAuthGroupResolver(() => getAuthRuntimePeerOrNull(pluginState)),
 *     }),
 *   ],
 * });
 * ```
 */
export function createPermissionsPackage(
  config?: PermissionsPluginConfig,
): SlingshotPackageDefinition {
  const logger: Logger =
    config?.logger ?? createConsoleLogger({ base: { plugin: 'slingshot-permissions' } });
  // Captured from setupMiddleware so the health capability can return a
  // non-trivial snapshot without re-resolving the adapter.
  let evaluatorRef: EvaluatorWithHealth | undefined;
  let adapterNameRef: string | null = null;
  let adapterAvailable = false;
  // Adapter-level health detail — populated when the adapter exposes a
  // healthCheck() method (e.g. the Postgres adapter). Refreshed lazily
  // on the health capability when the cached value is older than 30s.
  let adapterHealth: PermissionsHealth['details']['adapter'] = undefined;
  let adapterHealthRef: {
    healthCheck: () => Promise<{ status: 'connected' | 'disconnected' }>;
  } | null = null;
  let lastAdapterHealthCheck = 0;
  const ADAPTER_HEALTH_TTL_MS = 30_000;

  function buildHealth(): PermissionsHealth {
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
  }

  let registryRef: PermissionRegistry | undefined;
  let adapterRef: PermissionsAdapter | undefined;

  /**
   * Publish the four package capabilities (evaluator, registry, adapter, health) into
   * the package-capabilities slot. Called from both `setupMiddleware` (so consumer
   * packages can read them in their own `setupMiddleware`) and `setupPost` (the
   * framework re-runs its declarative `publishPackageRuntimeState` at the top of
   * `setupPost` based on `definePackage({ capabilities.provides })`, which would
   * otherwise wipe the slot for packages that publish capabilities imperatively).
   */
  async function publishCaps(app: object): Promise<void> {
    if (!evaluatorRef || !registryRef || !adapterRef) return;
    const evaluator = evaluatorRef;
    const registry = registryRef;
    const adapter = adapterRef;
    await registerPluginCapabilities(getContext(app), 'slingshot-permissions', [
      provideCapability(PermissionsEvaluatorCap, () => evaluator),
      provideCapability(PermissionsRegistryCap, () => registry),
      provideCapability(PermissionsAdapterCap, () => adapter),
      provideCapability(PermissionsHealthCap, () => buildHealth),
    ]);
  }

  return definePackage({
    name: 'slingshot-permissions',
    dependencies: [],
    entities: [],

    async setupMiddleware({ app, config: frameworkConfig }: PluginSetupContext) {
      const pluginState = getPluginState(app);
      // Idempotent — if another package (or a test fixture) already published the
      // permissions contract capabilities, skip re-publishing.
      const existing = getPermissionsStateOrNull(pluginState);
      if (existing) {
        // Reflect the externally-seeded state so the health capability doesn't lie.
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
      registryRef = registry;
      adapterRef = adapter;
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
      await publishCaps(app);
    },

    async setupPost({ app, bus }: PluginSetupContext) {
      // Re-publish capabilities so they survive the framework's declarative
      // `publishPackageRuntimeState` pass at the top of `setupPost` (which would
      // otherwise overwrite the slot to an empty object since this package
      // doesn't declare any entries in `definePackage({ capabilities.provides })`).
      await publishCaps(app);

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
  });
}
