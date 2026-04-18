import type { ImageCacheAdapter, ImageCacheEntry } from './types';

/**
 * Options for the in-memory image cache.
 */
export interface MemoryImageCacheOptions {
  /** Maximum cached entries before least-recently-used eviction. */
  readonly maxEntries?: number;
}

/**
 * Create an in-memory least-recently-used image cache.
 *
 * @param opts - Optional cache sizing configuration.
 * @returns A cache adapter backed by a `Map`.
 */
export function createMemoryImageCache(opts?: MemoryImageCacheOptions): ImageCacheAdapter {
  const maxEntries = opts?.maxEntries ?? 500;
  const store = new Map<string, ImageCacheEntry>();

  return {
    get(key: string): Promise<ImageCacheEntry | null> {
      const entry = store.get(key);
      if (!entry) return Promise.resolve(null);

      store.delete(key);
      store.set(key, entry);
      return Promise.resolve(entry);
    },

    set(key: string, entry: ImageCacheEntry): Promise<void> {
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
 * Build a deterministic cache key for an image transform request.
 *
 * @param source - Asset source identifier.
 * @param width - Requested width.
 * @param height - Requested height.
 * @param format - Requested output format.
 * @param quality - Requested output quality.
 * @returns Stable cache key for the request.
 */
export function buildCacheKey(
  source: string,
  width: number,
  height: number | undefined,
  format: string,
  quality: number,
): string {
  return `${source}:${width}:${height ?? ''}:${format}:${quality}`;
}
