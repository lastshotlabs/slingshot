// packages/slingshot-ssr/src/actions/context.ts
// AsyncLocalStorage-based context for server actions.
//
// Provides `revalidatePath` and `revalidateTag` as ambient functions that server
// actions can call without receiving `bsCtx` as an explicit argument. The
// `/_snapshot/action` handler wraps each action call in `withActionContext()`,
// injecting concrete implementations backed by the ISR cache adapter.
//
// Rule 3 note: The `AsyncLocalStorage` instance is module-level, but it is a
// request-scoped state container — all state lives inside the value passed to
// `actionContextStore.run()`, created fresh per action invocation.
//
// NOTE: Export from packages/slingshot-ssr/src/actions/index.ts:
// export { withActionContext, revalidatePath, revalidateTag } from './context';
// Phase 20 creates index.ts; these exports should be added there.
//
// Edge compatibility: `node:async_hooks` is not available in edge runtimes
// (e.g. Cloudflare Workers). The ALS instance is obtained lazily via `getAls()`
// so that bundlers can tree-shake the import when targeting edge builds. When
// ALS is unavailable, `withActionContext` runs `fn()` directly (no context
// injection) and `revalidatePath`/`revalidateTag` become silent no-ops with a
// console warning, matching the behaviour declared by `supportsAsyncLocalStorage:
// false` in `runtime-edge`.

// ─── Lazy ALS loader ─────────────────────────────────────────────────────────

type AlsConstructor = typeof import('node:async_hooks').AsyncLocalStorage;

/**
 * Returns the `AsyncLocalStorage` constructor, or `null` when running in an
 * edge runtime that does not provide `node:async_hooks`.
 *
 * Resolution order:
 * 1. `globalThis.AsyncLocalStorage` — edge adapters may polyfill this.
 * 2. `require('node:async_hooks').AsyncLocalStorage` — Node / Bun.
 * 3. `null` — edge runtime with no polyfill; ALS features degrade gracefully.
 */
const getAls = (): AlsConstructor | null => {
  if (typeof (globalThis as Record<string, unknown>).AsyncLocalStorage !== 'undefined') {
    return (globalThis as Record<string, unknown>).AsyncLocalStorage as AlsConstructor;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:async_hooks') as typeof import('node:async_hooks')).AsyncLocalStorage;
  } catch {
    return null;
  }
};

// ─── Context interface ────────────────────────────────────────────────────────

/**
 * The per-action context injected by the action handler.
 *
 * Contains concrete implementations of `revalidatePath` and `revalidateTag`
 * backed by the ISR cache adapter for this slingshot-ssr instance. Server actions
 * access these via the ambient module-level functions, not via this interface
 * directly.
 */
interface ActionContext {
  /**
   * Invalidate the ISR cache entry for a specific URL path.
   *
   * @param path - The URL pathname to invalidate (e.g. `'/posts/nba-finals'`).
   */
  revalidatePath: (path: string) => Promise<void>;
  /**
   * Invalidate all ISR cache entries tagged with the given tag.
   *
   * @param tag - The tag to invalidate (e.g. `'posts'`, `'post:abc123'`).
   */
  revalidateTag: (tag: string) => Promise<void>;
}

const AlsClass = getAls();
const actionContextStore: InstanceType<AlsConstructor> | null = AlsClass
  ? new AlsClass<ActionContext>()
  : null;

// ─── Internal: withActionContext() ───────────────────────────────────────────

/**
 * Wraps a server action invocation with ISR invalidation context.
 *
 * Called by the `/_snapshot/action` request handler before executing each
 * action. The `ctx` object provides concrete `revalidatePath`/`revalidateTag`
 * implementations backed by the ISR cache adapter for this slingshot-ssr instance.
 *
 * All code executing within `fn()` — including transitively called functions
 * — has access to the action context via `revalidatePath()` and `revalidateTag()`.
 *
 * @param ctx - The ISR invalidation implementations for this action invocation.
 * @param fn - The async function to execute within the action context.
 * @returns The return value of `fn`.
 *
 * @internal
 */
