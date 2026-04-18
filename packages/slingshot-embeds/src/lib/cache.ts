import type { UnfurlResult } from '../types';

/**
 * A simple TTL-based in-memory cache for unfurl results.
 *
 * Entries expire after `ttlMs` and the cache evicts the oldest entry
 * (by insertion order) when `maxEntries` is reached.
 */
export interface EmbedCache {
  /** Retrieve a cached result. Returns `undefined` if missing or expired. */
  get(key: string): UnfurlResult | undefined;
  /** Store a result in the cache. Evicts the oldest entry if at capacity. */
  set(key: string, value: UnfurlResult): void;
  /** Remove all entries from the cache. */
  clear(): void;
  /** Current number of entries (including potentially expired ones not yet pruned). */
  readonly size: number;
}

/**
 * Create a TTL-based in-memory cache for unfurl results.
 *
 * Uses a closure-owned `Map` — no module-level singletons. Each call
 * returns an independent cache instance with its own state.
 *
 * @param opts - Cache configuration.
 * @param opts.ttlMs - Time-to-live for each entry in milliseconds.
 * @param opts.maxEntries - Maximum number of entries before the oldest is evicted.
 * @returns A new {@link EmbedCache} instance.
 */
export function createEmbedCache(opts: { ttlMs: number; maxEntries: number }): EmbedCache {
  const store = new Map<string, { result: UnfurlResult; expiresAt: number }>();

  return {
    get(key: string): UnfurlResult | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.result;
    },

    set(key: string, value: UnfurlResult): void {
      // Delete first so re-insertion moves to end of Map iteration order
      store.delete(key);
      // Evict oldest if at capacity
      if (store.size >= opts.maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) {
          store.delete(oldest);
        }
      }
      store.set(key, { result: value, expiresAt: Date.now() + opts.ttlMs });
    },

    clear(): void {
      store.clear();
    },

    get size(): number {
      return store.size;
    },
  };
}
