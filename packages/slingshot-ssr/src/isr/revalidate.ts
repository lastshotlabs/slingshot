// packages/slingshot-ssr/src/isr/revalidate.ts
import type { IsrCacheAdapter } from './types';

/** Stable plugin-state key used by `slingshot-ssr` ISR invalidators. */
export const SSR_ISR_INVALIDATORS_STATE_KEY = 'slingshot-ssr:isr' as const;

/**
 * ISR invalidation utilities bound to a specific cache adapter instance.
 *
 * Created by `createIsrInvalidators()` and stored in `pluginState` under
 * `SSR_ISR_INVALIDATORS_STATE_KEY`. Server actions and route handlers retrieve
 * them via `bsCtx.pluginState.get(SSR_ISR_INVALIDATORS_STATE_KEY)`.
 */
export interface IsrInvalidators {
  /**
   * Invalidate the ISR cache entry for a specific URL pathname.
   *
   * The next request for this path will bypass the cache and trigger a fresh
   * render. The result is then cached again if `revalidate` is set.
   *
   * @param path - The URL pathname to invalidate (e.g. `'/posts/nba-finals'`).
   *
   * @example
   * ```ts
   * const { revalidatePath } = bsCtx.pluginState.get(SSR_ISR_INVALIDATORS_STATE_KEY);
   * await revalidatePath('/posts');
   * ```
   */
  revalidatePath(path: string): Promise<void>;

  /**
   * Invalidate all ISR cache entries tagged with the given tag.
   *
   * Use granular tags like `'post:abc123'` to invalidate a single item,
   * or broad tags like `'posts'` to invalidate all pages that list posts.
   *
   * @param tag - The tag to invalidate (e.g. `'posts'`, `'post:abc123'`).
   *
   * @example
   * ```ts
   * const { revalidateTag } = bsCtx.pluginState.get(SSR_ISR_INVALIDATORS_STATE_KEY);
   * await revalidateTag('posts');              // all listing pages
   * await revalidateTag(`post:${post.id}`);   // specific post page
   * ```
   */
  revalidateTag(tag: string): Promise<void>;
}

/**
 * Create ISR invalidation utilities bound to a specific cache adapter.
 *
 * The returned object is stored in `pluginState` during `createSsrPlugin()`
 * setup so that server actions and route handlers can retrieve it without
 * importing from a global singleton (Rule 3 — no module-level mutable state).
 *
 * @param cache - The ISR cache adapter to bind to.
 * @returns An {@link IsrInvalidators} object with `revalidatePath` and `revalidateTag`.
 *
 * @example
 * ```ts
 * // In plugin setup:
 * const invalidators = createIsrInvalidators(isrAdapter);
 * publishPluginState(getContext(app).pluginState, SSR_ISR_INVALIDATORS_STATE_KEY, invalidators);
 *
 * // In a server action or route handler:
 * const { revalidatePath, revalidateTag } = bsCtx.pluginState.get(SSR_ISR_INVALIDATORS_STATE_KEY);
 * await revalidatePath('/posts');
 * await revalidateTag('posts');
 * ```
 */
export function createIsrInvalidators(cache: IsrCacheAdapter): IsrInvalidators {
  return {
    revalidatePath: (path: string) => cache.invalidatePath(path),
    revalidateTag: (tag: string) => cache.invalidateTag(tag),
  };
}
