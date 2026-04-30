/**
 * Search document transform registry.
 *
 * Named transform handlers are registered at startup and resolved by string
 * reference from entity search config. This keeps config JSON-serializable
 * (same pattern as custom operations — a string reference, not an inline function).
 *
 * Example:
 *
 * ```ts
 * const registry = createSearchTransformRegistry();
 *
 * registry.register('flattenThread', (doc) => ({
 *   id: doc.id,
 *   title: doc.title,
 *   body: doc.body ?? '',
 *   status: doc.status,
 * }));
 *
 * // Entity config references by name:
 * const Thread = defineEntity('Thread', {
 *   fields: { ... },
 *   search: { fields: { ... }, transform: 'flattenThread' },
 * });
 * ```
 */
import { SearchTransformError } from './errors/searchErrors';

/** Transform function signature: takes a raw document, returns the document to index. */
export type SearchTransformFn = (doc: Record<string, unknown>) => Record<string, unknown>;

export interface SearchTransformRegistry {
  /** Register a named transform handler. Throws if the name is already registered. */
  register(name: string, fn: SearchTransformFn): void;

  /**
   * Resolve a transform by name. Returns the identity function when name is undefined.
   * Throws when a named transform is not found.
   */
  resolve(name?: string): SearchTransformFn;

  /** Check whether a transform with the given name is registered. */
  has(name: string): boolean;

  /** Get all registered transform names. */
  names(): ReadonlyArray<string>;
}

/**
 * Create a new search transform registry with closure-owned state.
 *
 * Each `createSearchPlugin()` call produces its own registry instance —
 * no module-level singletons.
 */
export function createSearchTransformRegistry(): SearchTransformRegistry {
  const handlers = new Map<string, SearchTransformFn>();
  const identity: SearchTransformFn = doc => doc;

  return {
    register(name, fn) {
      if (handlers.has(name)) {
        throw new SearchTransformError(`Transform '${name}' is already registered`);
      }
      handlers.set(name, fn);
    },

    resolve(name) {
      if (!name) return identity;
      const fn = handlers.get(name);
      if (!fn) {
        throw new SearchTransformError(
          `Unknown transform handler: '${name}'. Registered: [${[...handlers.keys()].join(', ')}]`,
        );
      }
      return fn;
    },

    has(name) {
      return handlers.has(name);
    },

    names() {
      return [...handlers.keys()];
    },
  };
}
