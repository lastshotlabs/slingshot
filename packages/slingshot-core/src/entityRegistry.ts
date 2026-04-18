/**
 * General-purpose entity registry.
 *
 * Plugins that need to discover entities at runtime (search indexing, schema
 * generation, admin UIs, migration tooling, documentation) use this registry.
 *
 * Created by the framework during bootstrap, exposed to plugin lifecycle hooks
 * on `SlingshotFrameworkConfig`, and consumed by framework-owned services such as
 * search indexing.
 */
import type { ResolvedEntityConfig } from './entityConfig';

export interface EntityRegistry {
  /** Register an entity config. Called by framework-owned config-driven persistence wiring. */
  register(config: ResolvedEntityConfig): void;

  /** Get all registered entities (returns a copy — cannot mutate the registry). */
  getAll(): ReadonlyArray<ResolvedEntityConfig>;

  /** Query entities by predicate (returns a copy). */
  filter(predicate: (config: ResolvedEntityConfig) => boolean): ReadonlyArray<ResolvedEntityConfig>;
}

/**
 * Create a new entity registry with closure-owned state.
 *
 * Each `createApp()` call produces its own registry instance — no module-level singletons,
 * no shared mutable state between app instances.
 *
 * @returns A fresh `EntityRegistry` with an empty entity list.
 * @throws `Error` (from `register`) if an entity with the same `name` and `namespace` is
 *   registered more than once on the same instance.
 *
 * @remarks
 * **Frozen configs at registration time:** each `ResolvedEntityConfig` is frozen with
 * `Object.freeze()` when passed to `register`. This prevents plugins from mutating entity
 * configs after they have been registered and ensures that `getAll()` / `filter()` callers
 * always see the original, immutable config. Deep sub-objects are not frozen by this call —
 * only the top-level config object is frozen.
 *
 * **Duplicate detection:** uniqueness is enforced on the `(name, namespace)` tuple.
 * Two entities with the same name in different namespaces are considered distinct. Attempting
 * to register a duplicate throws immediately at bootstrap time so the misconfiguration is
 * visible as a startup error rather than a silent override.
 *
 * @example
 * ```ts
 * import { createEntityRegistry } from '@lastshotlabs/slingshot-core';
 *
 * const registry = createEntityRegistry();
 * registry.register({ name: 'Post', namespace: 'community', storageName: 'posts', fields: [] });
 * registry.getAll(); // → [{ name: 'Post', namespace: 'community', ... }]
 *
 * // Duplicate registration throws:
 * registry.register({ name: 'Post', namespace: 'community', storageName: 'posts', fields: [] });
 * // Error: [EntityRegistry] Entity 'Post' (namespace: community) is already registered
 * ```
 */
export function createEntityRegistry(): EntityRegistry {
  const entities: ResolvedEntityConfig[] = [];

  return {
    register(config) {
      const existing = entities.find(
        e => e.name === config.name && e.namespace === config.namespace,
      );
      if (existing) {
        throw new Error(
          `[EntityRegistry] Entity '${config.name}' (namespace: ${config.namespace ?? 'default'}) is already registered`,
        );
      }
      entities.push(Object.freeze(config));
    },

    getAll() {
      return [...entities];
    },

    filter(predicate) {
      return entities.filter(predicate);
    },
  };
}
