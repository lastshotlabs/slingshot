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
