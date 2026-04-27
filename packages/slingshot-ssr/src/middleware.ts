// packages/slingshot-ssr/src/middleware.ts
import path from 'node:path';
import type { MiddlewareHandler } from 'hono';
import { getContext } from '@lastshotlabs/slingshot-core';
import { buildAfterFn, drainAfterCallbacks, withAfterContext } from './after/index';
import type { ViteManifest } from './assets';
import { buildDevAssetTags, resolveAssetTags } from './assets';
import { buildDevErrorOverlay } from './dev/overlay';
import { isDraftRequest, withDraftContext } from './draft/index';
import type { IsrCacheAdapter } from './isr/types';
import { resolveGlobalMiddlewarePath, resolveRouteChain } from './resolver';
import type {
  IsrSink,
  SsrCacheControl,
  SsrMiddlewareContext,
  SsrMiddlewareResult,
  SsrPluginConfig,
  SsrRouteChain,
  SsrShell,
} from './types';

/** URL prefixes always excluded from SSR — cannot be overridden by config. */
const ALWAYS_EXCLUDE = ['/api/', '/_slingshot/'];

function hasRedirectResult(
  result: SsrMiddlewareResult,
): result is Extract<SsrMiddlewareResult, { readonly redirect: string }> {
  return 'redirect' in result;
}

function hasRewriteResult(
  result: SsrMiddlewareResult,
): result is Extract<SsrMiddlewareResult, { readonly rewrite: string }> {
  return 'rewrite' in result;
}

function hasHeadersResult(
  result: SsrMiddlewareResult,
): result is Extract<SsrMiddlewareResult, { readonly headers: Record<string, string> }> {
  return 'headers' in result;
}

/**
 * Read a file as a UTF-8 string using the configured runtime or falling back
 * to Node.js `node:fs/promises`.
 *
 * When `config.runtime` is set, delegates to `config.runtime.readFile()` so
 * that edge runtimes (which have no filesystem access) can read from their
 * bundled asset store instead. On Bun/Node.js, falls back to `node:fs/promises`
 * when no runtime override is present.
 *
 * Returns `null` if the file does not exist.
 *
 * @internal
 */
