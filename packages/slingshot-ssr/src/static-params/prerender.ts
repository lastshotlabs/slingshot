// packages/slingshot-ssr/src/static-params/prerender.ts
import type { StaticRoute } from './index';

// ─── Cache store ──────────────────────────────────────────────────────────────

/**
 * Factory function return type for the pre-rendered HTML store.
 *
 * Use `createPrerenderedCache()` to create an isolated store rather than sharing
 * a module-level map across instances (factory-over-singleton rule).
 */
export interface PrerenderedCache {
  /**
   * Retrieve the pre-rendered HTML for a URL path.
   *
   * @param path - The URL pathname (e.g. `/players/42`).
   * @returns The pre-rendered HTML string, or `undefined` on a miss.
   */
  get(path: string): string | undefined;
  /**
   * Store pre-rendered HTML for a URL path.
   *
   * @param path - The URL pathname (e.g. `/players/42`).
   * @param html - The full HTML string to cache.
   */
  set(path: string, html: string): void;
  /**
   * Snapshot of all cached paths and their HTML at the time of the call.
   * Useful for writing cache entries to disk after pre-rendering.
   */
  entries(): ReadonlyArray<Readonly<{ path: string; html: string }>>;
}

/**
 * Create a new, isolated in-memory pre-rendered HTML cache.
 *
 * Returns a `PrerenderedCache` factory. Each call produces an independent store —
 * there is no shared module-level singleton.
 *
 * @returns A fresh `PrerenderedCache` instance backed by a plain `Map`.
 *
 * @example
 * ```ts
 * const cache = createPrerenderedCache()
 * await prerenderStaticRoutes(manifest, renderer, cache)
 * const html = cache.get('/players/42')
 * ```
 */
export function createPrerenderedCache(): PrerenderedCache {
  const store = new Map<string, string>();

  return Object.freeze({
    get(path: string): string | undefined {
      return store.get(path);
    },
    set(path: string, html: string): void {
      store.set(path, html);
    },
    entries(): ReadonlyArray<Readonly<{ path: string; html: string }>> {
      return Array.from(store.entries()).map(([path, html]) => Object.freeze({ path, html }));
    },
  });
}

// ─── Path construction ────────────────────────────────────────────────────────

/**
 * Substitute dynamic route segment placeholders in a route pattern with the
 * concrete values from a `StaticParamSet`.
 *
 * Handles both standard dynamic segments (`[id]`) and catch-all segments
 * (`[...rest]`). Unknown segments are left as-is with a warning.
 *
 * @param routePath - The URL pattern, e.g. `/players/[id]` or `/blog/[...slug]`.
 * @param params - Concrete segment values, e.g. `{ id: '42' }`.
 * @returns The concrete URL path, e.g. `/players/42`.
 *
 * @example
 * ```ts
 * buildConcreteUrl('/players/[id]', { id: '42' }) // → '/players/42'
 * buildConcreteUrl('/blog/[...slug]', { slug: 'sports/nba' }) // → '/blog/sports/nba'
 * ```
 */
export function buildConcreteUrl(routePath: string, params: Record<string, string>): string {
  const paramLookup = params as Record<string, string | undefined>;
  return routePath
    .split('/')
    .map(segment => {
      // Catch-all: [...rest]
      const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(segment);
      if (catchAll) {
        const name = catchAll[1];
        const value = paramLookup[name];
        if (value === undefined) {
          console.warn(
            `[slingshot-ssr/prerender] Missing catch-all param "${name}" for route "${routePath}" — segment left as-is.`,
          );
          return segment;
        }
        return value;
      }

      // Dynamic: [param]
      const dynamic = /^\[([^\]]+)\]$/.exec(segment);
      if (dynamic) {
        const name = dynamic[1];
        const value = paramLookup[name];
        if (value === undefined) {
          console.warn(
            `[slingshot-ssr/prerender] Missing param "${name}" for route "${routePath}" — segment left as-is.`,
          );
          return segment;
        }
        return encodeURIComponent(value);
      }

      return segment;
    })
    .join('/');
}

// ─── Pre-rendering ────────────────────────────────────────────────────────────

/**
 * Pre-render all static routes defined in a `static-params.json` manifest by
 * calling the provided renderer for each concrete URL path.
 *
 * For each `StaticRoute` in `manifest`, every param set is expanded to a
 * concrete path via `buildConcreteUrl()` and passed to `renderer`. The returned
 * HTML is stored in `cache`. Rendering errors are caught and logged as warnings
 * so a single failed route does not abort the whole pre-render pass.
 *
 * @param manifest - The array of static routes from `scanStaticParams()` or
 *   `static-params.json`.
 * @param renderer - An async function that accepts a URL path and returns the
 *   full HTML string for that page. Typically wraps the SSR renderer.
 * @param cache - A `PrerenderedCache` instance to write results into. Create one
 *   with `createPrerenderedCache()`.
 *
 * @example
 * ```ts
 * import { scanStaticParams } from '@lastshotlabs/slingshot-ssr/static-params'
 * import { prerenderStaticRoutes, createPrerenderedCache } from '@lastshotlabs/slingshot-ssr/static-params/prerender'
 *
 * const manifest = await scanStaticParams(serverRoutesDir)
 * const cache = createPrerenderedCache()
 * await prerenderStaticRoutes(manifest, async (path) => {
 *   const res = await renderer.render(await resolver.resolve(new URL(path, origin)), shell, bsCtx)
 *   return await res.text()
 * }, cache)
 * ```
 */
export async function prerenderStaticRoutes(
  manifest: readonly StaticRoute[],
  renderer: (path: string) => Promise<string>,
  cache: PrerenderedCache,
): Promise<void> {
  for (const route of manifest) {
    for (const paramSet of route.paramSets) {
      const path = buildConcreteUrl(route.routePath, paramSet);

      try {
        const html = await renderer(path);
        cache.set(path, html);
      } catch (err) {
        console.warn(
          `[slingshot-ssr/prerender] Failed to pre-render "${path}" (route: ${route.routePath}) — skipping.`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

/**
 * Retrieve the pre-rendered HTML for a URL path from the given cache.
 *
 * Returns `undefined` when the path was not pre-rendered (dynamic render
 * will be used instead).
 *
 * This is a convenience wrapper so call sites do not need to hold a direct
 * reference to the `PrerenderedCache` instance.
 *
 * @param cache - The cache populated by `prerenderStaticRoutes()`.
 * @param path - The URL pathname to look up (e.g. `/players/42`).
 * @returns The pre-rendered HTML string, or `undefined` on a miss.
 *
 * @example
 * ```ts
 * const html = getPrerenderedHtml(cache, req.url.pathname)
 * if (html) return new Response(html, { headers: { 'Content-Type': 'text/html' } })
 * // fall through to dynamic render…
 * ```
 */
export function getPrerenderedHtml(cache: PrerenderedCache, path: string): string | undefined {
  return cache.get(path);
}
