import type { Hono } from 'hono';
import type { AppEnv, SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import type { BareEntityAdapter } from '../routing';

/**
 * Context passed to a manifest adapter transform at runtime.
 *
 * Transforms run during `createEntityPlugin().setupRoutes()` after an adapter
 * has been resolved for the active backend and before routes are built.
 */
export interface EntityAdapterTransformContext {
  /** The live Hono app instance currently being wired. */
  readonly app: Hono<AppEnv>;
  /** App-scoped event bus. */
  readonly bus: SlingshotEventBus;
  /** The plugin currently resolving the adapter. */
  readonly pluginName: string;
  /** The entity name whose adapter is being transformed. */
  readonly entityName: string;
  /** All adapters resolved so far, including the current entity's latest adapter. */
  readonly adapters: Readonly<Record<string, BareEntityAdapter>>;
  /** Static params declared on the manifest hook ref, if any. */
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * A runtime adapter transform referenced from `manifest.entities[*].adapterTransforms`.
 *
 * Implementations may wrap or replace the adapter, but must return a valid
 * adapter object for the entity.
 */
export type EntityAdapterTransform = (
  adapter: BareEntityAdapter,
  ctx: EntityAdapterTransformContext,
) => BareEntityAdapter | Promise<BareEntityAdapter>;

/**
 * Registry of named adapter transforms for manifest-driven plugins.
 *
 * Transforms are registered by name and resolved by
 * `createEntityPlugin({ manifest, manifestRuntime })` when an entity declares
 * `adapterTransforms`.
 */
export interface EntityAdapterTransformRegistry {
  /**
   * Register a named transform.
   *
   * @param name - Manifest handler name.
   * @param transform - Runtime transform implementation.
   */
  register(name: string, transform: EntityAdapterTransform): void;

  /**
   * Resolve a registered transform by name.
   *
   * @throws {Error} When the name is unknown in this registry and its parents.
   */
  resolve(name: string): EntityAdapterTransform;

  /** Return true when the transform exists locally or in a parent registry. */
  has(name: string): boolean;

  /** List all registered transform names, including inherited entries. */
  list(): string[];

  /**
   * Create a child registry inheriting from this one.
   *
   * Child registries can add package-local transforms without mutating the
   * parent runtime.
   */
  extend(): EntityAdapterTransformRegistry;
}

/**
 * Create a new adapter transform registry.
 *
 * @param parent - Optional parent registry for inherited lookups.
 * @returns A new `EntityAdapterTransformRegistry`.
 */
export function createEntityAdapterTransformRegistry(
  parent?: EntityAdapterTransformRegistry,
): EntityAdapterTransformRegistry {
  const transforms = new Map<string, EntityAdapterTransform>();

  const registry: EntityAdapterTransformRegistry = {
    register(name, transform) {
      transforms.set(name, transform);
    },

    resolve(name) {
      const transform = transforms.get(name);
      if (transform) return transform;
      if (parent?.has(name)) return parent.resolve(name);
      throw new Error(
        `[entity-transform-registry] Unknown transform "${name}". Available: [${registry
          .list()
          .join(', ')}]`,
      );
    },

    has(name) {
      return transforms.has(name) || (parent?.has(name) ?? false);
    },

    list() {
      return [...new Set([...transforms.keys(), ...(parent?.list() ?? [])])];
    },

    extend() {
      return createEntityAdapterTransformRegistry(registry);
    },
  };

  return registry;
}
