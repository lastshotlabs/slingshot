// packages/slingshot-ssr/src/isr/memory.ts
import type { IsrCacheAdapter, IsrCacheEntry } from './types';

/** Options for `createMemoryIsrCache()`. */
export interface MemoryIsrCacheOptions {
  /**
   * Maximum number of entries to hold in the cache.
   *
   * When the cache reaches capacity, the oldest entry (by insertion order)
   * is evicted before inserting the new one. This is a simple LRU-lite
   * eviction based on `Map` insertion order — not a full LRU with access
   * recency, but sufficient for most single-instance use cases.
   *
   * Defaults to unbounded when not set.
   */
  maxEntries?: number;
}

/**
 * Create an in-memory ISR cache adapter.
 *
 * Uses a closure-owned `Map` for entries and a `Map<string, Set<string>>`
 * as a tag index (tag → Set of paths). No module-level mutable state —
 * each call returns a fully independent instance (Rule 3).
 *
 * **Suitable for:** Single-instance deployments, dev mode, tests.
 * **Not suitable for:** Multi-instance deployments — use `createRedisIsrCache()`.
 *
 * @param opts - Optional configuration.
 * @returns An {@link IsrCacheAdapter} backed by in-process memory.
 *
 * @example
 * ```ts
 * import { createMemoryIsrCache } from '@lastshotlabs/slingshot-ssr/isr';
 *
 * const cache = createMemoryIsrCache({ maxEntries: 500 });
 * ```
 */
export function createMemoryIsrCache(opts?: MemoryIsrCacheOptions): IsrCacheAdapter {
  // Closure-owned state — zero shared state between factory calls (Rule 3).
  const cache = new Map<string, IsrCacheEntry>();
  // tag → Set<path>: used by invalidateTag() to find all paths for a tag.
  const tagIndex = new Map<string, Set<string>>();
  const maxEntries = opts?.maxEntries;

  return {
    get(path: string): Promise<IsrCacheEntry | null> {
      return Promise.resolve(cache.get(path) ?? null);
    },

    set(path: string, entry: IsrCacheEntry): Promise<void> {
      // Evict oldest entry when at capacity (simple insertion-order LRU).
      if (maxEntries !== undefined && cache.size >= maxEntries && !cache.has(path)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
          // Note: tag index is lazily cleaned — stale path refs are filtered
          // in invalidateTag() when the path no longer exists in cache.
        }
      }

      cache.set(path, entry);

      // Update tag index for each tag on this entry.
      for (const tag of entry.tags) {
        let paths = tagIndex.get(tag);
        if (paths === undefined) {
          paths = new Set<string>();
          tagIndex.set(tag, paths);
        }
        paths.add(path);
      }
      return Promise.resolve();
    },

    invalidatePath(path: string): Promise<void> {
      // Delete the entry. Tag index is lazily cleaned — invalidateTag() skips
      // paths that no longer exist in cache.
      cache.delete(path);
      return Promise.resolve();
    },

    invalidateTag(tag: string): Promise<void> {
      const paths = tagIndex.get(tag);
      if (paths === undefined) return Promise.resolve();

      for (const path of paths) {
        cache.delete(path);
      }

      tagIndex.delete(tag);
      return Promise.resolve();
    },
  };
}
