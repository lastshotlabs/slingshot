/**
 * Manifest Handler Registry — resolves named handler references in app manifests.
 *
 * Five buckets: named function handlers, plugin factories, event bus factories,
 * secret provider factories, and lifecycle hooks. Mirrors the EntityHandlerRegistry pattern.
 *
 * Each call to createManifestHandlerRegistry() returns a fresh registry with its
 * own closure-owned maps — no shared state between instances.
 */
import type {
  SecretRepository,
  SlingshotEventBus,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';

/** A named function handler resolved from an AppManifestHandlerRef. */
export type HandlerFactory = (params?: Record<string, unknown>) => unknown;

/** A plugin factory resolved by plugin name. */
export type PluginFactory = (config?: Record<string, unknown>) => SlingshotPlugin;

/** An event bus factory resolved by bus type name. */
export type EventBusFactory = (config?: Record<string, unknown>) => SlingshotEventBus;

/** A secret provider factory resolved by provider name. */
export type SecretProviderFactory = (config: Record<string, unknown>) => SecretRepository;

/**
 * A lifecycle hook resolved by name.
 *
 * The parameter type is `unknown` because the concrete context depends on
 * where the hook is invoked. Entity `afterAdapters` hooks receive
 * `EntityPluginAfterAdaptersContext`; the bridging code in
 * `createServerFromManifest` casts at the opaque registry boundary.
 */
export type HookFunction = (ctx: unknown) => void | Promise<void>;

export interface ManifestHandlerRegistry {
  registerHandler(name: string, factory: HandlerFactory): void;
  resolveHandler(name: string, params?: Record<string, unknown>): unknown;
  hasHandler(name: string): boolean;

  registerPlugin(name: string, factory: PluginFactory): void;
  resolvePlugin(name: string, config?: Record<string, unknown>): SlingshotPlugin;
  hasPlugin(name: string): boolean;

  registerEventBus(name: string, factory: EventBusFactory): void;
  resolveEventBus(name: string, config?: Record<string, unknown>): SlingshotEventBus;
  hasEventBus(name: string): boolean;

  registerSecretProvider(name: string, factory: SecretProviderFactory): void;
  resolveSecretProvider(name: string, config: Record<string, unknown>): SecretRepository;

  /** Register a lifecycle hook by name. */
  registerHook(name: string, hook: HookFunction): void;
  /** Resolve a registered hook by name. Throws if not found. */
  resolveHook(name: string): HookFunction;
  /** Check whether a hook with the given name is registered. */
  hasHook(name: string): boolean;
}

export function createManifestHandlerRegistry(): ManifestHandlerRegistry {
  const handlers = new Map<string, HandlerFactory>();
  const plugins = new Map<string, PluginFactory>();
  const eventBuses = new Map<string, EventBusFactory>();
  const secretProviders = new Map<string, SecretProviderFactory>();
  const hooks = new Map<string, HookFunction>();

  function require<T>(map: Map<string, T>, name: string, kind: string): T {
    const entry = map.get(name);
    if (!entry)
      throw new Error(
        `[ManifestHandlerRegistry] Unknown ${kind} "${name}". ` +
          `Registered: [${[...map.keys()].join(', ')}]`,
      );
    return entry;
  }

  return {
    registerHandler(name, factory) {
      handlers.set(name, factory);
    },
    resolveHandler(name, params) {
      return require(handlers, name, 'handler')(params);
    },
    hasHandler(name) {
      return handlers.has(name);
    },

    registerPlugin(name, factory) {
      plugins.set(name, factory);
    },
    resolvePlugin(name, config) {
      return require(plugins, name, 'plugin')(config);
    },
    hasPlugin(name) {
      return plugins.has(name);
    },

    registerEventBus(name, factory) {
      eventBuses.set(name, factory);
    },
    resolveEventBus(name, config) {
      return require(eventBuses, name, 'event bus')(config);
    },
    hasEventBus(name) {
      return eventBuses.has(name);
    },

    registerSecretProvider(name, factory) {
      secretProviders.set(name, factory);
    },
    resolveSecretProvider(name, config) {
      return require(secretProviders, name, 'secret provider')(config);
    },

    registerHook(name, hook) {
      hooks.set(name, hook);
    },
    resolveHook(name) {
      return require(hooks, name, 'hook');
    },
    hasHook(name) {
      return hooks.has(name);
    },
  };
}
