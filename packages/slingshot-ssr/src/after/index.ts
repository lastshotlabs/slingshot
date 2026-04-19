// packages/slingshot-ssr/src/after/index.ts
// Per-request after-callback queue.
//
// Provides `withAfterContext()` (wraps the request handler to create a fresh
// queue) and the `buildAfterFn()` factory (creates the `after()` scheduler
// injected into each load context via `shell._after`). Callbacks are drained
// by `drainAfterCallbacks()` after the response stream flushes.
//
// Rule 3 note: The ALS instance is module-level but is a request-scoped
// container. All state lives inside the value passed to `afterStore.run()`,
// created fresh per request.
//
// Edge compat: uses the same lazy getAls() pattern as actions/context.ts.
import { getAsyncLocalStorageConstructor } from '../asyncLocalStorage';

type AlsConstructor = typeof import('node:async_hooks').AsyncLocalStorage;

type AfterQueue = Array<() => void | Promise<void>>;

/**
 * Returns the `AsyncLocalStorage` constructor, or `null` on edge runtimes.
 * Resolution order: globalThis polyfill → node:async_hooks → null.
 */
const getAls = (): AlsConstructor | null => getAsyncLocalStorageConstructor();

const AlsClass = getAls();
const afterStore: InstanceType<AlsConstructor> | null = AlsClass
  ? new AlsClass<AfterQueue>()
  : null;

/**
 * Wrap a request handler with a fresh per-request after-callback queue.
 *
 * All `after()` calls within `fn` (including those inside nested load functions)
 * are captured in the same queue and drained when `drainAfterCallbacks()` is
 * called after the response stream flushes.
 *
 * On edge runtimes where ALS is unavailable, `fn` is called directly and
 * `after()` callbacks are silently discarded.
 *
 * @param fn - The async request handler to execute within the after context.
 * @returns The return value of `fn`.
 * @internal
 */
export function withAfterContext<T>(fn: () => Promise<T>): Promise<T> {
  if (!afterStore) return fn();
  return afterStore.run([], fn);
}

/**
 * Build the `after()` scheduler for a single request.
 *
 * Returns a function that, when called from within a load function, enqueues
 * a callback in the current request's after-queue. Pass the returned function
 * as `shell._after` so that `buildLoadContext()` in the renderer can expose
 * it as `ctx.after()`.
 *
 * On edge runtimes, returns a no-op function with a console warning.
 *
 * @returns The `after(callback)` scheduler for the current request context.
 * @internal
 */
export function buildAfterFn(): (callback: () => void | Promise<void>) => void {
  if (!afterStore) {
    return () => {
      console.warn(
        '[slingshot-ssr] after(): not supported in edge runtime (AsyncLocalStorage unavailable). ' +
          'Callback will not run.',
      );
    };
  }
  return (callback: () => void | Promise<void>) => {
    const queue = afterStore.getStore() as AfterQueue | undefined;
    if (!queue) {
      console.warn(
        '[slingshot-ssr] after(): called outside of a request context. ' +
          'Ensure it is called from within a load() function during SSR.',
      );
      return;
    }
    queue.push(callback);
  };
}

/**
 * Run all after-callbacks registered for the current request.
 *
 * Called by the SSR middleware after the response body stream has been flushed.
 * Callbacks are executed in registration order. Errors in individual callbacks
 * are caught and logged — they never propagate to the caller or affect other
 * callbacks in the queue.
 *
 * Safe to call outside an after context (returns immediately).
 *
 * @internal
 */
export async function drainAfterCallbacks(): Promise<void> {
  if (!afterStore) return;
  const queue = afterStore.getStore() as AfterQueue | undefined;
  if (!queue || queue.length === 0) return;
  const callbacks = queue.splice(0);
  for (const cb of callbacks) {
    try {
      await cb();
    } catch (err) {
      console.error('[slingshot-ssr] after() callback threw:', err);
    }
  }
}