async function readFileViaRuntime(
  filePath: string,
  config: Readonly<SsrPluginConfig>,
): Promise<string | null> {
  if (config.runtime) {
    return config.runtime.readFile(filePath);
  }
  // Fallback: Node.js fs (works on both Bun and Node when no runtime is provided).
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Build the Hono middleware handler for SSR request interception.
 *
 * Called once at plugin startup from `createSsrPlugin()`. Returns the handler;
 * the caller registers it with `app.use('*', handler)`.
 *
 * The `app` parameter is the Hono instance — closed over so the middleware can
 * call `getContext(app)` to retrieve the `SlingshotContext` at request time
 * (Rule 18: context is instance-scoped, accessed via `getContext(app)`).
 *
 * When `config.isr` is set, the middleware implements stale-while-revalidate:
 * cached responses are served immediately; stale entries trigger a background
 * regeneration that never blocks the current response.
 *
 * @param config - Frozen plugin config.
 * @param manifest - Parsed Vite manifest. `null` in dev mode.
 * @param app - The Hono app instance. Used for `getContext(app)`.
 * @param isrAdapter - The shared ISR cache adapter created by the plugin, or
 *   `null` when ISR is disabled. **Must** be the same instance passed to the
 *   action router so that `revalidatePath`/`revalidateTag` invalidate the cache
 *   that this middleware reads from (Bug 1 fix — single shared instance).
 * @internal
 */
export function buildSsrMiddleware(
  config: Readonly<SsrPluginConfig>,
  manifest: ViteManifest | null,
  app: object,
  isrAdapter: IsrCacheAdapter | null = null,
): MiddlewareHandler {
  const entryPoint = config.entryPoint ?? 'index.html';
  const isDevMode = config.devMode ?? process.env.NODE_ENV === 'development';

  const assetTags = isDevMode
    ? buildDevAssetTags()
    : manifest
      ? resolveAssetTags(manifest, entryPoint)
      : '';

  // isrAdapter is injected by the plugin (shared with the action router).
  // Do not create a second instance here — that would break invalidation.

  return async (c, next) => {
    // Only intercept GET and HEAD requests
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();

    // Skip WebSocket upgrade requests
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') return next();

    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // Always-excluded prefixes
    for (const prefix of ALWAYS_EXCLUDE) {
      if (pathname.startsWith(prefix)) return next();
    }

    // User-configured exclusions
    if (config.exclude) {
      for (const prefix of config.exclude) {
        if (pathname.startsWith(prefix)) return next();
      }
    }

    // Static file short-circuit — serve pre-rendered .html before hitting the renderer.
    // This is the SSG serving path: zero renderer overhead for pre-built pages.
    if (config.staticDir) {
      const staticFile =
        pathname === '/'
          ? path.join(config.staticDir, 'index.html')
          : path.join(config.staticDir, pathname, 'index.html');
      const html = await readFileViaRuntime(staticFile, config);
      if (html !== null) {
        return c.html(html, 200, {
          'cache-control': 'public, max-age=31536000, immutable',
        });
      }
    }

    // Build query params — shared between both resolution paths
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });

    // Get slingshot context from the closed-over app instance (Rule 18).
    // If the app has no context attached (e.g. in tests without bootstrap),
    // getContext throws — treat as non-SSR and fall through.
    // ── ISR: stale-while-revalidate cache check ────────────────────────────
    // Only run on GET (not HEAD) to avoid caching partial responses.
    // Draft mode requests always bypass the ISR cache to ensure editors see
    // the freshest content without stale-while-revalidate serving old HTML.
    //
    // Bug fix (Bug 2): key on full URL (pathname + search) so that query-parameterised
    // routes like /posts?page=1 and /posts?page=2 are cached separately. Declared
    // outside the if-block so the write path below can reuse the same key.
    const cacheKey = url.pathname + url.search;
    if (isrAdapter !== null && c.req.method === 'GET' && !isDraftRequest(c)) {
      const cached = await isrAdapter.get(cacheKey);
      if (cached !== null) {
        const isStale = Date.now() > cached.revalidateAfter;

        if (isStale) {
          // Serve the stale cached response immediately, then regenerate in background.
          // The background regeneration is a fire-and-forget microtask — it never
          // blocks or delays the current response (spec: SWR behavior).
          // A 30-second timeout guards against hung renderers blocking worker resources.
          try {
            const staleBsCtx = getContext(app);
            const isrTimeout = AbortSignal.timeout(config.isr?.backgroundRegenTimeoutMs ?? 30_000);
            Promise.race([
              regeneratePage(cacheKey, url, query, config, assetTags, staleBsCtx, isrAdapter),
              new Promise<never>((_, reject) => {
                isrTimeout.addEventListener('abort', () => {
                  reject(
                    new Error(
                      `[slingshot-ssr] ISR background regen timed out after ${config.isr?.backgroundRegenTimeoutMs ?? 30_000}ms`,
                    ),
                  );
                });
              }),
            ]).catch((err: unknown) => {
              console.error('[slingshot-ssr] ISR background regen failed for', cacheKey, err);
            });
          } catch {
            // No Slingshot context attached — serve stale content but skip background regeneration.
          }
        }

        // Serve from cache regardless of staleness, replaying the original status code.
        return new Response(cached.html, {
          status: cached.status ?? 200,
          headers: {
            ...cached.headers,
            'x-isr-cache': isStale ? 'stale' : 'hit',
          },
        });
      }
    }
    // ── End ISR cache check ────────────────────────────────────────────────

    let bsCtx;
    try {
      bsCtx = getContext(app);
    } catch {
      return next();
    }

    // Extract X-Snapshot-Navigate header for interception route resolution (Phase 27)
    const fromPath = c.req.header('x-snapshot-navigate') ?? undefined;

    let extraResponseHeaders: Record<string, string> = {};

    // 1. File-based chain resolver — resolves layouts, slots, interception, middleware
    // 2. Renderer's own resolve() — for manifest/config-driven routing (no chain support)
    //    Called when the file resolver has no match. Returns null to fall through to SPA.
    let chain: SsrRouteChain | null = resolveRouteChain(pathname, config.serverRoutesDir, fromPath);

    // Hydrate query and url on the page match when chain was found
    if (chain) {
      const hydratedPage = { ...chain.page, url, query };
      const hydratedLayouts = chain.layouts.map(l => ({ ...l, url, query }));
      chain = Object.freeze({
        ...chain,
        page: hydratedPage,
        layouts: Object.freeze(hydratedLayouts),
      });
    }

    // Fall through to renderer.resolve() when no file-based match found
    if (!chain) {
      try {
        const rendererMatch = await config.renderer.resolve(url, bsCtx);
        if (rendererMatch) {
          const hydratedMatch = { ...rendererMatch, url, query };
          chain = Object.freeze({
            layouts: Object.freeze([]),
            page: hydratedMatch,
            slots: undefined,
            intercepted: undefined,
            middlewareFilePath: null,
          });
        }
      } catch (err) {
        console.error('[slingshot-ssr] renderer.resolve() error for', pathname, err);
      }
    }

    // ── Global middleware execution for unmatched routes (Phase 29) ──────────
    // When no page route matched, check for a global server/middleware.ts and
    // run it. This allows the middleware to redirect or rewrite requests that
    // have no file-based page — e.g. auth guards that redirect to /login, or
    // locale rewrites. Without this, middleware only runs for matched routes.
    if (!chain && config.serverRoutesDir) {
      const globalMiddlewarePath = resolveGlobalMiddlewarePath(config.serverRoutesDir);
      if (globalMiddlewarePath) {
        try {
          const mod = (await import(globalMiddlewarePath)) as Record<string, unknown>;
          const middlewareFn =
            (mod['middleware'] as
              | ((ctx: SsrMiddlewareContext) => Promise<SsrMiddlewareResult>)
              | undefined) ??
            (mod['default'] as
              | ((ctx: SsrMiddlewareContext) => Promise<SsrMiddlewareResult>)
              | undefined);

          if (typeof middlewareFn === 'function') {
            const middlewareCtx: SsrMiddlewareContext = {
              pathname,
              url,
              headers: c.req.raw.headers,
              params: {},
              getUser: () => {
                const ctx = bsCtx as {
                  auth?: {
                    getUser: (c: unknown) => Promise<{ id: string; roles: string[] } | null>;
                  };
                };
                if (ctx.auth?.getUser) return ctx.auth.getUser(c);
                return Promise.resolve(null);
              },
              bsCtx,
            };
            const middlewareResult: SsrMiddlewareResult = await middlewareFn(middlewareCtx);

            if (hasRedirectResult(middlewareResult)) {
              return c.redirect(middlewareResult.redirect, middlewareResult.status ?? 302);
            }

            if (hasHeadersResult(middlewareResult)) {
              extraResponseHeaders = {
                ...extraResponseHeaders,
                ...middlewareResult.headers,
              };
            }

            if (hasRewriteResult(middlewareResult)) {
              const rewriteUrl = new URL(middlewareResult.rewrite, url.origin);
              const rewriteChain = resolveRouteChain(
                rewriteUrl.pathname,
                config.serverRoutesDir,
                fromPath,
              );
              if (rewriteChain) {
                const rewriteQuery: Record<string, string> = {};
                rewriteUrl.searchParams.forEach((v, k) => {
                  rewriteQuery[k] = v;
                });
                const hydratedPage = { ...rewriteChain.page, url: rewriteUrl, query: rewriteQuery };
                const hydratedLayouts = rewriteChain.layouts.map(l => ({
                  ...l,
                  url: rewriteUrl,
                  query: rewriteQuery,
                }));
                chain = Object.freeze({
                  ...rewriteChain,
                  page: hydratedPage,
                  layouts: Object.freeze(hydratedLayouts),
                });
              }
            }
          }
        } catch (err) {
          console.error('[slingshot-ssr] global middleware error for', pathname, err);
        }
      }
    }
    // ── End global middleware for unmatched routes ────────────────────────────

    if (!chain) return next();
    const resolvedChain = chain;

    // ── SSR Middleware execution (Phase 29) ────────────────────────────────────
    // Execute server/middleware.ts before the renderer when present.
    if (chain.middlewareFilePath) {
      try {
        const middlewareModule = (await import(chain.middlewareFilePath)) as Record<
          string,
          unknown
        >;
        const middlewareFn =
          (middlewareModule['middleware'] as
            | ((ctx: SsrMiddlewareContext) => Promise<SsrMiddlewareResult>)
            | undefined) ??
          (middlewareModule['default'] as
            | ((ctx: SsrMiddlewareContext) => Promise<SsrMiddlewareResult>)
            | undefined);

        if (typeof middlewareFn === 'function') {
          const middlewareCtx: SsrMiddlewareContext = {
            pathname,
            url,
            headers: c.req.raw.headers,
            params: chain.page.params,
            getUser: () => {
              const ctx = bsCtx as {
                pluginState?: Map<string, unknown>;
                auth?: { getUser: (c: unknown) => Promise<{ id: string; roles: string[] } | null> };
              };
              if (ctx.auth?.getUser) return ctx.auth.getUser(c);
              return Promise.resolve(null);
            },
            bsCtx,
          };
          const middlewareResult: SsrMiddlewareResult = await middlewareFn(middlewareCtx);

          if (hasRedirectResult(middlewareResult)) {
            return c.redirect(middlewareResult.redirect, middlewareResult.status ?? 302);
          }

          if (hasRewriteResult(middlewareResult)) {
            // Re-resolve with the rewritten path.
            // Bug fix: build a new URL from the rewrite target so that loaders
            // see the rewritten pathname and query string, not the original
            // request URL. Using the original `url` here caused loaders to
            // receive the pre-rewrite path even after the chain was swapped.
            const rewriteUrl = new URL(middlewareResult.rewrite, url.origin);
            const rewriteChain = resolveRouteChain(
              rewriteUrl.pathname,
              config.serverRoutesDir,
              fromPath,
            );
            if (rewriteChain) {
              const rewriteQuery: Record<string, string> = {};
              rewriteUrl.searchParams.forEach((v, k) => {
                rewriteQuery[k] = v;
              });
              const hydratedPage = { ...rewriteChain.page, url: rewriteUrl, query: rewriteQuery };
              const hydratedLayouts = rewriteChain.layouts.map(l => ({
                ...l,
                url: rewriteUrl,
                query: rewriteQuery,
              }));
              chain = Object.freeze({
                ...rewriteChain,
                page: hydratedPage,
                layouts: Object.freeze(hydratedLayouts),
              });
            }
          }

          if (hasHeadersResult(middlewareResult)) {
            extraResponseHeaders = {
              ...extraResponseHeaders,
              ...middlewareResult.headers,
            };
          }
        }
      } catch (err) {
        console.error('[slingshot-ssr] middleware execution error for', pathname, err);
        // Non-fatal: continue with render
      }
    }
    // ── End middleware execution ───────────────────────────────────────────────

    // Create the ISR sink — a mutable object the renderer populates after calling load().
    // The middleware reads revalidate/tags from it after render() returns.
    const isrSink: IsrSink = {};

    // Capture draft mode status for this request once — used for both the shell
    // flag (forwarded to load contexts) and the post-render ISR cache write skip.
    const draftMode = isDraftRequest(c);

    // Renderer fills headTags after calling meta() — we provide the container.
    // _draftMode is forwarded to the renderer so it can pass the flag into
    // every load context without requiring a cross-package import.
    const afterFn = buildAfterFn();
    const shell: SsrShell = {
      headTags: '',
      assetTags,
      nonce: undefined, // CSP nonce: future extension point
      _isr: isrSink,
      _draftMode: draftMode,
      _after: afterFn,
    };

    let response: Response;
    try {
      // Wrap the render with withDraftContext so that any load function calling
      // draftMode() via AsyncLocalStorage gets the correct Hono context.
      // Wrap with withAfterContext so that after() callbacks registered inside
      // load() are captured in the per-request queue and drained post-flush.
      //
      // Bug fix (Bug 3): always use renderChain() regardless of layout count.
      // Falling back to render() when layouts.length === 0 drops slot and
      // intercepted-route metadata that was resolved earlier in the chain.
      // renderChain() handles an empty layouts array correctly and preserves
      // the full chain (slots, intercepted) in all cases.
      response = await withDraftContext(c, () =>
        withAfterContext(() => config.renderer.renderChain(resolvedChain, shell, bsCtx)),
      );
    } catch (err) {
      // Dev mode: return styled error overlay instead of silently falling through
      if (isDevMode) {
        const overlay = buildDevErrorOverlay(err as Error, {
          url: url.pathname,
          params: resolvedChain.page.params,
          loaderFile: resolvedChain.page.filePath,
        });
        return c.html(overlay, 500);
      }
      // SSR is an enhancement — fall through to SPA on error (spec: error strategy)
      console.error('[slingshot-ssr] Render error for', pathname, err);
      return next();
    }

    // Apply extra headers from middleware result (Phase 29)
    if (Object.keys(extraResponseHeaders).length > 0) {
      const newHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(extraResponseHeaders)) {
        newHeaders.set(key, value);
      }
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // ── ISR: cache the rendered response ──────────────────────────────────
    // The renderer populates isrSink.revalidate (and optionally isrSink.tags)
    // after calling load(). Only cache when revalidate is a positive number AND
    // the loader did not call unstable_noStore() (isrSink.noStore === true).
    // Draft mode responses are never cached — draft content must always be fresh.
    if (
      isrAdapter !== null &&
      typeof isrSink.revalidate === 'number' &&
      isrSink.revalidate > 0 &&
      !isrSink.noStore &&
      !draftMode
    ) {
      // Read the response body so we can store the HTML and still return a response.
      // We clone the response first because body can only be consumed once.
      const cloned = response.clone();
      const html = await cloned.text();

      // Capture headers as a plain object for storage.
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const now = Date.now();
      const entry = {
        html,
        // Store the original render status so it is replayed on cache hit.
        status: response.status,
        headers,
        generatedAt: now,
        revalidateAfter: now + isrSink.revalidate * 1000,
        tags: isrSink.tags ?? [],
      };

      // Fire-and-forget — never await cache writes on the hot path.
      // Use the full URL key (pathname + search) to match the cache read above.
      isrAdapter.set(cacheKey, entry).catch((err: unknown) => {
        console.error('[slingshot-ssr] ISR cache.set() failed for', cacheKey, err);
      });
    }
    // ── End ISR cache write ────────────────────────────────────────────────

    // Apply cache-control header (do not overwrite if renderer already set one)
    const cacheControl = resolveCacheControl(config.cacheControl, pathname);
    if (cacheControl && !response.headers.has('Cache-Control')) {
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Cache-Control', cacheControl);
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // Drain after-callbacks when the response body stream flushes.
    // Uses a TransformStream so callbacks run after the last byte is sent,
    // not before — analytics and audit logs need the response to be committed.
    if (response.body) {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
        flush() {
          return drainAfterCallbacks();
        },
      });
      response.body.pipeTo(writable).catch((err: unknown) => {
        console.error('[ssr] response stream error:', err);
      });
      response = new Response(readable, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return response;
  };
}

