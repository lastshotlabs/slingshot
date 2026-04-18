// packages/runtime-edge/src/kv-isr.ts
import type { IsrCacheAdapter, IsrCacheEntry } from '@lastshotlabs/slingshot-ssr';

// ---------------------------------------------------------------------------
// KV namespace structural interface
// ---------------------------------------------------------------------------

/**
 * Minimal structural interface for a Cloudflare KV Namespace.
 *
 * Defined structurally so `runtime-edge` does not require `@cloudflare/workers-types`
 * as a dependency. Any KV binding that satisfies these method signatures is compatible.
 *
 * @example
 * ```ts
 * // In your worker, the KV binding satisfies this interface automatically:
 * const cache = createKvIsrCache(env.ISR_CACHE);
 * ```
 */
export interface KvNamespace {
  /**
   * Get the string value of a KV key.
   * Returns `null` if the key does not exist.
   */
  get(key: string, options: { type: 'text' }): Promise<string | null>;
  /**
   * Put a value into KV with an optional TTL.
   * @param key - The key to write.
   * @param value - The string value to store.
   * @param options - Optional configuration.
   * @param options.expirationTtl - Seconds until the key expires.
   */
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  /**
   * Delete a KV key.
   */
  delete(key: string): Promise<void>;
  /**
   * List KV keys, optionally filtered by prefix.
   * Returns up to 1000 keys per call (Cloudflare KV limitation).
   */
  list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }>;
}

// ---------------------------------------------------------------------------
// Key scheme constants
// ---------------------------------------------------------------------------

/** KV key prefix for cached ISR page entries (stored as JSON IsrCacheEntry). */
const PAGE_PREFIX = 'isr:page:';
/** KV key prefix for tag-to-paths index entries (stored as JSON string[]). */
const TAG_PREFIX = 'isr:tag:';

function pageKey(path: string): string {
  return `${PAGE_PREFIX}${path}`;
}

function tagKey(tag: string): string {
  return `${TAG_PREFIX}${tag}`;
}

// ---------------------------------------------------------------------------
// Per-tag serialization lock
// ---------------------------------------------------------------------------

/**
 * Per-tag promise chain used to serialize tag index read-modify-write operations.
 *
 * Cloudflare KV has no CAS primitive, so concurrent `set()` calls for pages
 * sharing a tag would race on the JSON array stored at `isr:tag:{tag}`. Chaining
 * updates through a per-tag promise ensures they execute one at a time within a
 * single Worker isolate, eliminating the in-process race.
 *
 * Note: this does not protect against races across multiple Worker instances
 * (Cloudflare KV is eventually consistent). For strict cross-instance consistency,
 * use Durable Objects.
 *
 * @internal
 */
const tagLocks = new Map<string, Promise<void>>();

/**
 * Append `path` to the tag index for `tag` in a serialized, race-safe manner.
 *
 * Chains onto any in-progress update for the same tag so concurrent callers
 * do not overwrite each other's writes.
 *
 * @param kv - The KV namespace to read/write.
 * @param tag - The tag whose index should be updated.
 * @param path - The URL path to append to the tag index.
 * @internal
 */
