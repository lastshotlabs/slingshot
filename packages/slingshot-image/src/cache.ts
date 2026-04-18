// packages/slingshot-image/src/cache.ts
import type { ImageCacheAdapter, ImageCacheEntry } from './types';

/**
 * Options for the in-memory LRU image cache.
 */
export interface MemoryImageCacheOptions {
  /**
   * Maximum number of entries to hold before evicting the oldest (LRU).
   * @default 500
   */
  readonly maxEntries?: number;
}

/**
 * Creates an in-memory LRU image cache adapter.
 *
 * Uses a `Map` (insertion-order) as the backing store. When `maxEntries` is
 * reached, the oldest-inserted key is evicted on the next `set()` call.
 *
 * This is the default cache used by `createImagePlugin()` when no custom
 * adapter is provided.
 *
 * @param opts - Optional configuration.
 * @returns An {@link ImageCacheAdapter} backed by a Map.
 *
 * @example
 * ```ts
 * const cache = createMemoryImageCache({ maxEntries: 1000 });
 * ```
 */
export function createMemoryImageCache(opts?: MemoryImageCacheOptions): ImageCacheAdapter {
  const maxEntries = opts?.maxEntries ?? 500;
  const store = new Map<string, ImageCacheEntry>();

  return {
    get(key: string): Promise<ImageCacheEntry | null> {
      const entry = store.get(key);
      if (!entry) return Promise.resolve(null);

      // LRU: re-insert to bump to most-recently-used position
      store.delete(key);
      store.set(key, entry);
      return Promise.resolve(entry);
    },

    set(key: string, entry: ImageCacheEntry): Promise<void> {
      // Evict oldest entry when at capacity
      if (store.size >= maxEntries && !store.has(key)) {
        const oldestKey = store.keys().next().value;
        if (oldestKey !== undefined) {
          store.delete(oldestKey);
        }
      }
      store.set(key, entry);
      return Promise.resolve();
    },
  };
}

/**
 * Build a deterministic cache key from image request parameters.
 *
 * Format: `{url}:{w}:{h}:{f}:{q}` — colons are safe since URL-encoded
 * source URLs cannot contain bare colons in path segments.
 *
 * @internal
 */
export function buildCacheKey(
  url: string,
  width: number,
  height: number | undefined,
  format: string,
  quality: number,
): string {
  return `${url}:${width}:${height ?? ''}:${format}:${quality}`;
}
