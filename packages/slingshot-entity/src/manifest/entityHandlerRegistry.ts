/**
 * Entity Handler Registry — resolves named handler references for custom operations.
 *
 * Handlers can be registered as:
 * 1. A single function (used for all backends, receives backend driver)
 * 2. A per-backend map { memory: fn, sqlite: fn, ... } where each fn receives its backend driver
 *
 * The manifest resolver uses resolveForCustomOp() to get a CustomOpConfig-compatible
 * object with backend-specific factories that receive backend drivers.
 */

/**
 * A single-function handler factory for all backends.
 *
 * Called with the static `params` from the manifest. Returns a function that
 * receives the backend driver (e.g. SQLite `db`, Mongo model) at adapter
 * construction time and returns the operation implementation.
 *
 * @example
 * ```ts
 * const factory: HandlerFactory = (params) => (driver) => {
 *   return async (input) => { ... };
 * };
 * ```
 */
export type HandlerFactory = (
  params?: Record<string, unknown>,
) => (backendDriver: unknown) => unknown;

/**
 * Per-backend handler map for use when different backends need different
 * implementations.
 *
 * Each function receives its backend-specific driver. Backends that are not
 * mapped are simply not supported by this handler.
 *
 * @example
 * ```ts
 * const handlers: BackendHandlers = {
 *   sqlite:   (db)    => (input) => db.prepare('SELECT ...').get(input.id),
 *   postgres: (pool)  => async (input) => (await pool.query('SELECT ...', [input.id])).rows[0],
 * };
 * ```
 */
export interface BackendHandlers {
  memory?: (store: unknown) => unknown;
  sqlite?: (db: unknown) => unknown;
  mongo?: (model: unknown) => unknown;
  postgres?: (pool: unknown) => unknown;
  redis?: (redis: unknown) => unknown;
}

/**
 * Either a universal `HandlerFactory` or a `BackendHandlers` map.
 *
 * Pass to `EntityHandlerRegistry.register()`.
 *
 * @example
 * ```ts
 * import type { HandlerEntry } from '@lastshotlabs/slingshot-entity';
 *
 * // Universal factory (same implementation for all backends):
 * const universalHandler: HandlerEntry = (params) => (driver) => async (input) => {
 *   return { ok: true };
 * };
 *
 * // Per-backend map (different implementation per backend):
 * const perBackend: HandlerEntry = {
 *   sqlite:   (db)   => async (input) => db.prepare('SELECT 1').get(),
 *   postgres: (pool) => async (input) => (await pool.query('SELECT 1')).rows[0],
 * };
 * ```
 */
export type HandlerEntry = HandlerFactory | BackendHandlers;

function isBackendHandlers(entry: HandlerEntry): entry is BackendHandlers {
  return typeof entry !== 'function';
}

/**
 * Registry of named handler entries for `custom` manifest operations.
 *
 * Handlers are registered by name and resolved when a manifest with a
 * `custom` operation is passed to `resolveEntityManifest()`. The registry
 * supports hierarchical lookup via `extend()` — child registries inherit
 * from their parent.
 *
 * @example
 * ```ts
 * import { createEntityHandlerRegistry } from '@lastshotlabs/slingshot-entity';
 * import type { EntityHandlerRegistry } from '@lastshotlabs/slingshot-entity';
 *
 * const registry: EntityHandlerRegistry = createEntityHandlerRegistry();
 * registry.register('sendWelcomeEmail', {
 *   memory:   () => async (input) => ({ sent: true }),
 *   postgres: (pool) => async (input) => {
 *     await pool.query('INSERT INTO email_queue ...', [input.userId]);
 *     return { sent: true };
 *   },
 * });
 *
 * console.log(registry.has('sendWelcomeEmail')); // true
 * console.log(registry.list());                  // ['sendWelcomeEmail']
 * ```
 */
export interface EntityHandlerRegistry {
  /**
   * Register a named handler.
   *
   * @param name - The handler name referenced in manifest `custom` operations.
   * @param handler - Either a `HandlerFactory` (all backends) or a
   *   `BackendHandlers` map (per-backend).
   */
  register(name: string, handler: HandlerEntry): void;