/**
 * Regenerate a page in the background for ISR stale-while-revalidate.
 *
 * Resolves the route, renders it fresh, and writes the new entry to the ISR
 * cache adapter. Called from a fire-and-forget microtask — errors are logged
 * but never propagate to the original request.
 *
 * @param cacheKey - The full cache key used for both read and write, including
 *   any query string (e.g. `/posts?page=2`). Used as the adapter key.
 * @param url - The full request URL. The pathname is extracted for route resolution.
 * @internal
 */
async function regeneratePage(
  cacheKey: string,
  url: URL,
  query: Record<string, string>,
  config: Readonly<SsrPluginConfig>,
  assetTags: string,
  bsCtx: ReturnType<typeof getContext>,
  isrAdapter: IsrCacheAdapter,
): Promise<void> {
  const pathname = url.pathname;
  let chain = resolveRouteChain(pathname, config.serverRoutesDir);

  if (chain) {
    const hydratedPage = { ...chain.page, url, query };
    const hydratedLayouts = chain.layouts.map(l => ({ ...l, url, query }));
    chain = Object.freeze({
      ...chain,
      page: hydratedPage,
      layouts: Object.freeze(hydratedLayouts),
    });
  }

  if (!chain) {
    try {
      const rendererMatch = await config.renderer.resolve(url, bsCtx);
      if (rendererMatch) {
        const hydratedMatch = { ...rendererMatch, url, query };
        chain = Object.freeze({
          layouts: Object.freeze([]),
          page: hydratedMatch,
          slots: undefined,
          intercepted: undefined,
          middlewareFilePath: null,
        });
      }
    } catch (err) {
      console.error('[slingshot-ssr] ISR regen renderer.resolve() error for', pathname, err);
      return;
    }
  }

  if (!chain) return;

  const isrSink: IsrSink = {};
  const shell: SsrShell = {
    headTags: '',
    assetTags,
    nonce: undefined,
    _isr: isrSink,
  };

  let response: Response;
  try {
    // Always use renderChain() to preserve slot/interception metadata (Bug 3 fix).
    // Wrap with withAfterContext so that any after() callbacks registered during
    // background regeneration are captured (they are silently discarded since there
    // is no response stream to attach them to in a background regen).
    response = await withAfterContext(() => config.renderer.renderChain(chain, shell, bsCtx));
  } catch (err) {
    console.error('[slingshot-ssr] ISR regen render error for', pathname, err);
    return;
  }

  if (typeof isrSink.revalidate !== 'number' || isrSink.revalidate <= 0 || isrSink.noStore) return;

  const html = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const now = Date.now();
  await isrAdapter.set(cacheKey, {
    html,
    // Persist the original render status so cache hits replay the correct code.
    status: response.status,
    headers,
    generatedAt: now,
    revalidateAfter: now + isrSink.revalidate * 1000,
    tags: isrSink.tags ?? [],
  });
}

/**
 * Resolve the Cache-Control header value for a given pathname.
 *
 * Route-specific overrides take precedence over the default.
 * Falls back to `'no-store'` when no config is provided.
 *
 * @internal
 */
function resolveCacheControl(config: SsrCacheControl | undefined, pathname: string): string {
  if (!config) return 'no-store';
  const routeOverride = config.routes?.[pathname];
  if (routeOverride !== undefined) return routeOverride;
  return config.default ?? 'no-store';
}
