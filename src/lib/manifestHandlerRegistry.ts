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
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
} from '@lastshotlabs/slingshot-orchestration';

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

  registerTask(name: string, task: AnyResolvedTask): void;
  resolveTask(name: string): AnyResolvedTask;
  hasTask(name: string): boolean;

  registerWorkflow(name: string, workflow: AnyResolvedWorkflow): void;
  resolveWorkflow(name: string): AnyResolvedWorkflow;
  hasWorkflow(name: string): boolean;
}

export function createManifestHandlerRegistry(): ManifestHandlerRegistry {
  const handlers = new Map<string, HandlerFactory>();
  const plugins = new Map<string, PluginFactory>();
  const eventBuses = new Map<string, EventBusFactory>();
  const secretProviders = new Map<string, SecretProviderFactory>();
  const hooks = new Map<string, HookFunction>();
  const tasks = new Map<string, AnyResolvedTask>();
  const workflows = new Map<string, AnyResolvedWorkflow>();

  function require<T>(map: Map<string, T>, name: string, kind: string): T {
    const entry = map.get(name);
    if (!entry)
      throw new Error(
        `[ManifestHandlerRegistry] Unknown ${kind} "${name}". ` +
          `Registered: [${[...map.keys()].join(', ')}]`,
      );
    return entry;
  }

  function registerUnique<T>(map: Map<string, T>, name: string, value: T, kind: string): void {
    if (map.has(name)) {
      throw new Error(
        `[ManifestHandlerRegistry] Duplicate ${kind} "${name}" registration. ` +
          'Registry names must be unique.',
      );
    }
    map.set(name, value);
  }

  return {
    registerHandler(name, factory) {
      registerUnique(handlers, name, factory, 'handler');
    },
    resolveHandler(name, params) {
      return require(handlers, name, 'handler')(params);
    },
    hasHandler(name) {
      return handlers.has(name);
    },

    registerPlugin(name, factory) {
      registerUnique(plugins, name, factory, 'plugin');
    },
    resolvePlugin(name, config) {
      return require(plugins, name, 'plugin')(config);
    },
    hasPlugin(name) {
      return plugins.has(name);
    },

    registerEventBus(name, factory) {
      registerUnique(eventBuses, name, factory, 'event bus');
    },
    resolveEventBus(name, config) {
      return require(eventBuses, name, 'event bus')(config);
    },
    hasEventBus(name) {
      return eventBuses.has(name);
    },

    registerSecretProvider(name, factory) {
      registerUnique(secretProviders, name, factory, 'secret provider');
    },
    resolveSecretProvider(name, config) {
      return require(secretProviders, name, 'secret provider')(config);
    },

    registerHook(name, hook) {
      registerUnique(hooks, name, hook, 'hook');
    },
    resolveHook(name) {
      return require(hooks, name, 'hook');
    },
    hasHook(name) {
      return hooks.has(name);
    },

    registerTask(name, task) {
      registerUnique(tasks, name, task, 'task');
    },
    resolveTask(name) {
      return require(tasks, name, 'task');
    },
    hasTask(name) {
      return tasks.has(name);
    },

    registerWorkflow(name, workflow) {
      registerUnique(workflows, name, workflow, 'workflow');
    },
    resolveWorkflow(name) {
      return require(workflows, name, 'workflow');
    },
    hasWorkflow(name) {
      return workflows.has(name);
    },
  };
}
