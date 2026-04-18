import { getContext, isContextObject } from './contextStore';
import type { SlingshotContext } from './slingshotContext';

/**
 * A value that either IS a `SlingshotContext` or is an app instance that HAS one attached.
 *
 * Used as the parameter type for all context-accessor helpers (`getUserResolver`,
 * `getRateLimitAdapter`, `getCacheAdapter`, etc.) so callers can pass either
 * the raw context or the app without ceremony.
 *
 * @remarks
 * **Branded-context pattern:** `ContextCarrier` is intentionally typed as `SlingshotContext | object`
 * rather than `SlingshotContext | Hono` to avoid importing the Hono type into `contextAccess.ts`
 * and to support any future app container that happens to carry a context via `getContext`.
 * The actual discrimination between "is a context" and "has a context" is performed at
 * runtime by checking for the internal context brand installed by `attachContext()`.
 * This avoids property-shape guessing, which can false-positive on unrelated objects that
 * happen to expose fields like `config` or `cacheAdapters`.
 */
export type ContextCarrier = SlingshotContext | object;

/**
 * Resolve a `SlingshotContext` from a `ContextCarrier`.
 *
 * If `input` is already a branded `SlingshotContext`,
 * it is returned as-is. Otherwise, `getContext(input)` is called to retrieve the context
 * attached to the app instance.
 *
 * @param input - A `SlingshotContext` directly, or a Hono app with an attached context.
 * @returns The resolved `SlingshotContext`.
 * @throws `Error` (propagated from `getContext`) if `input` is an app instance that was not
 *   initialised via `createApp()` — i.e., no context is attached to the WeakMap.
 *
 * @remarks
 * **Explicit branding:** `SlingshotContext` is an interface (no `instanceof` check is
 * possible), so contexts are identified via an internal non-enumerable symbol brand that
 * `attachContext()` installs on the real context object. This avoids false positives from
 * arbitrary objects that resemble the context shape but were never created by framework
 * bootstrap.
 *
 * This is an internal helper used by all context-accessor exports in `slingshot-core`.
 * Plugin code should use the typed accessor helpers (`getUserResolver`, etc.) instead of
 * calling `resolveContext` directly.
 */
export function resolveContext(input: ContextCarrier): SlingshotContext {
  if (typeof input === 'object' && isContextObject(input)) {
    return input;
  }
  return getContext(input);
}
