/**
 * Helper used by feature packages whose adapter- or capability-dependent
 * middleware handlers can only be wired after lifecycle hooks run.
 *
 * The returned ref starts as a pass-through `next()` no-op. The package
 * mounts middleware that forwards through `ref.handler`, then assigns
 * the real handler from `setupMiddleware` or `setupPost` once its
 * dependencies are resolved.
 */
import type { MiddlewareHandler } from 'hono';

/** Mutable container holding the active middleware handler. */
export interface LazyMiddlewareRef {
  handler: MiddlewareHandler;
}

/**
 * Create a `LazyMiddlewareRef` initialised with a pass-through `next()` no-op.
 *
 * Packages should mount middleware that forwards through `ref.handler` so the
 * actual implementation can be swapped in later. The initial value is
 * intentionally a no-op rather than a thrower: routes that read it before the
 * package's `setupPost` runs (e.g. during route definition) still resolve.
 */
export function createLazyMiddleware(): LazyMiddlewareRef {
  return { handler: async (_c, next) => next() };
}