export function withActionContext<T>(ctx: ActionContext, fn: () => Promise<T>): Promise<T> {
  if (!actionContextStore) {
    // Edge runtime: ALS unavailable — run fn() without injecting context.
    // revalidatePath/revalidateTag will be no-ops for this invocation.
    return fn();
  }
  return actionContextStore.run(ctx, fn);
}

// ─── Public: revalidatePath() ────────────────────────────────────────────────

/**
 * Invalidate the ISR cache entry for a specific URL path.
 *
 * The next request to that URL bypasses the ISR cache and triggers a fresh
 * render, which is then re-cached if `revalidate` is set.
 *
 * Must be called inside a server action that is executing within a
 * `withActionContext()` wrapper (set up by the `/_snapshot/action` handler).
 * Calling this outside a server action context throws an error.
 *
 * @param path - The URL pathname to invalidate (e.g. `'/posts'`, `'/posts/nba-finals'`).
 * @returns A Promise that resolves when the cache entry has been removed.
 *
 * @throws {Error} When called outside of a server action context.
 *
 * @example
 * ```ts
 * 'use server';
 * import { revalidatePath } from '@lastshotlabs/slingshot-ssr/isr';
 *
 * export async function deletePost(id: string) {
 *   await db.posts.delete(id);
 *   await revalidatePath('/posts');
 *   await revalidatePath(`/posts/${id}`);
 * }
 * ```
 */
export function revalidatePath(path: string): Promise<void> {
  if (!actionContextStore) {
    // Edge runtime: ALS unavailable — revalidation is a no-op.
    console.warn(
      '[slingshot-ssr] revalidatePath unavailable in edge runtime (AsyncLocalStorage not supported). ' +
        'Use tag-based ISR invalidation via the KV adapter instead.',
    );
    return Promise.resolve();
  }
  const store = actionContextStore.getStore() as ActionContext | undefined;
  if (!store) {
    return Promise.reject(
      new Error(
        '[slingshot-ssr] revalidatePath() called outside of a server action context. ' +
          'Ensure it is called inside a function wrapped by the /_snapshot/action handler.',
      ),
    );
  }
  return store.revalidatePath(path);
}

// ─── Public: revalidateTag() ─────────────────────────────────────────────────

/**
 * Invalidate all ISR cache entries tagged with the given tag.
 *
 * Any page whose `load()` function returned `tags: ['your-tag']` will be
 * evicted from the ISR cache. The next request to each affected path triggers
 * a fresh render.
 *
 * Must be called inside a server action that is executing within a
 * `withActionContext()` wrapper (set up by the `/_snapshot/action` handler).
 * Calling this outside a server action context throws an error.
 *
 * @param tag - The tag to invalidate (e.g. `'posts'`, `'post:abc123'`).
 * @returns A Promise that resolves when all entries with the tag have been removed.
 *
 * @throws {Error} When called outside of a server action context.
 *
 * @example
 * ```ts
 * 'use server';
 * import { revalidateTag } from '@lastshotlabs/slingshot-ssr/isr';
 *
 * export async function createPost(formData: FormData) {
 *   const post = await db.posts.create({ title: formData.get('title') });
 *   await revalidateTag('posts');            // invalidate all listing pages
 *   await revalidateTag(`post:${post.id}`); // invalidate any pre-rendered detail page
 *   return post;
 * }
 * ```
 */
export function revalidateTag(tag: string): Promise<void> {
  if (!actionContextStore) {
    // Edge runtime: ALS unavailable — revalidation is a no-op.
    console.warn(
      '[slingshot-ssr] revalidateTag unavailable in edge runtime (AsyncLocalStorage not supported). ' +
        'Use tag-based ISR invalidation via the KV adapter instead.',
    );
    return Promise.resolve();
  }
  const store = actionContextStore.getStore() as ActionContext | undefined;
  if (!store) {
    return Promise.reject(
      new Error(
        '[slingshot-ssr] revalidateTag() called outside of a server action context. ' +
          'Ensure it is called inside a function wrapped by the /_snapshot/action handler.',
      ),
    );
  }
  return store.revalidateTag(tag);
}
