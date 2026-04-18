import type { Hono } from 'hono';
import type { AppEnv, SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import type { BareEntityAdapter } from '../routing';

/**
 * Context passed to a manifest `hooks.afterAdapters` handler.
 *
 * Hooks run after all manifest entity adapters have been resolved and
 * transformed, but before routes are built.
 */
export interface EntityPluginAfterAdaptersContext {
  /** The live Hono app instance currently being wired. */
  readonly app: Hono<AppEnv>;
  /** App-scoped event bus. */
  readonly bus: SlingshotEventBus;
  /** The plugin currently resolving manifest adapters. */
  readonly pluginName: string;
  /** Final transformed adapters keyed by entity name. */
  readonly adapters: Readonly<Record<string, BareEntityAdapter>>;
  /** Permissions wiring resolved for the plugin, if any. */
  readonly permissions: unknown;
  /** Static params declared on the manifest hook ref, if any. */
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * Lifecycle hook run after all manifest adapters are ready.
 */
export type EntityPluginAfterAdaptersHook = (
  ctx: EntityPluginAfterAdaptersContext,
) => void | Promise<void>;

/**
 * Registry of named manifest lifecycle hooks.
 */
export interface EntityPluginHookRegistry {
  /**
   * Register a named after-adapters hook.
   *
   * @param name - Manifest hook handler name.
   * @param hook - Runtime hook implementation.
   */
  register(name: string, hook: EntityPluginAfterAdaptersHook): void;

  /**
   * Resolve a registered hook by name.
   *
   * @throws {Error} When the name is unknown in this registry and its parents.
   */
  resolve(name: string): EntityPluginAfterAdaptersHook;

  /** Return true when the hook exists locally or in a parent registry. */
  has(name: string): boolean;

  /** List all registered hook names, including inherited entries. */
  list(): string[];

  /**
   * Create a child registry inheriting from this one.
   *
   * Child registries can add package-local hooks without mutating the parent runtime.
   */
  extend(): EntityPluginHookRegistry;
}

/**
 * Create a new manifest hook registry.
 *
 * @param parent - Optional parent registry for inherited lookups.
 * @returns A new `EntityPluginHookRegistry`.
 */
export function createEntityPluginHookRegistry(
  parent?: EntityPluginHookRegistry,
): EntityPluginHookRegistry {
  const hooks = new Map<string, EntityPluginAfterAdaptersHook>();

  const registry: EntityPluginHookRegistry = {
    register(name, hook) {
      hooks.set(name, hook);
    },

    resolve(name) {
      const hook = hooks.get(name);
      if (hook) return hook;
      if (parent?.has(name)) return parent.resolve(name);
      throw new Error(
        `[entity-hook-registry] Unknown hook "${name}". Available: [${registry.list().join(', ')}]`,
      );
    },

    has(name) {
      return hooks.has(name) || (parent?.has(name) ?? false);
    },

    list() {
      return [...new Set([...hooks.keys(), ...(parent?.list() ?? [])])];
    },

    extend() {
      return createEntityPluginHookRegistry(registry);
    },
  };

  return registry;
}
