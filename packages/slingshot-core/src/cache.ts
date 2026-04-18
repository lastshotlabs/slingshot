import { type ContextCarrier, resolveContext } from './context/contextAccess';
import type { CacheAdapter, CacheStoreName } from './coreContracts';

export type { CacheAdapter, CacheStoreName };

// ---------------------------------------------------------------------------
// CacheAdapter -- unified cache interface for framework response caching.
// ---------------------------------------------------------------------------

/**
 * Cache adapter for framework response caching.
 *
 * Implementations provide get/set/del/delPattern for a single backing store.
 * The framework's cacheResponse middleware delegates to whichever adapter
 * is resolved for the configured store type on the app instance.
 */
/**
 * Retrieve the `CacheAdapter` registered for a named store on a Slingshot app or context instance.
 *
 * The framework supports multiple cache backends per app (redis, memory, sqlite, etc.).
 * Each store is registered separately and retrieved by its `CacheStoreName` key.
 * Use this in framework internals and plugins that need to cache responses or state.
 *
 * @param input - A `SlingshotContext` or a Hono app with an attached context.
 * @param store - The backing store name to retrieve the adapter for.
 * @returns The registered `CacheAdapter` for the given store.
 * @throws If no adapter has been registered for `store`.
 *
 * @example
 * ```ts
 * import { getCacheAdapter, getContext } from '@lastshotlabs/slingshot-core';
 *
 * const cache = getCacheAdapter(getContext(app), 'redis');
 * await cache.set('key', JSON.stringify(value), 300); // TTL 5 min
 * ```
 */
export function getCacheAdapter(input: ContextCarrier, store: CacheStoreName): CacheAdapter {
  const adapter = resolveContext(input).cacheAdapters.get(store);
  if (!adapter) {
    throw new Error(`No CacheAdapter registered for store "${store}" on this app instance.`);
  }
  return adapter;
}

/**
 * Retrieve the `CacheAdapter` for a named store, returning `null` if not registered.
 *
 * Use this when the cache adapter is optional and you want to handle the missing-adapter
 * case gracefully without catching an error. This is the null-safe companion to
 * {@link getCacheAdapter} — prefer it in plugin code where cache support is opt-in
 * and the calling path must degrade gracefully when no adapter is configured.
 *
 * @param input - A `SlingshotContext` or a Hono app with an attached context.
 * @param store - The backing store name to retrieve the adapter for (e.g. `'redis'`, `'memory'`).
 * @returns The registered `CacheAdapter` for the given store, or `null` if no adapter has
 *   been registered for that store on this app instance.
 *
 * @remarks
 * Unlike {@link getCacheAdapter}, this function never throws. It returns `null` whenever
 * the adapter is absent, letting the caller decide whether to skip caching or fall back
 * to a default behaviour. Only use {@link getCacheAdapter} (the throwing variant) when
 * the adapter is unconditionally required and its absence represents a configuration error.
 *
 * @example
 * ```ts
 * import { getCacheAdapterOrNull, getContext } from '@lastshotlabs/slingshot-core';
 *
 * const cache = getCacheAdapterOrNull(app, 'redis');
 * if (cache) {
 *   const cached = await cache.get('my-key');
 *   if (cached) return JSON.parse(cached);
 * }
 * // Fall through to compute the value when cache is unavailable.
 * ```
 */
export function getCacheAdapterOrNull(
  input: ContextCarrier,
  store: CacheStoreName,
): CacheAdapter | null {
  return resolveContext(input).cacheAdapters.get(store) ?? null;
}
