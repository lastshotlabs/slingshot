import type { ImageCacheAdapter, ImageCacheEntry, ImageCacheHealth } from './types';

/**
 * Options for the in-memory image cache.
 */
export interface MemoryImageCacheOptions {
  /**
   * Maximum cached entries before least-recently-used eviction kicks in.
   * Default: 500. Bounds working-set memory; lower values increase eviction
   * pressure but reduce footprint.
   */
  readonly maxEntries?: number;
  /**
   * Time-to-live for cache entries, in milliseconds. Default: 1 hour
   * (3 600 000 ms). On every `get`, an entry whose `generatedAt` plus this
   * TTL has elapsed is evicted and the call returns `null` as if it were a
   * miss. Set to `0` to disable TTL eviction (entries live until LRU
   * pressure removes them).
   */
  readonly ttlMs?: number;
  /**
   * Optional clock injection for tests. Defaults to `Date.now`. The result is
   * compared against entry `generatedAt` timestamps for TTL eviction.
   */
  readonly now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 60 * 60_000; // 1 hour

/**
 * Create an in-memory least-recently-used image cache.
 *
 * Tracks cumulative LRU and TTL eviction counts for observability via
 * `getHealth()`. Entries are bounded by both `maxEntries` (size cap) and
 * `ttlMs` (per-entry expiry checked on every `get`).
 *
 * @param opts - Optional cache sizing and TTL configuration.
 * @returns A cache adapter backed by a `Map`.
 */
export function createMemoryImageCache(opts?: MemoryImageCacheOptions): ImageCacheAdapter {
  const maxEntries = Math.max(1, opts?.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const ttlMs = Math.max(0, opts?.ttlMs ?? DEFAULT_TTL_MS);
  const now = opts?.now ?? (() => Date.now());
  const store = new Map<string, ImageCacheEntry>();
  let evictionCount = 0;
  let ttlEvictionCount = 0;

  function isExpired(entry: ImageCacheEntry): boolean {
    if (ttlMs === 0) return false;
    return now() - entry.generatedAt >= ttlMs;
  }

  return {
    get(key: string): Promise<ImageCacheEntry | null> {
      const entry = store.get(key);
      if (!entry) return Promise.resolve(null);

      if (isExpired(entry)) {
        store.delete(key);
        ttlEvictionCount += 1;
        return Promise.resolve(null);
      }

      // Refresh LRU position
      store.delete(key);
      store.set(key, entry);
      return Promise.resolve(entry);
    },

    set(key: string, entry: ImageCacheEntry): Promise<void> {
      if (store.size >= maxEntries && !store.has(key)) {
        const oldestKey = store.keys().next().value;
        if (oldestKey !== undefined) {
          store.delete(oldestKey);
          evictionCount += 1;
        }
      }
      store.set(key, entry);
      return Promise.resolve();
    },

    getHealth(): ImageCacheHealth {
      return { size: store.size, evictionCount, ttlEvictionCount };
    },
  };
}

/**
 * Inputs to {@link buildCacheKey}.
 */
export interface ImageCacheKeyInput {
  /** Tenant identifier scope, or `null` for un-scoped/global tenancy. */
  readonly tenantId: string | null;
  /** Owner user identifier scope, or `null` when not owned by a user. */
  readonly ownerUserId: string | null;
  /** Asset source identifier (storage key or URL). */
  readonly source: string;
  /** Requested width. */
  readonly width: number;
  /** Requested height, or `undefined` to preserve aspect. */
  readonly height: number | undefined;
  /** Requested output format. */
  readonly format: string;
  /** Requested output quality. */
  readonly quality: number;
}

function escapeKeyComponent(value: string): string {
  return value.replace(/\|/g, '%7C');
}

/**
 * Build a deterministic cache key for an image transform request, scoped by
 * tenant and owner to prevent cross-tenant leakage.
 *
 * The key is structured as a pipe-delimited tuple so individual components are
 * unambiguously parseable. Each component is escaped to prevent boundary
 * confusion when a component contains a pipe character.
 *
 * @param input - Tenant, owner, source, and transform parameters.
 * @returns Stable cache key for the request.
 */
export function buildCacheKey(input: ImageCacheKeyInput): string {
  const { tenantId, ownerUserId, source, width, height, format, quality } = input;
  return [
    'v2',
    escapeKeyComponent(tenantId ?? ''),
    escapeKeyComponent(ownerUserId ?? ''),
    escapeKeyComponent(source),
    String(width),
    height === undefined ? '' : String(height),
    escapeKeyComponent(format),
    String(quality),
  ].join('|');
}
