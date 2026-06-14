/**
 * Test helpers for package authors that bypass `createApp()` / `compilePackages()`.
 *
 * Import via the `/testing` subpath: `@lastshotlabs/slingshot-entity/testing`.
 *
 * @packageDocumentation
 */
import type {
  EntityChannelConfig,
  PluginSetupContext,
  RepoFactories,
  ResolvedEntityConfig,
  SlingshotPackageDefinition,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import { RESOLVE_ENTITY_FACTORIES, resolveRepo } from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from './createEntityPlugin';
import type { EntityPlugin, EntityPluginEntry } from './createEntityPlugin';
import type { BareEntityAdapter } from './routing/buildBareEntityRoutes';
import type { EntityExtraRoute, EntityRouteExecutorOverrides } from './routing/entityRoutePlanning';

type EntityFactoryCreator = (
  config: ResolvedEntityConfig,
  operations?: Record<string, unknown>,
) => RepoFactories<BareEntityAdapter | Record<string, unknown>>;

/** Shape of an entity module's `implementation.wiring` discriminated by `mode`. */
interface EntityModuleWiringInternal {
  readonly mode: 'standard' | 'factories' | 'manual';
  readonly buildAdapter?: (storeType: StoreType, infra: StoreInfra) => BareEntityAdapter;
  readonly factories?: RepoFactories<BareEntityAdapter | Record<string, unknown>>;
  readonly entityKey?: string;
  readonly onAdapter?: (adapter: BareEntityAdapter) => void;
}

/** Shape of an entity module's `implementation` payload. */
interface EntityModuleImplementationInternal {
  readonly config: ResolvedEntityConfig;
  readonly operations?: Record<string, unknown>;
  readonly extraRoutes?: readonly EntityExtraRoute[];
  readonly overrides?: EntityRouteExecutorOverrides;
  readonly channels?: EntityChannelConfig;
  readonly routePath?: string;
  readonly parentPath?: string;
  readonly wiring: EntityModuleWiringInternal;
}

/**
 * Build an {@link EntityPluginEntry} from a package entity module by delegating
 * to the module's own `wiring`.
 *
 * Mirrors `compileEntityEntry` in the framework's `packageAuthoring.ts`:
 *
 * - `manual` mode → passes `buildAdapter` through.
 * - `factories` mode → passes `factories` + `entityKey` + `onAdapter` through so
 *   `createEntityPlugin`'s built-in composite resolution and `onAdapter` callback
 *   fire as they would under the real framework path.
 * - `standard` mode → throws. Standard wiring depends on the framework's
 *   `RESOLVE_ENTITY_FACTORIES` infra hook, which test harnesses must set up
 *   themselves and use `factories` wiring with `createEntityFactories(...)` to
 *   surface the adapter.
 */
function compileEntityEntryForTest(entityModule: {
  readonly entityName: string;
  readonly implementation: EntityModuleImplementationInternal;
}): EntityPluginEntry {
  const impl = entityModule.implementation;
  const base = {
    config: impl.config,
    operations: impl.operations as never,
    extraRoutes: impl.extraRoutes as never,
    overrides: impl.overrides as never,
    channels: impl.channels as never,
    ...(impl.routePath ? { routePath: impl.routePath } : {}),
    ...(impl.parentPath ? { parentPath: impl.parentPath } : {}),
  };

  if (impl.wiring.mode === 'manual') {
    if (!impl.wiring.buildAdapter) {
      throw new Error(
        `[slingshot-entity] runPackageLifecycle: entity '${entityModule.entityName}' has wiring.mode='manual' but no buildAdapter`,
      );
    }
    return { ...base, buildAdapter: impl.wiring.buildAdapter };
  }

  if (impl.wiring.mode === 'factories') {
    if (!impl.wiring.factories) {
      throw new Error(
        `[slingshot-entity] runPackageLifecycle: entity '${entityModule.entityName}' has wiring.mode='factories' but no factories`,
      );
    }
    return {
      ...base,
      factories: impl.wiring.factories,
      ...(impl.wiring.entityKey ? { entityKey: impl.wiring.entityKey } : {}),
      ...(impl.wiring.onAdapter ? { onAdapter: impl.wiring.onAdapter } : {}),
    };
  }

  // Standard wiring: mirror the framework's compileEntityEntry fallback —
  // resolve `createEntityFactories` from infra via `RESOLVE_ENTITY_FACTORIES`
  // (the same hook the framework registers in production). Test harnesses set
  // this up by writing `createEntityFactories` onto their memory infra stub
  // before calling this helper.
  return {
    ...base,
    buildAdapter(storeType, infra) {
      const creator = Reflect.get(infra as object, RESOLVE_ENTITY_FACTORIES) as
        | EntityFactoryCreator
        | undefined;
      if (!creator) {
        throw new Error(
          `[slingshot-entity] runPackageLifecycle: entity '${entityModule.entityName}' uses standard wiring but ` +
            `RESOLVE_ENTITY_FACTORIES is not available on storeInfra. Either populate it (e.g. ` +
            `Reflect.set(infra, RESOLVE_ENTITY_FACTORIES, createEntityFactories)) or convert the ` +
            `entity module to 'factories' / 'manual' wiring.`,
        );
      }
      const factories = creator(impl.config, impl.operations);
      return resolveRepo(factories, storeType, infra) as unknown as BareEntityAdapter;
    },
  };
}

/** Result returned by {@link runPackageLifecycle}. */
export interface RunPackageLifecycleResult {
  /**
   * The {@link EntityPlugin} constructed to mount the package's entity modules.
   * Callers can drive `teardown()` on this alongside `pkg.teardown()`.
   */
  readonly entityPlugin: EntityPlugin;
}

/**
 * Drive a {@link SlingshotPackageDefinition}'s lifecycle hooks the way the
 * framework's `createApp()` / `compilePackages()` does, for tests and tooling
 * that need the package up without booting the full framework.
 *
 * The helper:
 * 1. Walks `pkg.entities` and builds an `EntityPluginEntry[]` whose adapter
 *    construction delegates to each module's own `wiring` (`manual` →
 *    `buildAdapter`, `factories` → `factories` + `entityKey` + `onAdapter`).
 *    Entity-module `path` / `parentPath` overrides flow through as
 *    `routePath` / `parentPath` on the entry.
 * 2. Mounts the entity plugin via `createEntityPlugin({ name, mountPath,
 *    entities, middleware })`.
 * 3. Runs the six lifecycle phases in framework-equivalent order:
 *
 *    1. `pkg.setupMiddleware`
 *    2. `entityPlugin.setupMiddleware`
 *    3. `entityPlugin.setupRoutes` (this fires per-entity `buildAdapter` /
 *       `factories` resolution and any `onAdapter` callbacks the package's
 *       entity modules registered)
 *    4. `pkg.setupRoutes`
 *    5. `entityPlugin.setupPost`
 *    6. `pkg.setupPost`
 *
 * Test harnesses still own all framework-adjacent wiring (Hono app, bus,
 * events, `attachContext`, capability provider stubs, etc.) — this helper is
 * scoped to the entity-mount + lifecycle drive that used to be duplicated
 * across half a dozen package `testing.ts` files.
 *
 * @param pkg - The package whose lifecycle hooks should be driven.
 * @param ctx - A {@link PluginSetupContext} prepared by the test harness.
 * @returns The constructed entity plugin so callers can `await
 *   entityPlugin.teardown()` alongside `pkg.teardown()` during cleanup.
 */
export async function runPackageLifecycle(
  pkg: SlingshotPackageDefinition,
  ctx: PluginSetupContext,
): Promise<RunPackageLifecycleResult> {
  const entityEntries: EntityPluginEntry[] = pkg.entities.map(entityModule =>
    compileEntityEntryForTest(
      entityModule as unknown as {
        readonly entityName: string;
        readonly implementation: EntityModuleImplementationInternal;
      },
    ),
  );

  const entityPlugin = createEntityPlugin({
    name: pkg.name,
    ...(pkg.mountPath ? { mountPath: pkg.mountPath } : {}),
    entities: entityEntries,
    ...(pkg.middleware ? { middleware: { ...pkg.middleware } } : {}),
  });

  await pkg.setupMiddleware?.(ctx);
  await entityPlugin.setupMiddleware?.(ctx);
  await entityPlugin.setupRoutes?.(ctx);
  await pkg.setupRoutes?.(ctx);
  await entityPlugin.setupPost?.(ctx);
  await pkg.setupPost?.(ctx);

  return { entityPlugin };
}
