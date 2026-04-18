import type { Context as HonoContext } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

// packages/slingshot-ssr/src/draft/index.ts
// AsyncLocalStorage-based draft mode context for slingshot-ssr.
//
// Draft mode lets editors preview unpublished/draft content by bypassing the
// ISR (Incremental Static Regeneration) cache. A secure cookie is set by the
// draft enable endpoint; requests carrying that cookie skip the ISR cache and
// always perform a fresh render. Load functions can inspect `ctx.draftMode()`
// to fetch draft content from their CMS.
//
// Rule 3 note: The `AsyncLocalStorage` instance is module-level, but it is a
// request-scoped state container — all state lives inside the value passed to
// `draftContextStore.run()`, created fresh per request via `withDraftContext()`.
//
// Edge compatibility: `node:async_hooks` is not available in edge runtimes
// (e.g. Cloudflare Workers). The ALS instance is obtained lazily via `getAls()`
// so that bundlers can tree-shake the import when targeting edge builds. When
// ALS is unavailable, `withDraftContext` runs `fn()` directly and `draftMode()`
// returns a permanent `{ isEnabled: false }` no-op object, matching the
// behaviour declared by `supportsAsyncLocalStorage: false` in `runtime-edge`.

// ─── Lazy ALS loader ─────────────────────────────────────────────────────────

type AlsConstructor = typeof import('node:async_hooks').AsyncLocalStorage;

/**
 * Returns the `AsyncLocalStorage` constructor, or `null` when running in an
 * edge runtime that does not provide `node:async_hooks`.
 *
 * Resolution order:
 * 1. `globalThis.AsyncLocalStorage` — edge adapters may polyfill this.
 * 2. `require('node:async_hooks').AsyncLocalStorage` — Node / Bun.
 * 3. `null` — edge runtime with no polyfill; draft mode degrades gracefully.
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

// ─── Cookie name ──────────────────────────────────────────────────────────────

/**
 * The name of the HTTP cookie used to signal draft mode.
 *
 * The cookie is HttpOnly, Secure, SameSite=Lax, Path=/. Its presence (with any
 * non-empty value) indicates draft mode is active for the request.
 */
export const DRAFT_MODE_COOKIE = '__slingshot_draft__';

// ─── Status interface ─────────────────────────────────────────────────────────

/**
 * Read-only snapshot of draft mode status for the current request.
 *
 * Returned by `draftMode()` and exposed as `ctx.draftMode()` in load functions.
 */
export interface DraftModeStatus {
  /** `true` when the request carries a valid draft mode cookie. */
  readonly isEnabled: boolean;
}

// ─── Internal context type ────────────────────────────────────────────────────

/**
 * Per-request context object stored in `AsyncLocalStorage`.
 *
 * Holds a reference to the Hono `Context` so that `enable()` and `disable()`
 * can set/delete the response cookie without explicit argument passing.
 *
 * @internal
 */
interface DraftContext {
  /** The Hono request context for this render. */
  readonly honoCtx: HonoContext;
}

const AlsClass = getAls();
const draftContextStore: InstanceType<AlsConstructor> | null = AlsClass
  ? new AlsClass<DraftContext>()
  : null;

// ─── withDraftContext() ───────────────────────────────────────────────────────

/**
 * Wraps a request handler so that `draftMode()` is available within it.
 *
 * Called by the SSR middleware around every render invocation so that load
 * functions and route handlers can call `draftMode()` without receiving the
 * Hono context explicitly.
 *
 * All code executing within `fn()` — including transitively called functions
 * — has access to the draft context via the ambient `draftMode()` function.
 *
 * @param c - The Hono request context for this render.
 * @param fn - The function to execute within the draft context. May return a
 *   value or a promise.
 * @returns The return value of `fn`.
 */
export function withDraftContext<T>(c: HonoContext, fn: () => T | Promise<T>): Promise<T> {
  if (!draftContextStore) {
    // Edge runtime: ALS unavailable — run fn() without injecting draft context.
    // draftMode() will return the no-op fallback for this invocation.
    return Promise.resolve(fn());
  }
  const ctx: DraftContext = { honoCtx: c };
  return Promise.resolve(draftContextStore.run(ctx, fn));
}

// ─── isDraftRequest() ─────────────────────────────────────────────────────────

/**
 * Returns `true` when the incoming request carries the draft mode cookie.
 *
 * Used by the ISR middleware to decide whether to bypass the cache. Does not
 * require a draft context to be active — reads directly from the Hono context.
 *
 * @param c - The Hono request context to inspect.
 * @returns `true` if the request has a non-empty draft mode cookie.
 */
export function isDraftRequest(c: HonoContext): boolean {
  const value = getCookie(c, DRAFT_MODE_COOKIE);
  return typeof value === 'string' && value.length > 0;
}

// ─── draftMode() ─────────────────────────────────────────────────────────────

/** No-op draft mode returned in edge runtimes where ALS is unavailable. */
const EDGE_DRAFT_MODE_NOOP = Object.freeze({
  isEnabled: false as const,
  enable(): void {},
  disable(): void {},
});

/**
 * Access draft mode state for the current request.
 *
 * Returns an object with:
 * - `isEnabled` — whether the request carries the draft mode cookie
 * - `enable()` — sets the draft cookie on the response (HttpOnly, Secure, SameSite=Lax, Path=/)
 * - `disable()` — clears the draft cookie by expiring it in the past
 *
 * Must be called from within a `withDraftContext()` wrapper. Calling outside
 * of a draft context (e.g. from a non-SSR route) throws a descriptive error.
 * In edge runtimes where `AsyncLocalStorage` is unavailable, `draftMode()`
 * returns a permanent no-op (`isEnabled: false`) instead of throwing.
 *
 * @returns Draft mode accessors for the current request.
 *
 * @throws {Error} When called outside of a `withDraftContext()` wrapper (Node/Bun only).
 *
 * @example In a load function
 * ```ts
 * // server/routes/post/[slug].ts
 * export async function load(ctx: SsrLoadContext) {
 *   const { isEnabled } = ctx.draftMode();
 *   const post = isEnabled
 *     ? await cms.getDraftPost(ctx.params.slug)
 *     : await cms.getPublishedPost(ctx.params.slug);
 *   return { data: { post } };
 * }
 * ```
 *
 * @example From an API route handler (must use withDraftContext)
 * ```ts
 * import { draftMode } from '@lastshotlabs/slingshot-ssr/draft';
 *
 * app.get('/api/preview/enable', (c) =>
 *   withDraftContext(c, async () => {
 *     draftMode().enable();
 *     return c.redirect('/');
 *   }),
 * );
 * ```
 */

export function draftMode(): {
  isEnabled: boolean;
  enable: () => void;
  disable: () => void;
} {
  if (!draftContextStore) {
    // Edge runtime: ALS unavailable — draft mode is permanently disabled.
    return EDGE_DRAFT_MODE_NOOP;
  }

  const store = draftContextStore.getStore() as DraftContext | undefined;
  if (!store) {
    throw new Error(
      '[slingshot-ssr] draftMode() called outside of a draft context. ' +
        'Ensure it is called within a withDraftContext() wrapper ' +
        '(the SSR middleware wraps all renders automatically).',
    );
  }

  const { honoCtx } = store;

  return {
    get isEnabled() {
      return isDraftRequest(honoCtx);
    },

    enable() {
      setCookie(honoCtx, DRAFT_MODE_COOKIE, '1', {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
      });
    },

    disable() {
      deleteCookie(honoCtx, DRAFT_MODE_COOKIE, {
        path: '/',
      });
    },
  };
}
