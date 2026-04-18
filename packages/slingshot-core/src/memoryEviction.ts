// ---------------------------------------------------------------------------
// Memory store eviction utilities
// ---------------------------------------------------------------------------

/**
 * Evict the oldest entries from a `Map` when it exceeds `maxEntries`.
 *
 * JavaScript `Map` iterates in insertion order, so the entries deleted from
 * the front are always the oldest. Useful for capping memory store size in
 * development and single-process deployments.
 *
 * @param map - The map to evict entries from.
 * @param maxEntries - Maximum number of entries to retain.
 *
 * @example
 * ```ts
 * import { evictOldest } from '@lastshotlabs/slingshot-core';
 *
 * const cache = new Map<string, string>();
 * cache.set('a', '1'); cache.set('b', '2'); cache.set('c', '3');
 * evictOldest(cache, 2); // removes 'a'
 * ```
 */
export function evictOldest<K, V>(map: Map<K, V>, maxEntries: number): void {
  if (map.size <= maxEntries) return;
  const excess = map.size - maxEntries;
  let i = 0;
  for (const key of map.keys()) {
    if (i++ >= excess) break;
    map.delete(key);
  }
}

/**
 * Default interval between full O(n) expired-entry scans for a single in-memory store.
 *
 * Passed as the default `intervalMs` argument to `createEvictExpired()`. A 5-second
 * interval keeps memory bounded for typical write rates without degrading throughput.
 * Override via the `intervalMs` parameter when a tighter or looser sweep cadence is needed.
 */
const EVICTION_INTERVAL_MS = 5_000;

/**
 * Create a throttled expired-entry eviction function for use with in-memory stores.
 *
 * Each call returns an independent eviction function with closure-owned state —
 * no shared module-level state between instances. The eviction function scans
 * the provided `Map` for entries whose `expiresAt` has passed, removing them.
 * The O(n) scan is throttled to run at most once per `intervalMs` to avoid
 * performance degradation on high-frequency write paths.
 *
 * Call this once inside the factory that creates the in-memory store, then call
 * the returned function on each write to trigger periodic cleanup.
 *
 * @param intervalMs - Minimum milliseconds between full scans. Defaults to 5000 ms.
 * @returns A function `(map: Map<K, V>) => void` that evicts expired entries.
 *
 * @remarks
 * The returned function only prevents the map from growing unboundedly — individual
 * reads should still check `expiresAt` at point-in-time to avoid serving stale
 * values between scan intervals.
 *
 * @example
 * ```ts
 * import { createEvictExpired } from '@lastshotlabs/slingshot-core';
 *
 * function createMyStore() {
 *   const store = new Map<string, { value: string; expiresAt?: number }>();
 *   const evictExpired = createEvictExpired();
 *
 *   return {
 *     set(key: string, value: string, expiresAt: number) {
 *       evictExpired(store);
 *       store.set(key, { value, expiresAt });
 *     },
 *   };
 * }
 * ```
 */
export function createEvictExpired(
  intervalMs = EVICTION_INTERVAL_MS,
): <K, V extends { expiresAt?: number }>(map: Map<K, V>) => void {
  const lastEvictionTime = new WeakMap<object, number>();
  return function evictExpired<K, V extends { expiresAt?: number }>(map: Map<K, V>): void {
    const now = Date.now();
    const last = lastEvictionTime.get(map) ?? 0;
    if (now - last < intervalMs) return;
    lastEvictionTime.set(map, now);
    for (const [key, val] of map) {
      if (val.expiresAt && val.expiresAt <= now) map.delete(key);
    }
  };
}

/**
 * Evict the oldest entries from an `Array` when it exceeds `maxEntries`.
 *
 * Splices from the front (index 0), assuming the array is ordered oldest-first.
 * Used for fixed-size append-only arrays like password history.
 *
 * @param arr - The array to trim. Modified in place.
 * @param maxEntries - Maximum number of entries to retain (newest entries survive).
 *
 * @example
 * ```ts
 * import { evictOldestArray } from '@lastshotlabs/slingshot-core';
 *
 * const history = ['h1', 'h2', 'h3', 'h4', 'h5'];
 * evictOldestArray(history, 3); // history = ['h3', 'h4', 'h5']
 * ```
 */
export function evictOldestArray(arr: unknown[], maxEntries: number): void {
  if (arr.length <= maxEntries) return;
  arr.splice(0, arr.length - maxEntries);
}

/**
 * Default maximum entry count for development and test in-memory stores.
 *
 * Applied by `createMemoryRateLimitAdapter` and `createMemoryCacheAdapter`
 * to prevent unbounded growth in long-running dev processes.
 */
export const DEFAULT_MAX_ENTRIES = 10_000;