function updateTagIndex(kv: KvNamespace, tag: string, path: string): Promise<void> {
  const prev = tagLocks.get(tag) ?? Promise.resolve();
  const next = prev.then(async () => {
    const raw = await kv.get(tagKey(tag), { type: 'text' });
    let paths: string[];
    if (raw !== null) {
      try {
        paths = JSON.parse(raw) as string[];
      } catch {
        paths = [];
      }
    } else {
      paths = [];
    }
    if (!paths.includes(path)) {
      paths.push(path);
      await kv.put(tagKey(tag), JSON.stringify(paths));
    }
  });
  // Don't let a failed update poison the chain for future callers.
  tagLocks.set(
    tag,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Remove `path` from the tag index for `tag` in a serialized, race-safe manner.
 *
 * @param kv - The KV namespace to read/write.
 * @param tag - The tag whose index should be updated.
 * @param path - The URL path to remove from the tag index.
 * @internal
 */
function removeFromTagIndex(kv: KvNamespace, tag: string, path: string): Promise<void> {
  const prev = tagLocks.get(tag) ?? Promise.resolve();
  const next = prev.then(async () => {
    const raw = await kv.get(tagKey(tag), { type: 'text' });
    if (raw === null) return;
    let paths: string[];
    try {
      paths = JSON.parse(raw) as string[];
    } catch {
      return;
    }
    const filtered = paths.filter(p => p !== path);
    if (filtered.length === paths.length) return; // path wasn't present
    if (filtered.length === 0) {
      await kv.delete(tagKey(tag));
    } else {
      await kv.put(tagKey(tag), JSON.stringify(filtered));
    }
  });
  tagLocks.set(
    tag,
    next.catch(() => {}),
  );
  return next;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create an ISR cache adapter backed by Cloudflare KV.
 *
 * Suitable for multi-instance Cloudflare Workers deployments. Each Worker
 * instance reads and writes through the shared KV namespace, ensuring that
 * ISR cache invalidations propagate globally.
 *
 * **Key scheme:**
 * - `isr:page:{path}` — JSON-serialized `IsrCacheEntry` for the given URL path.
 * - `isr:tag:{tag}` — JSON-serialized `string[]` of paths tagged with the given tag.
 *
 * **TTL behaviour:**
 * KV entries for page caches are written without a TTL — the ISR middleware's
 * stale-while-revalidate logic controls staleness via `IsrCacheEntry.revalidateAfter`.
 * Tag index entries are also written without a TTL. Invalidation removes keys
 * explicitly via `kv.delete()`.
 *
 * **Eventual consistency:**
 * Cloudflare KV has eventual consistency guarantees. Invalidation may take up to
 * 60 seconds to propagate globally. For strict consistency requirements, use
 * Cloudflare Durable Objects instead.
 *
 * @param kv - A Cloudflare KV namespace binding. Satisfies `KvNamespace` structurally.
 * @returns An `IsrCacheAdapter` backed by the given KV namespace.
 *
 * @example
 * ```ts
 * import { createKvIsrCache } from '@lastshotlabs/runtime-edge/kv';
 *
 * interface Env {
 *   ISR_CACHE: KVNamespace;
 * }
 *
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     const app = await createApp({
 *       plugins: [
 *         createSsrPlugin({
 *           isr: { adapter: createKvIsrCache(env.ISR_CACHE) },
 *           // ...
 *         }),
 *       ],
 *     });
 *     return app.fetch(request);
 *   },
 * };
 * ```
 */
export function createKvIsrCache(kv: KvNamespace): IsrCacheAdapter {
  return {
    /**
     * Retrieve the cached entry for a URL path.
     *
     * @param path - The URL pathname to look up (e.g. `'/posts/nba-finals'`).
     * @returns The cached entry, or `null` on a miss or parse failure.
     */
    async get(path: string): Promise<IsrCacheEntry | null> {
      const raw = await kv.get(pageKey(path), { type: 'text' });
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as IsrCacheEntry;
      } catch {
        // Corrupt KV entry — treat as a cache miss.
        return null;
      }
    },

    /**
     * Store a rendered entry for a URL path and update the tag index.
     *
     * Before writing the new entry, the previous entry (if any) is read to
     * determine which tags are being removed. Paths are removed from stale tag
     * indexes so that `invalidateTag(oldTag)` cannot evict pages that are no
     * longer tagged that way. All tag index mutations are serialized per-tag via
     * `updateTagIndex` / `removeFromTagIndex` to prevent concurrent write races.
     *
     * @param path - The URL pathname to cache.
     * @param entry - The rendered entry to store.
     */
    async set(path: string, entry: IsrCacheEntry): Promise<void> {
      // Read the old entry (if any) so we can diff its tags against the new ones.
      const existingRaw = await kv.get(pageKey(path), { type: 'text' });
      let oldTags: readonly string[] = [];
      if (existingRaw !== null) {
        try {
          const existing = JSON.parse(existingRaw) as IsrCacheEntry;
          oldTags = existing.tags;
        } catch {
          oldTags = [];
        }
      }

      const newTags = entry.tags;
      const newTagSet = new Set(newTags);
      const oldTagSet = new Set(oldTags);

      // Write the new page entry.
      await kv.put(pageKey(path), JSON.stringify(entry));

      // Remove path from tag indexes it no longer belongs to.
      const removedTags = oldTags.filter(t => !newTagSet.has(t));
      // Add path to tag indexes it newly (or still) belongs to.
      const addedTags = newTags.filter(t => !oldTagSet.has(t));

      await Promise.all([
        ...removedTags.map(tag => removeFromTagIndex(kv, tag, path)),
        ...addedTags.map(tag => updateTagIndex(kv, tag, path)),
      ]);
    },

    /**
     * Remove the cached entry for a specific URL path.
     *
     * Does not clean up tag index entries — stale tag references are harmless:
     * `invalidateTag` will skip missing page keys without error.
     *
     * @param path - The URL pathname to invalidate.
     */
    async invalidatePath(path: string): Promise<void> {
      await kv.delete(pageKey(path));
    },

    /**
     * Remove all cached entries tagged with the given tag.
     *
     * Reads the tag index to find all paths, deletes each page entry, then
     * removes the tag index key itself.
     *
     * @param tag - The tag to invalidate (e.g. `'posts'`, `'post:abc123'`).
     */
    async invalidateTag(tag: string): Promise<void> {
      const indexKey = tagKey(tag);
      const raw = await kv.get(indexKey, { type: 'text' });
      if (raw === null) return;

      let paths: string[];
      try {
        paths = JSON.parse(raw) as string[];
      } catch {
        // Corrupt tag index — delete it and return.
        await kv.delete(indexKey);
        return;
      }

      // Delete all page entries in parallel.
      await Promise.all(paths.map(p => kv.delete(pageKey(p))));

      // Remove the tag index entry.
      await kv.delete(indexKey);
    },
  };
}
