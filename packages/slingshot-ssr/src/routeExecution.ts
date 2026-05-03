// packages/slingshot-ssr/src/routeExecution.ts
import type {
  DefineRouteOptions,
  SsrLoadContext,
  SsrLoadResult,
  SsrMeta,
  SsrRouteMatch,
} from './types';

/**
 * The shape of a route module produced by `defineRoute()` and exported via
 * the named-export pattern shown in the `defineRoute` JSDoc.
 *
 * @typeParam TData - Shape of the data returned by `load()`.
 */
interface RouteModuleExports<TData extends Record<string, unknown>> {
  load: DefineRouteOptions<TData>['load'];
  meta?: DefineRouteOptions<TData>['meta'];
  default: DefineRouteOptions<TData>['Page'];
}

/**
 * Result of executing a file-based route module's loader and meta.
 *
 * @typeParam TData - Shape of the data returned by `load()`.
 */
export interface RouteExecution<TData extends Record<string, unknown>> {
  /** The full result returned by the route's `load()` — may carry a redirect/notFound signal. */
  readonly loaderResult: SsrLoadResult<TData>;
  /** The result of calling `meta(ctx, loaderResult)`, or `{}` when no `meta` is exported. */
  readonly meta: SsrMeta;
  /**
   * The route's default-exported page component, ready to invoke with
   * `{ loaderData, params, query }`. Caller decides how to render it
   * (renderToString, RSC, Solid, etc.).
   */
  readonly Page: DefineRouteOptions<TData>['Page'];
}

const moduleCache = new Map<string, Promise<RouteModuleExports<Record<string, unknown>>>>();

/**
 * Dynamically import a file-based route module, with module-level caching.
 *
 * Test code can clear the cache between cases via `clearRouteModuleCache()`.
 * Production callers should not need to clear the cache — module identity is
 * keyed by absolute file path, which is stable for the lifetime of the build.
 *
 * @param filePath - Absolute path to the route module (`match.filePath`).
 */
export function loadRouteModule<TData extends Record<string, unknown>>(
  filePath: string,
): Promise<RouteModuleExports<TData>> {
  let cached = moduleCache.get(filePath);
  if (!cached) {
    cached = import(filePath) as Promise<RouteModuleExports<Record<string, unknown>>>;
    moduleCache.set(filePath, cached);
  }
  return cached as Promise<RouteModuleExports<TData>>;
}

/**
 * Clear the route-module import cache. Intended for tests and dev-mode
 * watchers that need to pick up a freshly-edited route file.
 */
export function clearRouteModuleCache(): void {
  moduleCache.clear();
}

/**
 * Execute a file-based route module's `load()` and (if present) `meta()`,
 * returning the loader result, the meta object, and the page component.
 *
 * This is the canonical helper for `SlingshotSsrRenderer` implementations.
 * Without it, every renderer has to hand-roll the dynamic-import + load +
 * meta dance and risks subtle drift across consumers (request-time renderer,
 * SSG renderer, test renderers).
 *
 * The helper does not invoke the page component — it only returns it. The
 * renderer decides whether to call `renderToString` (React), `renderToReadableStream`
 * (RSC), or any other output strategy.
 *
 * Loader signals (`{ redirect: ... }`, `{ notFound: true }`, etc.) are passed
 * through on `loaderResult` unchanged. Callers should check via the
 * `isRedirect` / `isNotFound` / etc. helpers before rendering.
 *
 * @param match - The resolved route match (typically `chain.page` from `resolveRouteChain`).
 * @param ctx   - The load context — provide `params`, `query`, `url`, `headers`,
 *                `getUser`, `bsCtx`, `draftMode`, etc. consistent with the runtime.
 * @returns A `RouteExecution<TData>` bundle with `loaderResult`, `meta`, and `Page`.
 *
 * @example
 * ```ts
 * const renderer: SlingshotSsrRenderer = {
 *   async renderChain(chain, shell, bsCtx) {
 *     const ctx = buildLoadContext(chain.page, bsCtx);
 *     const exec = await executeRouteModule(chain.page, ctx);
 *     if (isRedirect(exec.loaderResult)) {
 *       return Response.redirect(exec.loaderResult.redirect, 302);
 *     }
 *     const element = exec.Page({
 *       loaderData: exec.loaderResult.data,
 *       params: chain.page.params,
 *       query: chain.page.query,
 *     });
 *     return new Response(renderToString(element), { ... });
 *   },
 * };
 * ```
 */
export async function executeRouteModule<TData extends Record<string, unknown>>(
  match: SsrRouteMatch,
  ctx: SsrLoadContext,
): Promise<RouteExecution<TData>> {
  const mod = await loadRouteModule<TData>(match.filePath);
  const loaderResult = await mod.load(ctx);
  const meta = mod.meta ? await mod.meta(ctx, loaderResult) : {};
  return {
    loaderResult,
    meta,
    Page: mod.default,
  };
}
