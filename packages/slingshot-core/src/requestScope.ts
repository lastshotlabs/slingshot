/**
 * Request-scoped state — the canonical way to wire per-request resources.
 *
 * A request scope is a typed handle for "something that exists for the duration
 * of a single HTTP request and gets cleaned up at the end." Common examples:
 * a database transaction, a per-request HTTP client with the actor's token,
 * an idempotency session, a request-bound tracing helper.
 *
 * The framework runs `factory` lazily on first `getRequestScoped(c, scope)`
 * inside a request and caches the result for the rest of that request. After
 * the handler returns (success or error), the framework calls `cleanup` for
 * every scope that was actually initialized — in LIFO order, so a transaction
 * can roll back before its underlying connection is released.
 */
import type { Context } from 'hono';

/**
 * Context passed to a request scope's `factory` and `cleanup` functions.
 *
 * `request` is the live Hono context; use it for headers, params, the actor,
 * or other per-request data. The Slingshot context can be reached via
 * `getSlingshotCtx(request)` for app-wide handles.
 */
export interface RequestScopeContext {
  readonly request: Context;
}

/**
 * A typed request-scope handle. The `T` parameter is the type of the value
 * produced by `factory` and consumed by `getRequestScoped`.
 *
 * Construct via {@link defineRequestScope}. The `__brand` field exists only at
 * the type level so callers of `getRequestScoped` get the right value type;
 * it is never read at runtime.
 */
export interface RequestScope<T = unknown> {
  /** Stable name used as the storage key for the per-request value. */
  readonly name: string;
  /** Produces the request-scoped value on first access. Awaited if async. */
  readonly factory: (context: RequestScopeContext) => T | Promise<T>;
  /**
   * Optional cleanup, called once per request when a value was actually
   * produced. Runs in `try/finally` after the handler resolves — the framework
   * does not surface errors thrown here, but logs them via `console.warn`.
   */
  readonly cleanup?: (value: T, context: RequestScopeContext) => void | Promise<void>;
  /** Phantom brand used only for type inference on `getRequestScoped`. */
  readonly __brand?: T;
}

/**
 * Declare a request scope. This is a typed identity helper — it doesn't
 * register anything by itself. Pass the result to
 * `defineApp({ requestScopes: [...] })` to wire it into the request lifecycle.
 *
 * @example
 * ```ts
 * import { defineRequestScope, getRequestScoped } from '@lastshotlabs/slingshot';
 *
 * export const dbTransaction = defineRequestScope({
 *   name: 'dbTransaction',
 *   factory: async ({ request }) => {
 *     const ctx = getSlingshotCtx(request);
 *     return ctx.persistence.beginTransaction();
 *   },
 *   cleanup: async tx => {
 *     // The handler should have committed by now; rollback is a safety net.
 *     if (tx.isOpen()) await tx.rollback();
 *   },
 * });
 *
 * // In a route handler:
 * route.post({
 *   path: '/publish',
 *   handler: async ({ request, respond }) => {
 *     const tx = await getRequestScoped(request, dbTransaction);
 *     await tx.commit();
 *     return respond.json({ ok: true });
 *   },
 * });
 * ```
 */
export function defineRequestScope<T>(spec: {
  readonly name: string;
  readonly factory: (context: RequestScopeContext) => T | Promise<T>;
  readonly cleanup?: (value: T, context: RequestScopeContext) => void | Promise<void>;
}): RequestScope<T> {
  return Object.freeze(spec) as RequestScope<T>;
}

/**
 * Internal storage slot stashed on the Hono context. Holds the registered
 * scope definitions plus the per-request map of initialized values.
 */
export interface RequestScopeStore {
  readonly definitions: ReadonlyMap<string, RequestScope>;
  readonly initialized: Map<string, unknown>;
}

const STORE_KEY = '__slingshotRequestScopes';

/** Internal: install the per-request store. Used by the framework middleware. */
export function setRequestScopeStore(c: Context, store: RequestScopeStore): void {
  (c as unknown as { set(key: string, value: unknown): void }).set(STORE_KEY, store);
}

/** Internal: read the per-request store. Returns undefined when middleware isn't active. */
export function getRequestScopeStore(c: Context): RequestScopeStore | undefined {
  return (c as unknown as { get(key: string): unknown }).get(STORE_KEY) as
    | RequestScopeStore
    | undefined;
}

/**
 * Resolve a request-scoped value. Lazily runs the scope's `factory` on first
 * call within a given request and returns the cached value on subsequent
 * calls. Throws when called outside an active request (i.e. when the
 * request-scope middleware is not in the middleware chain).
 *
 * @example
 * ```ts
 * route.post({
 *   path: '/charge',
 *   handler: async ({ request, respond }) => {
 *     const tx = await getRequestScoped(request, dbTransaction);
 *     await chargeCard(tx, ...);
 *     await tx.commit();
 *     return respond.json({ ok: true });
 *   },
 * });
 * ```
 */
export async function getRequestScoped<T>(c: Context, scope: RequestScope<T>): Promise<T> {
  const store = getRequestScopeStore(c);
  if (!store) {
    throw new Error(
      `[slingshot] getRequestScoped('${scope.name}') called outside a request scope. ` +
        `Did you forget to register the scope on defineApp({ requestScopes: [...] })?`,
    );
  }
  if (!store.definitions.has(scope.name)) {
    throw new Error(
      `[slingshot] Request scope '${scope.name}' is not registered. ` +
        `Add it to defineApp({ requestScopes: [...] }).`,
    );
  }
  if (store.initialized.has(scope.name)) {
    return store.initialized.get(scope.name) as T;
  }
  const value = await scope.factory({ request: c });
  store.initialized.set(scope.name, value);
  return value;
}
