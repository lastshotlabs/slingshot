/**
 * `HookServices` — typed accessors for out-of-request callbacks.
 *
 * Auth lifecycle hooks, orchestration workflow hooks, and queue dead-letter callbacks
 * fire outside any Hono request context — there is no `c` to read state from. Without
 * a canonical contract these callbacks ended up starved differently in each plugin
 * (some got `pluginState`, others got only request metadata, others nothing at all).
 *
 * `HookServices` is the shared shape every plugin's out-of-request callbacks intersect
 * into their payload. Hook authors get the same typed accessors that
 * `PackageDomainRouteContext` exposes to package-authored route handlers, so the
 * ergonomics line up across request and non-request callsites:
 *
 * ```ts
 * postLogin: async ({ userId, services }) => {
 *   const adapter = services.entities.get(GuestIdentity);   // typed via entity module
 *   const mailer = services.capabilities.require(MailerCapability);
 *   await services.bus.emit('user.signed-in', { userId });
 * }
 * ```
 *
 * Plugins build a `HookServices` instance by calling `buildHookServices()` at the call
 * site of each hook, threading their own `pluginState`/`bus`/`logger` and the app's
 * `Hono` reference. The framework supplies the shared
 * `SlingshotContext.capabilityProviders` map so capability lookups work identically to
 * those inside request handlers.
 *
 * **Worker-process boundary.** Some adapters (notably the Temporal orchestration worker)
 * run hook code in a separate process where the framework's `app` is not reachable.
 * Those callsites pass `services: undefined` rather than fabricate broken accessors.
 * Hook authors who need framework state from worker-mode code should restructure their
 * work to run at the workflow level (in-process) and thread data into the task input.
 */
import { getContextOrNull } from './context/index';
import type { SlingshotEventBus } from './eventBus';
import type { Logger } from './observability/logger';
import {
  PACKAGE_CAPABILITIES_PREFIX,
  type PackageCapabilityHandle,
  type PackageCapabilityReader,
  type PackageEntityReader,
  type PackageEntityRef,
  type SlingshotPackageEntityModuleLike,
  applyPublicEntityExposure,
} from './packageAuthoring';
import { requireEntityAdapter } from './pluginState';
import type { PluginStateMap } from './pluginStateTypes';

/**
 * Out-of-request hook services. Mirrors the accessor surface
 * `PackageDomainRouteContext` exposes to request-scoped route handlers, plus the raw
 * `pluginState` map as an escape hatch for callers that need slots no typed accessor
 * yet covers.
 *
 * Always construct via `buildHookServices()` at the hook call site — never fabricate
 * one by hand. Hook payloads in plugin lifecycle callbacks should declare
 * `services: HookServices` (or `services?: HookServices` for callbacks that can fire
 * from worker isolates that cannot reach the app).
 */
export interface HookServices {
  /**
   * Resolve typed entity adapters. Accepts a `defineEntity` module, a typed
   * `entityRef`, or the `{ plugin, entity }` escape-hatch shape. The adapter type
   * flows through from the entity module's phantom generic, so consumers get the
   * concrete adapter shape without casting.
   */
  readonly entities: PackageEntityReader;

  /**
   * Resolve typed cross-package capabilities. Use `require` when the providing
   * package is a declared dependency; `maybe` when the capability is optional.
   */
  readonly capabilities: PackageCapabilityReader;

  /**
   * Raw plugin-state map for the app instance. Use this only when reading a slot
   * that doesn't have a typed accessor yet — anything routed through `entities` or
   * `capabilities` should go through those instead.
   */
  readonly pluginState: PluginStateMap;

  /** Instance-scoped event bus for hooks that need to publish events. */
  readonly bus: SlingshotEventBus;

  /**
   * Structured logger scoped to the firing plugin. Hook authors should prefer this
   * over `console.*` so log lines carry consistent component metadata.
   */
  readonly logger: Logger;
}

