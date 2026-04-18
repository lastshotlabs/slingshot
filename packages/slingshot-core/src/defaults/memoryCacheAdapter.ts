// ---------------------------------------------------------------------------
// In-memory CacheAdapter — default when no auth plugin is registered.
// ---------------------------------------------------------------------------
import type { CacheAdapter } from '../cache';
import { DEFAULT_MAX_ENTRIES, createEvictExpired, evictOldest } from '../memoryEviction';

interface CacheEntry {
  value: string;
  expiresAt?: number;
}

/**
 * Creates an in-memory `CacheAdapter` backed by a `Map` with TTL support.
 *
 * Supports `get`, `set` (with optional TTL in seconds), `del`, and glob `delPattern`.
 * Entries expire on `get` (point-in-time check) and are periodically swept by
 * `evictExpired`. Store size is capped at `DEFAULT_MAX_ENTRIES`.
 *
 * @returns A `CacheAdapter` suitable for single-process deployments and development.
 *
 * @remarks
 * This adapter is **not** distributed. For production multi-instance deployments,
 * use a Redis-backed cache adapter registered via the auth or cache plugin.
 *
 * @example
 * ```ts
 * import { createMemoryCacheAdapter } from '@lastshotlabs/slingshot-core';
 *
 * const cache = createMemoryCacheAdapter();
 * await cache.set('session:abc', JSON.stringify(sessionData), 900); // 15 min TTL
 * const raw = await cache.get('session:abc');
 * ```
 */
export function createMemoryCacheAdapter(): CacheAdapter {
  const store = new Map<string, CacheEntry>();
  const evictExpired = createEvictExpired();

  return {
    name: 'memory',

    get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return Promise.resolve(null);
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        store.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(entry.value);
    },

    set(key: string, value: string, ttl?: number): Promise<void> {
      const expiresAt = ttl ? Date.now() + ttl * 1000 : undefined;
      evictExpired(store);
      evictOldest(store, DEFAULT_MAX_ENTRIES);
      store.set(key, { value, expiresAt });
      return Promise.resolve();
    },

    del(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },

    /**
     * Delete all cache keys matching a glob-style pattern.
     *
     * @param pattern - A glob pattern where `*` matches any sequence of characters.
     *   All other regex-special characters are treated as literals.
     *
     * @remarks
     * The pattern is converted to a `RegExp` in two steps:
     * 1. All regex metacharacters except `*` (i.e. `. + ^ $ { } ( ) | [ ] \`) are
     *    escaped with a backslash so they match literally. This prevents injection of
     *    arbitrary regex syntax from caller-controlled pattern strings.
     * 2. Each `*` (after escaping) is replaced with `.*` to implement glob semantics —
     *    matching zero or more of any character.
     * The resulting pattern is anchored with `^` and `$` to require a full-key match
     * rather than a substring match.
     *
     * Example transformations:
     * - `'session:*'`     → `/^session:.*$/`   — deletes all session keys
     * - `'rate.limit.*'`  → `/^rate\.limit\..*$/` — the `.` is escaped to match literally
     * - `'cache[1]'`      → `/^cache\[1\]$/`   — brackets are escaped
     *
     * Scanning is O(n) in the number of stored keys. For stores with many entries,
     * prefer more targeted single-key `del()` calls when the key is known exactly.
     */
    delPattern(pattern: string): Promise<void> {
      const regex = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      );
      for (const key of store.keys()) {
        if (regex.test(key)) store.delete(key);
      }
      return Promise.resolve();
    },

    isReady(): boolean {
      return true;
    },
  };
}
