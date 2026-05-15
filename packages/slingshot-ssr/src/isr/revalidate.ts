// packages/slingshot-ssr/src/isr/revalidate.ts
import type { IsrCacheAdapter } from './types';

/**
 * ISR invalidation utilities bound to a specific cache adapter instance.
 * Resolved by consumers through `IsrInvalidatorsCap` published by the SSR
 * package.
 */
export interface IsrInvalidators {
  /**
   * Invalidate the ISR cache entry for a specific URL pathname.
   *
   * The next request for this path will bypass the cache and trigger a fresh
   * render. The result is then cached again if `revalidate` is set.
   *
   * @param path - The URL pathname to invalidate (e.g. `'/posts/nba-finals'`).
   */
  revalidatePath(path: string): Promise<void>;

  /**
   * Invalidate all ISR cache entries tagged with the given tag.
   *
   * Use granular tags like `'post:abc123'` to invalidate a single item,
   * or broad tags like `'posts'` to invalidate all pages that list posts.
   *
   * @param tag - The tag to invalidate (e.g. `'posts'`, `'post:abc123'`).
   */
  revalidateTag(tag: string): Promise<void>;
}

/**
 * Create ISR invalidation utilities bound to a specific cache adapter.
 *
 * Published through `IsrInvalidatorsCap` during `createSsrPackage()` setup so
 * that server actions and route handlers can resolve it without importing from
 * a global singleton.
 *
 * @param cache - The ISR cache adapter to bind to.
 * @returns An {@link IsrInvalidators} object with `revalidatePath` and `revalidateTag`.
 */
export function createIsrInvalidators(cache: IsrCacheAdapter): IsrInvalidators {
  return {
    revalidatePath: (path: string) => cache.invalidatePath(path),
    revalidateTag: (tag: string) => cache.invalidateTag(tag),
  };
}