/**
 * Build a `HookServices` instance for an out-of-request callback.
 *
 * Call this at the hook call site (typically once per hook invocation, inside the
 * plugin's bootstrap or runtime layer where the necessary inputs are already in
 * scope). The returned object is safe to spread into the hook's payload object.
 *
 * @example
 * ```ts
 * // inside slingshot-auth services/auth.ts
 * const services = buildHookServices({
 *   app: runtime.app,
 *   pluginState: runtime.pluginState,
 *   bus: runtime.eventBus,
 *   logger: runtime.logger,
 *   pluginName: 'slingshot-auth',
 * });
 * await hooks.postLogin?.({ userId, sessionId, ...hookContext, services });
 * ```
 */
export function buildHookServices(args: {
  /**
   * The Hono application instance. Typed as `object` to avoid pinning a Hono
   * version in `slingshot-core`. Used to resolve `getContext(app).capabilityProviders`
   * for capability lookups and `requireEntityAdapter(app, ...)` for entity lookups.
   */
  app: object;
  /** Live plugin-state map for the app instance. */
  pluginState: PluginStateMap;
  /** Instance-scoped event bus to expose on `services.bus`. */
  bus: SlingshotEventBus;
  /** Plugin-scoped logger to expose on `services.logger`. */
  logger: Logger;
  /**
   * Default plugin name used as the `plugin:` qualifier when a hook author calls
   * `services.entities.get(entityModule)` without specifying a plugin. Should be
   * the firing plugin's own name (e.g. `'slingshot-auth'`) so hooks can read their
   * own entities by module reference without redundant `{ plugin: '...' }` qualifiers.
   */
  pluginName: string;
}): HookServices {
  const { app, pluginState, bus, logger, pluginName } = args;

  const entities: PackageEntityReader = {
    get<TValue = unknown>(
      target:
        | SlingshotPackageEntityModuleLike<TValue>
        | PackageEntityRef<TValue>
        | { entity: string; plugin?: string },
    ): TValue {
      // Module form: `entity({ config: Foo })` returns a SlingshotPackageEntityModuleLike.
      if (
        typeof target === 'object' &&
        target !== null &&
        (target as SlingshotPackageEntityModuleLike).kind === 'entity'
      ) {
        const module = target as SlingshotPackageEntityModuleLike;
        return requireEntityAdapter(app, {
          plugin: pluginName,
          entity: module.entityName,
        }) as TValue;
      }
      // entityRef form: `entityRef(...)` returns a PackageEntityRef with `kind: 'entity-ref'`.
      if (
        typeof target === 'object' &&
        target !== null &&
        (target as PackageEntityRef).kind === 'entity-ref'
      ) {
        const ref = target as PackageEntityRef;
        const adapter = requireEntityAdapter(app, {
          plugin: ref.plugin ?? ref.contract ?? pluginName,
          entity: ref.entity,
        });
        return applyPublicEntityExposure(adapter, ref.exposure, {
          entity: ref.entity,
          contract: ref.contract,
          source: ref.source,
        }) as TValue;
      }
      // Escape hatch — `{ plugin?, entity }` lookup by name.
      const lookup = target as { plugin?: string; entity: string };
      return requireEntityAdapter(app, {
        plugin: lookup.plugin ?? pluginName,
        entity: lookup.entity,
      }) as TValue;
    },
  };

  const capabilityProviders =
    getContextOrNull(app)?.capabilityProviders ?? new Map<string, string>();

  const capabilities: PackageCapabilityReader = {
    maybe<TValue>(capability: PackageCapabilityHandle<TValue>): TValue | undefined {
      const providerName = capabilityProviders.get(capability.name);
      if (!providerName) return undefined;
      const slot = pluginState.get(`${PACKAGE_CAPABILITIES_PREFIX}${providerName}`) as
        | Record<string, unknown>
        | undefined;
      return slot?.[capability.name] as TValue | undefined;
    },
    require<TValue>(capability: PackageCapabilityHandle<TValue>): TValue {
      const value = this.maybe(capability);
      if (value === undefined) {
        throw new Error(
          `[slingshot] hook attempted to require capability '${capability.name}' but no package provides it (or its provider has not initialized yet).`,
        );
      }
      return value;
    },
  };

  return {
    entities,
    capabilities,
    pluginState,
    bus,
    logger,
  };
}