  /**
   * Resolve a handler by name and return the raw entry.
   *
   * Walks up to the parent registry if the name is not found locally.
   *
   * @param name - Registered handler name.
   * @param params - Static params from the manifest to pass to factory handlers.
   * @returns The handler function or per-backend map.
   * @throws {Error} When the name is not registered in this registry or any parent.
   */
  resolve(name: string, params?: Record<string, unknown>): unknown;

  /**
   * Resolve a handler as a `BackendHandlers` map for use inside a
   * `CustomOpConfig`.
   *
   * Each resolved factory in the returned map receives the backend driver
   * at adapter construction time.
   *
   * @param name - Registered handler name.
   * @param params - Static params forwarded to the `HandlerFactory`.
   * @returns A `BackendHandlers` map with one entry per supported backend.
   * @throws {Error} When the name is not registered.
   */
  resolveForCustomOp(name: string, params?: Record<string, unknown>): BackendHandlers;

  /**
   * Return true when the given name is registered in this registry or any
   * parent.
   */
  has(name: string): boolean;

  /**
   * List all registered handler names, including those inherited from parent
   * registries. Names are deduplicated.
   */
  list(): string[];

  /**
   * Create a child registry that inherits all handlers from this one.
   *
   * Child registries can register their own handlers without affecting the
   * parent. Lookups fall through to the parent when not found locally.
   *
   * @returns A new `EntityHandlerRegistry` whose parent is this registry.
   *
   * @example
   * ```ts
   * const global = createEntityHandlerRegistry();
   * global.register('sendEmail', emailHandlers);
   *
   * const pluginRegistry = global.extend();
   * pluginRegistry.register('processPayment', paymentHandlers);
   * // pluginRegistry can resolve both 'sendEmail' and 'processPayment'
   * ```
   */
  extend(): EntityHandlerRegistry;
}

/**
 * Create a new `EntityHandlerRegistry`.
 *
 * The registry maps handler names to `HandlerEntry` values (either a
 * universal `HandlerFactory` or a per-backend `BackendHandlers` map). It is
 * used by `resolveEntityManifest()` to wire `custom` operations from JSON
 * manifests to real implementation functions.
 *
 * @param parent - Optional parent registry. When provided, handler lookups
 *   fall through to the parent if not found locally.
 * @returns A new `EntityHandlerRegistry` instance.
 *
 * @example
 * ```ts
 * import { createEntityHandlerRegistry } from '@lastshotlabs/slingshot-entity';
 *
 * const registry = createEntityHandlerRegistry();
 * registry.register('sendWelcomeEmail', {
 *   memory:   (store) => async (input) => { ... },
 *   postgres: (pool)  => async (input) => { ... },
 * });
 *
 * const { config, operations } = parseAndResolveEntityManifest(rawManifest, registry);
 * ```
 */
export function createEntityHandlerRegistry(parent?: EntityHandlerRegistry): EntityHandlerRegistry {
  const handlers = new Map<string, HandlerEntry>();

  const registry: EntityHandlerRegistry = {
    register(name, handler) {
      handlers.set(name, handler);
    },

    resolve(name, params) {
      const entry = handlers.get(name);
      if (entry) {
        if (isBackendHandlers(entry)) return entry;
        return entry(params);
      }
      if (parent?.has(name)) return parent.resolve(name, params);
      throw new Error(
        `[entity-registry] Unknown handler "${name}". Available: [${registry.list().join(', ')}]`,
      );
    },

    resolveForCustomOp(name, params) {
      const entry = handlers.get(name);
      if (!entry) {
        if (parent?.has(name)) return parent.resolveForCustomOp(name, params);
        throw new Error(
          `[entity-registry] Unknown handler "${name}". Available: [${registry.list().join(', ')}]`,
        );
      }

      if (isBackendHandlers(entry)) {
        // Already per-backend — each factory already receives the backend driver
        return entry;
      }

      // Single factory — call with params to get a (backendDriver) => handler function
      const backendFactory = entry(params);
      return {
        memory: backendFactory,
        sqlite: backendFactory,
        mongo: backendFactory,
        postgres: backendFactory,
        redis: backendFactory,
      };
    },

    has(name) {
      return handlers.has(name) || (parent?.has(name) ?? false);
    },

    list() {
      const local = [...handlers.keys()];
      const parentNames = parent?.list() ?? [];
      return [...new Set([...local, ...parentNames])];
    },

    extend() {
      return createEntityHandlerRegistry(registry);
    },
  };

  return registry;
}
