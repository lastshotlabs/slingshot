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

/**
 * Registry for resolving named handler references in app manifests.
 *
 * Stores five categories of named registrations: function handlers, plugin
 * factories, event bus factories, secret provider factories, and lifecycle hooks.
 * Each `createManifestHandlerRegistry()` call produces a fresh, closure-scoped
 * registry with no shared state between instances.
 */
export interface ManifestHandlerRegistry {
  /** Register a named function handler. Throws on duplicate names. */
  registerHandler(name: string, factory: HandlerFactory): void;
  /** Resolve a named handler and invoke its factory, returning the result. */
  resolveHandler(name: string, params?: Record<string, unknown>): unknown;
  /** Check whether a handler with the given name is registered. */
  hasHandler(name: string): boolean;

  /** Register a named plugin factory. Throws on duplicate names. */
  registerPlugin(name: string, factory: PluginFactory): void;
  /** Resolve a named plugin factory and invoke it with optional config. */
  resolvePlugin(name: string, config?: Record<string, unknown>): SlingshotPlugin;
  /** Check whether a plugin factory with the given name is registered. */
  hasPlugin(name: string): boolean;

  /** Register a named event bus factory. Throws on duplicate names. */
  registerEventBus(name: string, factory: EventBusFactory): void;
  /** Resolve a named event bus factory and invoke it with optional config. */
  resolveEventBus(name: string, config?: Record<string, unknown>): SlingshotEventBus;
  /** Check whether an event bus factory with the given name is registered. */
  hasEventBus(name: string): boolean;

  /** Register a named secret provider factory. Throws on duplicate names. */
  registerSecretProvider(name: string, factory: SecretProviderFactory): void;
  /** Resolve a named secret provider factory and invoke it with config. */
  resolveSecretProvider(name: string, config: Record<string, unknown>): SecretRepository;

  /** Register a lifecycle hook by name. */
  registerHook(name: string, hook: HookFunction): void;
  /** Resolve a registered hook by name. Throws if not found. */
  resolveHook(name: string): HookFunction;
  /** Check whether a hook with the given name is registered. */
  hasHook(name: string): boolean;

  /** Register a named orchestration task definition. Throws on duplicate names. */
  registerTask(name: string, task: AnyResolvedTask): void;
  /** Resolve a registered task definition by name. Throws if not found. */
  resolveTask(name: string): AnyResolvedTask;
  /** Check whether a task with the given name is registered. */
  hasTask(name: string): boolean;

  /** Register a named orchestration workflow definition. Throws on duplicate names. */
  registerWorkflow(name: string, workflow: AnyResolvedWorkflow): void;
  /** Resolve a registered workflow definition by name. Throws if not found. */
  resolveWorkflow(name: string): AnyResolvedWorkflow;
  /** Check whether a workflow with the given name is registered. */
  hasWorkflow(name: string): boolean;
}

/**
 * Create a fresh {@link ManifestHandlerRegistry} with its own closure-scoped maps.
 *
 * @returns A new registry instance with no pre-registered entries.
 */
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
