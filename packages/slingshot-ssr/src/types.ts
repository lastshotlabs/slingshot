// packages/slingshot-ssr/src/types.ts
import type { SlingshotContext, SlingshotRuntime } from '@lastshotlabs/slingshot-core';
import type { DraftModeStatus } from './draft/index';
import type { IsrConfig } from './isr/types';
import type {
  EntityMeta,
  NavigationConfig,
  PageData,
  PageDeclaration,
  ResolvedPageDeclaration,
} from './pageDeclarations';

export type { IsrCacheAdapter, IsrCacheEntry, IsrConfig } from './isr/types';

// ─── Loader return values ────────────────────────────────────────────────────

/**
 * A TanStack Query cache entry to pre-seed during SSR.
 *
 * The `queryKey` array must match exactly the key used by the corresponding
 * client-side `useQuery()` hook. On hydration, the client reads this entry
 * from the dehydrated state and skips the network request.
 *
 * @example
 * ```ts
 * // Server — seed the cache
 * queryCache: [{ queryKey: ['post', slug], data: post }]
 *
 * // Client — cache hit, no refetch
 * useQuery({ queryKey: ['post', slug], queryFn: () => fetchPost(slug) })
 * ```
 */
export interface SsrQueryCacheEntry {
  /** Must match the client-side `useQuery` queryKey exactly. */
  readonly queryKey: readonly unknown[];
  /** The data to cache. Must be JSON-serializable. */
  readonly data: unknown;
}

/**
 * Successful load result from a server route's `load()` function.
 *
 * The generic parameter `TData` types the `data` field, connecting loader return
 * type to component props via `defineRoute()`. Defaults to `Record<string, unknown>`
 * for backwards-compatible untyped usage.
 *
 * Both `data` and `queryCache` must be JSON-serializable — they are embedded
 * in the HTML as dehydrated state for client hydration.
 *
 * @example Typed via defineRoute()
 * ```ts
 * const route = defineRoute({
 *   load: async (ctx): Promise<SsrLoadResult<{ post: Post }>> => ({
 *     data: { post: await postRepo.findBySlug(ctx.params.slug) },
 *   }),
 *   Page: ({ loaderData }) => <PostDetail post={loaderData.post} />,
 * })
 * ```
 */
export interface SsrLoadResult<TData extends object = Record<string, unknown>> {
  /**
   * Arbitrary data passed as `loaderData` prop to the rendered React component.
   * Must be JSON-serializable.
   */
  readonly data: TData;
  /**
   * TanStack Query cache entries to pre-seed.
   * Prevents client-side refetch for data already fetched on the server.
   * @default []
   */
  readonly queryCache?: readonly SsrQueryCacheEntry[];
  /**
   * Static generation / revalidation control.
   *
   * - `false`     — generate once at build time, never revalidate (pure SSG)
   * - `0`         — never cache; render on every request (force dynamic)
   * - `number`    — cache for N seconds, then regenerate in background (ISR)
   * - `undefined` — no SSG/ISR, render on every request (default)
   */
  readonly revalidate?: number | false;
  /**
   * ISR cache tags for tag-based invalidation via `revalidateTag()`.
   * Only meaningful when `revalidate` is a number or `false`.
   */
  readonly tags?: readonly string[];
}

/**
 * Exported from dynamic route files to enumerate all static paths.
 * Required when `load()` returns `revalidate: false` on a dynamic route.
 * Called during `slingshot ssg` — inject a DB context via `globalThis.__ssgDb`
 * before calling this from the SSG crawler.
 *
 * @example
 * ```ts
 * // server/routes/posts/[slug].ts
 * export async function staticPaths(): Promise<Array<Record<string, string>>> {
 *   const posts = await globalThis.__ssgDb.posts.findAll()
 *   return posts.map(p => ({ slug: p.slug }))
 * }
 * ```
 */
export type SsgStaticPathsFn = () => Promise<Array<Record<string, string>>>;

/**
 * Signal from a server route's `load()` that the client should be redirected.
 *
 * `slingshot-ssr` responds with the appropriate HTTP redirect status.
 *
 * @example
 * ```ts
 * export async function load(ctx: SsrLoadContext) {
 *   if (!await ctx.getUser()) return { redirect: '/login' }
 *   // ...
 * }
 * ```
 */
export interface SsrRedirectResult {
  /** The URL to redirect to. May be relative (`/login`) or absolute. */
  readonly redirect: string;
  /**
   * HTTP redirect status code.
   * @default 302
   */
  readonly status?: 301 | 302 | 307 | 308;
}

/**
 * Signal from a server route's `load()` that the resource was not found.
 *
 * `slingshot-ssr` falls through to the SPA, which renders its own 404 page.
 * The HTTP response will be 200 (the SPA handles the 404 UI).
 */
export interface SsrNotFoundResult {
  readonly notFound: true;
}

/**
 * Signal from a server route's `load()` that the user lacks permission.
 *
 * `slingshot-ssr` responds with `403 Forbidden`. Co-locate a `forbidden.ts`
 * convention file to render a custom UI instead of a plain-text fallback.
 *
 * @example
 * ```ts
 * export async function load(ctx: SsrLoadContext) {
 *   const user = await ctx.getUser()
 *   if (!user) return { unauthorized: true }
 *   if (!user.roles.includes('admin')) return { forbidden: true }
 *   return { data: { ... } }
 * }
 * ```
 */
export interface SsrForbiddenResult {
  readonly forbidden: true;
}

/**
 * Signal from a server route's `load()` that the user is not authenticated.
 *
 * `slingshot-ssr` responds with `401 Unauthorized`. Co-locate an `unauthorized.ts`
 * convention file to render a custom UI instead of a plain-text fallback.
 *
 * @example
 * ```ts
 * export async function load(ctx: SsrLoadContext) {
 *   const user = await ctx.getUser()
 *   if (!user) return { unauthorized: true }
 *   return { data: { ... } }
 * }
 * ```
 */
export interface SsrUnauthorizedResult {
  readonly unauthorized: true;
}

/**
 * All possible return types from a server route's `load()` function.
 */
export type SsrLoaderReturn =
  | SsrLoadResult
  | SsrRedirectResult
  | SsrNotFoundResult
  | SsrForbiddenResult
  | SsrUnauthorizedResult;

// ─── Type guards ─────────────────────────────────────────────────────────────

/**
 * Returns true when the loader result is a redirect.
 * @internal
 */
export function isRedirect(result: SsrLoaderReturn): result is SsrRedirectResult {
  return 'redirect' in result;
}

/**
 * Returns true when the loader result signals not-found.
 * @internal
 */
export function isNotFound(result: SsrLoaderReturn): result is SsrNotFoundResult {
  return 'notFound' in result;
}

/**
 * Returns true when the loader result is a successful load with a `data` field.
 * @internal
 */
export function isLoadResult(result: SsrLoaderReturn): result is SsrLoadResult {
  return 'data' in result;
}

/** Returns true when the loader result signals forbidden (403). @internal */
export function isForbidden(result: SsrLoaderReturn): result is SsrForbiddenResult {
  return 'forbidden' in result;
}

/** Returns true when the loader result signals unauthorized (401). @internal */
export function isUnauthorized(result: SsrLoaderReturn): result is SsrUnauthorizedResult {
  return 'unauthorized' in result;
}

// ─── Load context ─────────────────────────────────────────────────────────────

/**
 * The context object passed to every server route `load()` and `meta()` function.
 *
 * Provides request data and access to the slingshot instance. All data fetching
 * in `load()` should go through `bsCtx` — no HTTP round trips needed since
 * the loader runs in the same process as the database.
 *
 * @example
 * ```ts
 * // server/routes/posts/[slug].ts
 * export async function load(ctx: SsrLoadContext) {
 *   const user = await ctx.getUser()
 *   if (!user) return { redirect: '/login' }
 *   const post = await getPost(ctx.params.slug, ctx.bsCtx)
 *   return { data: { post }, queryCache: [{ queryKey: ['post', ctx.params.slug], data: post }] }
 * }
 * ```
 */
export interface SsrLoadContext {
  /** Dynamic route segment values extracted from the URL. */
  readonly params: Readonly<Record<string, string>>;
  /** Parsed query string. For `/posts?page=2`, `query.page === '2'`. */
  readonly query: Readonly<Record<string, string>>;
  /** The full request URL object. */
  readonly url: URL;
  /** Raw request headers. Read-only. */
  readonly headers: Readonly<Headers>;
  /**
   * Resolve the currently authenticated user from the session cookie.
   *
   * Returns `null` when no valid session is present. Calls slingshot-auth session
   * resolution directly — no HTTP round trip. Returns `null` when `slingshot-auth`
   * is not registered with this app.
   */
  getUser(): Promise<{ id: string; email: string; roles: string[] } | null>;
  /**
   * The raw slingshot context. Provides direct access to database handles,
   * event bus, plugin state, and all registered plugin infrastructure.
   *
   * Access your plugin's state via `bsCtx.pluginState.get('your-plugin-name')`.
   */
  readonly bsCtx: SlingshotContext;
  /**
   * Returns the draft mode status for the current request.
   *
   * When `isEnabled` is `true`, the request carries the draft mode cookie.
   * Use this to fetch unpublished/draft content from your CMS instead of
   * the published version.
   *
   * Draft mode is enabled via `GET /api/draft/enable?secret=<token>` and
   * disabled via `GET /api/draft/disable`.
   *
   * @returns A {@link DraftModeStatus} snapshot for this request.
   *
   * @example
   * ```ts
   * export async function load(ctx: SsrLoadContext) {
   *   const { isEnabled } = ctx.draftMode();
   *   const post = isEnabled
   *     ? await cms.getDraftPost(ctx.params.slug)
   *     : await cms.getPublishedPost(ctx.params.slug);
   *   return { data: { post } };
   * }
   * ```
   */
  draftMode(): DraftModeStatus;
  /**
   * Schedule a callback to run after the HTTP response has been fully sent.
   *
   * Use this for work that should not delay the response — analytics events,
   * audit logging, cache warming, or webhook calls. The callback runs after
   * the response stream is flushed; errors in callbacks are caught and logged
   * without affecting the response.
   *
   * Callbacks are executed in registration order. All callbacks from a single
   * request run before the next request's callbacks start.
   *
   * @param callback - The async function to execute after the response is sent.
   *
   * @example
   * ```ts
   * export async function load(ctx: SsrLoadContext) {
   *   const post = await getPost(ctx.params.slug, ctx.bsCtx)
   *   ctx.after(async () => {
   *     await analytics.track('page_view', { path: ctx.url.pathname })
   *   })
   *   return { data: { post } }
   * }
   * ```
   */
  after(callback: () => void | Promise<void>): void;
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

/**
 * Head/meta tag configuration returned by a server route's `meta()` function.
 *
 * All string values are HTML-escaped before injection into the document.
 */
export interface SsrMeta {
  /**
   * Page title. Injected as `<title>`.
   * Tip: use a template like `${pageTitle} | ${siteName}`.
   */
  title?: string;
  /** Meta description. Injected as `<meta name="description">`. */
  description?: string;
  /** Canonical URL. Injected as `<link rel="canonical">`. */
  canonical?: string;
  /** Additional arbitrary `<meta>` tag attributes. */
  meta?: ReadonlyArray<Readonly<Record<string, string>>>;
  /** Open Graph tags. */
  og?: {
    title?: string;
    description?: string;
    image?: string;
    imageAlt?: string;
    type?: string;
    url?: string;
    siteName?: string;
  };
  /** Twitter Card tags. */
  twitter?: {
    card?: 'summary' | 'summary_large_image' | 'app' | 'player';
    title?: string;
    description?: string;
    image?: string;
    imageAlt?: string;
    site?: string;
  };
  /**
   * JSON-LD structured data. Must be JSON-serializable.
   * Injected as `<script type="application/ld+json">`.
   */
  jsonLd?: Record<string, unknown>;
  /**
   * Robots meta tag content.
   * @example `'noindex, nofollow'`
   */
  robots?: string;
}

/**
 * Result of executing an entity-driven page loader.
 *
 * Contains the resolved declaration, loaded data, derived entity metadata,
 * and optional navigation/ISR hints for renderer implementations.
 */
export interface PageLoaderResult {
  /** The resolved, frozen page declaration that matched the request. */
  readonly declaration: ResolvedPageDeclaration;
  /** Loaded page data; discriminated by `type`. */
  readonly data: PageData;
  /** Entity metadata keyed by entity name for all entities referenced by the page. */
  readonly entityMeta: Readonly<Record<string, EntityMeta>>;
  /** Resolved page metadata for the renderer head pipeline. */
  readonly meta: SsrMeta;
  /** Optional shell/navigation configuration from the manifest. */
  readonly navigation?: NavigationConfig;
  /** Optional ISR revalidation interval in seconds. */
  readonly revalidate?: number;
  /** Optional ISR cache tags derived from the page and loaded record(s). */
  readonly tags?: readonly string[];
}

// ─── Route match ─────────────────────────────────────────────────────────────

/**
 * A resolved server route — the output of the file-based route resolver.
 *
 * Passed from the resolver to the renderer's `render()` method. Contains
 * everything the renderer needs to load data and produce HTML.
 */
export interface SsrRouteMatch {
  /**
   * Absolute path to the server route entry file.
   *
   * For a single-file route: `/app/server/routes/posts/[slug].ts`
   * For a directory route: `/app/server/routes/posts/[slug]/load.ts`
   */
  readonly filePath: string;
  /**
   * Absolute path to the `meta.ts` file when the route is in directory form
   * and a `meta.ts` exists alongside the `load.ts`. `null` for single-file
   * routes (meta is a named export in the same file) and for directory routes
   * without a `meta.ts`.
   */
  readonly metaFilePath: string | null;
  /** Resolved dynamic segment values. */
  readonly params: Readonly<Record<string, string>>;
  /** Resolved query string key-value pairs. */
  readonly query: Readonly<Record<string, string>>;
  /** The full request URL. */
  readonly url: URL;
  /**
   * Absolute path to a `loading.ts` (or `loading/index.ts`) file co-located with
   * this route. Used to wrap the page in a `<Suspense>` boundary during SSR.
   * `null` when no such file exists in the route's directory.
   */
  readonly loadingFilePath: string | null;
  /**
   * Absolute path to an `error.ts` (or `error/index.ts`) file co-located with
   * this route. Used to wrap the page in an error boundary during SSR.
   * `null` when no such file exists in the route's directory.
   */
  readonly errorFilePath: string | null;
  /**
   * Absolute path to a `not-found.ts` (or `not-found/index.ts`) file co-located
   * with this route. Rendered with a 404 status when `load()` returns `{ notFound: true }`.
   * `null` when no such file exists in the route's directory.
   */
  readonly notFoundFilePath: string | null;
  /**
   * Absolute path to a `forbidden.ts` convention file co-located with this route.
   * Rendered with a 403 status when `load()` returns `{ forbidden: true }`.
   * `null` when no such file exists in the route's directory.
   */
  readonly forbiddenFilePath: string | null;
  /**
   * Absolute path to an `unauthorized.ts` convention file co-located with this route.
   * Rendered with a 401 status when `load()` returns `{ unauthorized: true }`.
   * `null` when no such file exists in the route's directory.
   */
  readonly unauthorizedFilePath: string | null;
  /**
   * Absolute path to a `template.ts` convention file co-located with this route's
   * layout. Like `layout.ts`, but remounts on every client-side navigation.
   *
   * The rendering order at each directory level is: Layout → Template → children.
   * During SSR, templates render identically to layouts. The remounting behaviour
   * is enforced on the client by giving the template a navigation-keyed `key` prop.
   *
   * Applies only to layout-level `SsrRouteMatch` entries in `SsrRouteChain.layouts`.
   * Always `null` on the leaf page match.
   */
  readonly templateFilePath: string | null;
  /**
   * The `generateStaticParams` function exported from this route module, if any.
   *
   * Populated by the route loader after dynamically importing the route file.
   * `undefined` when the route module does not export `generateStaticParams` or
   * when the route has not yet been loaded (e.g. in the file-resolver output
   * before module import).
   *
   * At build time the static-params scanner calls all `generateStaticParams`
   * exports to enumerate concrete URL paths for pre-rendering. At request time
   * the framework does not call this function — it is only used at build time.
   */
  readonly generateStaticParams?: GenerateStaticParams;
  /**
   * Resolved entity-driven page declaration for manifest-backed routes.
   *
   * Present only when the match was produced by the page declaration resolver
   * rather than the file-system route resolver.
   */
  readonly pageDeclaration?: ResolvedPageDeclaration;
}

// ─── Shell ────────────────────────────────────────────────────────────────────

/**
 * The HTML tag strings injected into the document head by `slingshot-ssr`.
 *
 * Passed to the renderer's `render()` method. The renderer is responsible for
 * embedding these in the correct positions in the HTML output.
 *
 * Standard injection order in `<head>`:
 * 1. `headTags` — title, meta, OG tags
 * 2. `assetTags` — hashed `<link>` and `<script>` from Vite manifest
 * 3. Renderer-specific dehydrated state scripts
 */
export interface SsrShell {
  /**
   * HTML tag strings for title, meta, OG, Twitter Card, JSON-LD.
   * Sourced from the route's `meta()` return value.
   * All values are HTML-escaped. Safe to inject directly into `<head>`.
   * Empty string when the route has no `meta()` export.
   */
  readonly headTags: string;
  /**
   * `<link rel="stylesheet">` and `<script type="module">` tag strings
   * resolved from the Vite asset manifest.
   * Safe to inject directly into `<head>`.
   */
  readonly assetTags: string;
  /**
   * Content Security Policy nonce for inline scripts, or `undefined` when
   * CSP nonce is not configured. Renderers must apply this to all inline
   * `<script>` tags they generate to maintain CSP compliance.
   */
  readonly nonce?: string;
  /**
   * Framework-internal ISR sink.
   *
   * The middleware creates this object before calling the renderer and reads
   * it back after `render()` returns to determine whether to cache the response.
   * The renderer **must** populate this after calling `load()` if it wants
   * ISR caching to apply.
   *
   * @internal Do not use in application code.
   */
  readonly _isr?: IsrSink;
  /**
   * Whether the current request is in draft mode.
   *
   * Set by the SSR middleware to `true` when the request carries the draft mode
   * cookie (`__slingshot_draft__`). The renderer passes this into the load context
   * via `ctx.draftMode()` so route load functions can fetch draft content.
   *
   * When `true`, the ISR cache is bypassed for this request and a fresh render
   * is always performed.
   *
   * @internal Do not use in application code outside of renderer implementations.
   */
  readonly _draftMode?: boolean;
  /**
   * Inject the `after()` scheduler for this request.
   *
   * Set by the SSR middleware to a function that enqueues callbacks in the
   * per-request after-queue. The renderer passes this into every load context
   * as `ctx.after()`. Callbacks are drained after the response stream flushes.
   *
   * `undefined` when after-callback support is not wired up (e.g. in tests).
   *
   * @internal Do not use in application code outside of renderer implementations.
   */
  readonly _after?: (callback: () => void | Promise<void>) => void;
}

/**
 * Mutable sink for ISR metadata from the renderer back to the middleware.
 *
 * The middleware creates a plain object `{}` satisfying this interface,
 * attaches it to `SsrShell._isr`, and reads `revalidate`/`tags`/`noStore`
 * from it after the renderer returns. The renderer writes to this object after
 * calling `load()`.
 *
 * @internal
 */
export interface IsrSink {
  /** The `revalidate` value returned by `load()`, if any. */
  revalidate?: number | false;
  /** The `tags` array returned by `load()`, if any. */
  tags?: readonly string[];
  /**
   * Set to `true` when the loader called `unstable_noStore()` during the
   * render. When `true`, the middleware skips the ISR cache write even if
   * `revalidate` is a positive number.
   *
   * Populated by `renderPage()` in `snapshot/src/ssr/render.ts` via
   * `getNoStore()` after the render completes.
   */
  noStore?: boolean;
}

// ─── Nested layouts ───────────────────────────────────────────────────────────

/**
 * Props passed to layout components from the SSR renderer.
 *
 * `loaderData` comes from the layout's own `load()` function. `children` is the
 * rendered output of the child route or nested layout.
 */
export interface SsrLayoutProps {
  /** Data returned by the layout's own `load()` function. */
  readonly loaderData: Record<string, unknown>;
  /** Dynamic route segment values for the matched URL. */
  readonly params: Readonly<Record<string, string>>;
  /** The rendered output of the child route or nested layout. */
  readonly children: unknown; // React.ReactNode — kept as unknown to avoid hard React dep
}

/**
 * A resolved layout chain from root to leaf page.
 *
 * Used by `SlingshotSsrRenderer.renderChain()` to render nested layouts. When no
 * `layout.ts` files are found, `layouts` is empty and the middleware calls
 * `renderer.render()` instead of `renderer.renderChain()`.
 */
export interface SsrRouteChain {
  /**
   * Layout files from root to closest ancestor (root-first order).
   * Empty array when no `layout.ts` ancestors exist for the matched page.
   */
  readonly layouts: readonly SsrRouteMatch[];
  /** The matched leaf page route. */
  readonly page: SsrRouteMatch;
  /**
   * Parallel route slots found in the leaf directory. Undefined when no `@`-prefixed
   * subdirectories exist.
   */
  readonly slots?: readonly SsrParallelSlot[];
  /**
   * True when an intercepting route matched instead of the direct page route.
   * Causes the renderer to add `X-Snapshot-Interception: modal` to the response.
   */
  readonly intercepted?: boolean;
  /**
   * Absolute path to `server/middleware.ts` (the directory adjacent to
   * `serverRoutesDir`), or `null` when no middleware file exists.
   */
  readonly middlewareFilePath: string | null;
}

// ─── Parallel routes ──────────────────────────────────────────────────────────

/**
 * A single named parallel slot discovered in a leaf route directory.
 *
 * Parallel slots correspond to `@{name}` subdirectories. The slot's `match` is
 * `null` when the current URL does not resolve to any route within that slot's tree.
 */
export interface SsrParallelSlot {
  /** The slot name (the portion after `@` in the directory name). */
  readonly name: string;
  /**
   * The resolved route match within the slot's directory tree for the current URL.
   * `null` when the URL does not match any route in this slot.
   */
  readonly match: SsrRouteMatch | null;
  /**
   * Absolute path to a `default.ts` file in this slot's directory.
   *
   * Rendered when `match` is `null` — i.e., when the current URL does not match
   * any route within this slot's directory tree. Mirrors Next.js parallel routes
   * `default.js` semantics: slots without an active URL match show their default
   * instead of rendering nothing.
   *
   * `null` when no default convention file exists in the slot directory.
   */
  readonly defaultFilePath: string | null;
}

// ─── SSR middleware context ────────────────────────────────────────────────────

/**
 * Context object passed to the `server/middleware.ts` function.
 *
 * Provides request metadata and auth resolution without exposing the raw Hono
 * context. The middleware function receives this and returns an `SsrMiddlewareResult`.
 *
 * @example
 * ```ts
 * // server/middleware.ts
 * import type { SsrMiddlewareContext, SsrMiddlewareResult } from '@lastshotlabs/slingshot-ssr'
 *
 * export async function middleware(ctx: SsrMiddlewareContext): Promise<SsrMiddlewareResult> {
 *   const user = await ctx.getUser()
 *   if (!user && ctx.pathname.startsWith('/dashboard')) {
 *     return { redirect: '/login' }
 *   }
 *   return {}
 * }
 * ```
 */
export interface SsrMiddlewareContext {
  /** The URL pathname (e.g. `/dashboard/settings`). */
  readonly pathname: string;
  /** The full parsed request URL. */
  readonly url: URL;
  /** Raw request headers. Read-only. */
  readonly headers: Headers;
  /** Dynamic route segment values extracted from the matched route. */
  readonly params: Readonly<Record<string, string>>;
  /**
   * Resolve the currently authenticated user from the session cookie.
   *
   * Returns `null` when no valid session is present. Delegates to slingshot-auth
   * when registered; returns `null` if auth plugin is not configured.
   */
  getUser(): Promise<{ id: string; roles: string[] } | null>;
  /** The raw slingshot context for direct plugin/adapter access. */
  readonly bsCtx: SlingshotContext;
}

/**
 * Result returned from the `server/middleware.ts` function.
 *
 * Return one of four shapes:
 * - `{ redirect, status? }` — redirect the request to a new URL
 * - `{ rewrite }` — internally rewrite the route resolution to a different path
 * - `{ headers }` — add headers to the final rendered response
 * - `{}` — pass through unchanged
 */
export type SsrMiddlewareResult =
  | { readonly redirect: string; readonly status?: 301 | 302 | 307 | 308 }
  | { readonly rewrite: string }
  | { readonly headers: Record<string, string> }
  | Record<string, never>;

// ─── Renderer contract ────────────────────────────────────────────────────────

/**
 * The renderer contract for `slingshot-ssr`.
 *
 * Framework-agnostic. `snapshot/ssr` provides `createReactRenderer()` for React apps.
 * Any object with `resolve`, `render`, and `renderChain` matching these signatures is
 * valid — TypeScript verifies compatibility structurally at the consumer's compile time.
 *
 * **Cross-repo coupling:** `snapshot/ssr` does NOT import this type. The consumer app
 * imports from both packages and TypeScript verifies structural compatibility.
 * This is intentional — no forced dependency between the two packages.
 *
 * @example Plain HTML renderer (no framework required)
 * ```ts
 * import { createSsrPlugin } from '@lastshotlabs/slingshot-ssr'
 *
 * createSsrPlugin({
 *   renderer: {
 *     async resolve(url) {
 *       const template = templates[url.pathname]
 *       if (!template) return null
 *       return { filePath: url.pathname, metaFilePath: null, params: {}, query: {}, url }
 *     },
 *     async render(match, shell, _bsCtx) {
 *       const html = `<!DOCTYPE html><html><head>${shell.headTags}${shell.assetTags}</head>
 *         <body>${templates[match.url.pathname]()}</body></html>`
 *       return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
 *     },
 *     async renderChain(chain, shell, _bsCtx) {
 *       const html = `<!DOCTYPE html><html><head>${shell.headTags}${shell.assetTags}</head>
 *         <body>${templates[chain.page.url.pathname]()}</body></html>`
 *       return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
 *     }
 *   },
 *   serverRoutesDir: import.meta.dir + '/server/routes',
 *   assetsManifest: import.meta.dir + '/dist/.vite/manifest.json',
 * })
 * ```
 */
export interface SlingshotSsrRenderer {
  /**
   * Resolve a URL to a route match.
   *
   * Called for every incoming GET request before Hono's route tree is consulted.
   * Must be synchronous in intent — do not fetch data here. That belongs in `render()`.
   * Returning `null` causes `slingshot-ssr` to call `next()` and fall through to the SPA.
   *
   * @param url - The full request URL.
   * @param bsCtx - The slingshot instance context.
   * @returns A route match, or `null` to skip SSR for this request.
   */
  resolve(url: URL, bsCtx: SlingshotContext): Promise<SsrRouteMatch | null>;

  /**
   * Render the resolved route to a streaming HTTP Response.
   *
   * Called only when `resolve()` returned a non-null match and the route has no
   * layout ancestors. Responsible for:
   * - Calling the route's `load()` function
   * - Calling the route's `meta()` function (if it exists)
   * - Producing the full HTML response (head + body)
   * - Handling redirect and not-found signals from `load()`
   *
   * On redirect: return a `Response` with status 301/302/307/308 and `Location` header.
   * On not-found: return a `Response` that falls through (or call the SPA shell).
   * On error: throw — `slingshot-ssr` catches, logs, and falls through to next().
   *
   * @param match - The resolved route from `resolve()`.
   * @param shell - HTML tag strings from slingshot-ssr (head tags, asset tags, nonce).
   * @param bsCtx - The slingshot instance context.
   * @returns A complete `Response` with Content-Type text/html.
   */
  render(match: SsrRouteMatch, shell: SsrShell, bsCtx: SlingshotContext): Promise<Response>;

  /**
   * Renders a full layout chain. Called when a route has one or more `layout.ts`
   * ancestors. Implementations execute all layout `load()` functions, merge `meta()`,
   * and render the nested component tree from outermost layout to leaf page.
   *
   * Layout loads are executed in parallel (they are independent). Page load is
   * executed after layout loads — it takes precedence for redirect/not-found signals.
   *
   * @param chain - The resolved route chain including layouts and the leaf page.
   * @param shell - HTML tag strings from slingshot-ssr (head tags, asset tags, nonce).
   * @param bsCtx - The slingshot instance context.
   * @returns A complete `Response` with Content-Type text/html.
   */
  renderChain(chain: SsrRouteChain, shell: SsrShell, bsCtx: SlingshotContext): Promise<Response>;

  /**
   * Render an entity-driven page declaration result.
   *
   * Called when the SSR middleware resolves a request against `config.pages`
   * and executes the generated page loader successfully.
   *
   * @param result - The resolved page declaration and loaded data.
   * @param shell - HTML tag strings from slingshot-ssr (head tags, asset tags, nonce).
   * @param bsCtx - The slingshot instance context.
   * @returns A complete `Response` with Content-Type text/html.
   */
  renderPage?(
    result: PageLoaderResult,
    shell: SsrShell,
    bsCtx: SlingshotContext,
  ): Promise<Response>;

  /**
   * Optional hook called by `slingshot-ssg` after the renderer is loaded and before
   * any page is rendered.
   *
   * When `--rsc-manifest <path>` is passed to the SSG runner, `rscManifest`
   * contains the parsed JSON from that file. The renderer implementation can use
   * this to activate RSC two-pass rendering for all SSG pages.
   *
   * Renderers that do not implement this method continue to work unchanged - the
   * SSG runner calls it only when the method is present.
   *
   * @param opts.rscManifest - The parsed `rsc-manifest.json` object from the build
   *   output. Type is `unknown` here to avoid a hard dependency on snapshot
   *   internals. Cast to `RscManifest` (from `@lastshotlabs/snapshot/ssr`) in the
   *   implementation.
   */
  ssgConfigure?(opts: { rscManifest?: unknown }): Promise<void>;
}

// ─── Static params ────────────────────────────────────────────────────────────

/**
 * One set of dynamic route segment values that maps to a single pre-rendered page.
 *
 * For a route file at `server/routes/players/[id].ts`, a `StaticParamSet` of
 * `{ id: "42" }` tells the build system to pre-render `/players/42`.
 *
 * @example
 * ```ts
 * // server/routes/players/[id].ts
 * export async function generateStaticParams(): Promise<StaticParamSet[]> {
 *   return [{ id: '1' }, { id: '2' }, { id: '3' }]
 * }
 * ```
 */
export type StaticParamSet = Record<string, string>;

/**
 * Function exported from a route file to enumerate all static paths at build time.
 *
 * Called during the static-params build phase. Receives an empty `SsrLoadContext`
 * (no live request data) — only use it to access database handles via
 * `ctx.bsCtx` when running inside the SSG crawler that injects a real context.
 *
 * Returning an empty array or not exporting this function causes the route to
 * be rendered on-demand (no pre-rendering for that route).
 *
 * @param ctx - A partial load context. `params`, `query`, `url`, and `headers`
 *   are empty/placeholder values at build time. `bsCtx` is populated when called
 *   from the SSG crawler; it is an empty shell otherwise.
 * @returns An array of param sets — one per page to pre-render.
 *
 * @example
 * ```ts
 * import type { GenerateStaticParams } from '@lastshotlabs/slingshot-ssr'
 *
 * export const generateStaticParams: GenerateStaticParams = async (ctx) => {
 *   const players = await ctx.bsCtx.db.query('SELECT id FROM players')
 *   return players.map(p => ({ id: String(p.id) }))
 * }
 * ```
 */
export type GenerateStaticParams = (
  ctx: SsrLoadContext,
) => Promise<StaticParamSet[]> | StaticParamSet[];

// ─── Type-safe route definition ──────────────────────────────────────────────

/**
 * Options accepted by `defineRoute()`.
 *
 * The `TData` generic threads from `load` through to `Page` and `meta`,
 * so TypeScript checks prop types automatically without manual annotations.
 *
 * @typeParam TData - Shape of the data object returned by `load()`.
 */
export interface DefineRouteOptions<TData extends Record<string, unknown>> {
  /**
   * Server-side data loader. Called on every SSR request (or once at build time
   * for statically generated pages). Must return `SsrLoadResult<TData>`, a
   * redirect signal, or a not-found signal.
   */
  load: (ctx: SsrLoadContext) => Promise<SsrLoadResult<TData>>;
  /**
   * The React page component. Receives `loaderData` typed as `TData` — no casts needed.
   * Kept as `unknown` return to avoid a hard React peer dependency in the type file.
   */
  Page: (props: {
    loaderData: TData;
    params: Readonly<Record<string, string>>;
    query: Readonly<Record<string, string>>;
  }) => unknown; // React.ReactElement — kept as unknown to avoid hard React dep
  /**
   * Optional head/meta producer. Called after `load()` on every SSR request.
   * Receives the load result so page-specific data (e.g. post title) can flow
   * into the `<title>` tag without a second database call.
   */
  meta?: (ctx: SsrLoadContext, result: SsrLoadResult<TData>) => Promise<SsrMeta>;
  /**
   * Optional static path enumeration. Exported from a dynamic route file to
   * tell the build system which param sets to pre-render at build time.
   *
   * At build time the scanner calls this with an empty context. When running
   * inside the SSG crawler, `ctx.bsCtx` provides real database access.
   *
   * @example
   * ```ts
   * generateStaticParams: async (ctx) => {
   *   const slugs = await ctx.bsCtx.db.query('SELECT slug FROM posts')
   *   return slugs.map(r => ({ slug: r.slug }))
   * }
   * ```
   */
  generateStaticParams?: GenerateStaticParams;
  /**
   * Opt this route into Partial Prerendering (PPR).
   *
   * When `true`, the static shell of the page (everything outside `<Suspense>`
   * boundaries) is pre-rendered at build time and cached. At request time the
   * shell is sent immediately (fast TTFB) while dynamic Suspense slots are
   * streamed in as their data resolves.
   *
   * Requires the `prerenderPprShells()` build step to be called after the Vite
   * build so that shells are pre-computed and stored in the PPR cache.
   *
   * @default false
   */
  ppr?: boolean;
}

/**
 * Type-safe route definition helper. Connects the loader's return type to the
 * page component's `loaderData` prop type, eliminating manual type annotations.
 *
 * The returned object contains `load`, `Page`, and optionally `meta` and
 * `generateStaticParams`. Spread the named exports for the module exports and
 * use `route.Page` as the default export.
 *
 * **Rule 9:** `defineRoute` does not redefine types — it constrains the existing
 * `SsrLoadResult<TData>` generic at the call site.
 *
 * @param config - Route options including loader, page component, and optionally
 *   meta producer and static param enumerator.
 * @returns The same config object, typed. Assign to a `const route` and destructure.
 *
 * @example
 * ```ts
 * // server/routes/posts/[slug].ts
 * import { defineRoute } from '@lastshotlabs/slingshot-ssr'
 * import type { Post } from '../types'
 *
 * const route = defineRoute({
 *   load: async (ctx): Promise<SsrLoadResult<{ post: Post }>> => ({
 *     data: { post: await postRepo.findBySlug(ctx.params.slug) },
 *   }),
 *   Page: ({ loaderData }) => <PostDetail post={loaderData.post} />,
 *   meta: async (_ctx, result) => ({ title: result.data.post.title }),
 *   generateStaticParams: async () => [{ slug: 'hello-world' }, { slug: 'nba-finals' }],
 * })
 *
 * export const { load, meta, generateStaticParams } = route
 * export default route.Page
 * ```
 */
export function defineRoute<TData extends Record<string, unknown>>(
  config: DefineRouteOptions<TData>,
): DefineRouteOptions<TData> {
  return config;
}

// ─── Plugin config ────────────────────────────────────────────────────────────

/**
 * Cache-control configuration for SSR responses.
 */
export interface SsrCacheControl {
  /**
   * Default Cache-Control header applied to all SSR responses.
   * Set to a public cache directive for publicly cacheable pages.
   * @default 'no-store'
   */
  default?: string;
  /**
   * Per-route-pattern overrides. Keys are exact URL pathname strings.
   *
   * @example
   * ```ts
   * routes: {
   *   '/': 'public, max-age=300, stale-while-revalidate=3600',
   *   '/posts': 'public, max-age=60, stale-while-revalidate=300',
   * }
   * ```
   */
  routes?: Readonly<Record<string, string>>;
}

/**
 * Configuration for `createSsrPlugin()`.
 *
 * @example
 * ```ts
 * createSsrPlugin({
 *   renderer: createReactRenderer({ snapshot, resolveComponent }),
 *   serverRoutesDir: import.meta.dir + '/server/routes',
 *   assetsManifest: import.meta.dir + '/dist/.vite/manifest.json',
 *   cacheControl: {
 *     default: 'no-store',
 *     routes: { '/': 'public, max-age=300' },
 *   },
 *   exclude: ['/admin', '/webhooks'],
 * })
 * ```
 */
export interface SsrPluginConfig {
  /**
   * The renderer implementation. Must satisfy `SlingshotSsrRenderer` structurally.
   * `snapshot/ssr` provides `createReactRenderer()` for React apps.
   */
  renderer: SlingshotSsrRenderer;
  /**
   * Optional manifest-backed page declarations keyed by page key.
   *
   * When set, the SSR middleware resolves these declarations after file-based
   * routes and before falling through to the renderer's own `resolve()`.
   */
  readonly pages?: Readonly<Record<string, PageDeclaration>>;
  /**
   * Optional renderer-agnostic shell/navigation configuration.
   *
   * Passed through to `renderPage()` results for renderers that implement
   * app shell chrome such as sidebars or top navigation.
   */
  readonly navigation?: Readonly<NavigationConfig>;
  /**
   * Absolute path to the `server/routes/` directory.
   * Use `import.meta.dir + '/server/routes'` from the app entry file.
   */
  serverRoutesDir: string;
  /**
   * Absolute path to the Vite asset manifest JSON file.
   * Generated by Vite when `build.manifest: true`.
   * Typically `import.meta.dir + '/dist/.vite/manifest.json'`.
   *
   * In dev mode (`NODE_ENV === 'development'`), this file may not exist.
   * The plugin falls back to injecting a Vite dev client script instead.
   */
  assetsManifest: string;
  /**
   * The entry key in the Vite manifest (the HTML entry file).
   * @default 'index.html'
   */
  entryPoint?: string;
  /**
   * Cache-control header configuration.
   * @default { default: 'no-store' }
   */
  cacheControl?: SsrCacheControl;
  /**
   * URL path prefixes to always exclude from SSR.
   * Requests matching these prefixes call next() immediately without
   * consulting the resolver. API routes are automatically excluded.
   *
   * Automatic exclusions (always applied, cannot be overridden):
   * - `/api/` — slingshot API routes
   * - `/_slingshot/` — internal framework routes
   * - Any request with `Upgrade: websocket` header
   *
   * @example `['/admin', '/webhooks']`
   */
  exclude?: readonly string[];
  /**
   * Dev mode flag. When true, skips reading the asset manifest and injects
   * the Vite dev client script instead.
   *
   * Automatically inferred from `process.env.NODE_ENV === 'development'`
   * when not provided.
   */
  devMode?: boolean;
  /**
   * ISR (Incremental Static Regeneration) configuration.
   *
   * When set, loaders returning `revalidate: N` cause the rendered HTML to be
   * stored in the cache adapter. Subsequent requests are served from cache
   * until stale, then regenerated in the background (stale-while-revalidate).
   *
   * Set `isr: {}` to use the default in-memory adapter (single-instance).
   * Provide `adapter: createRedisIsrCache(redis)` for distributed deployments.
   *
   * @example Memory adapter (default)
   * ```ts
   * createSsrPlugin({ ..., isr: {} })
   * ```
   *
   * @example Redis adapter
   * ```ts
   * import { createRedisIsrCache } from '@lastshotlabs/slingshot-ssr/isr';
   * createSsrPlugin({ ..., isr: { adapter: createRedisIsrCache(redis) } })
   * ```
   */
  readonly isr?: IsrConfig;
  /**
   * Absolute path to the SSG output directory produced by `slingshot ssg`.
   *
   * When set, the SSR middleware checks for a pre-rendered `.html` file at
   * `{staticDir}/{pathname}/index.html` before invoking the renderer. On a
   * cache hit the file is served directly with
   * `Cache-Control: public, max-age=31536000, immutable` — the renderer is
   * never called for that request.
   *
   * Set this to the same path passed to `slingshot ssg --out`.
   *
   * @example `import.meta.dir + '/dist/static'`
   */
  staticDir?: string;
  /**
   * Trusted origin hostnames for server action CSRF protection.
   *
   * Requests to `POST /_snapshot/action` whose `Origin` header hostname is not
   * in this list are rejected with 403. Same-origin requests (matching the
   * request host, or no `Origin` header) are always allowed.
   *
   * @default [] (same-origin only)
   * @example `['app.example.com', 'staging.example.com']`
   */
  readonly trustedOrigins?: readonly string[];
  /**
   * Absolute path to the directory containing server action modules.
   *
   * Module names from `POST /_snapshot/action` requests are resolved relative
   * to this directory. For example, module name `"posts"` resolves to
   * `{serverActionsDir}/posts` (Bun resolves `.ts`/`.js` automatically).
   *
   * @default `process.cwd() + '/server/actions'`
   */
  readonly serverActionsDir?: string;

  /**
   * Runtime implementation override for file I/O in the SSR plugin.
   *
   * When provided, the SSR plugin uses `runtime.readFile()` for all file reads
   * (static HTML serving from `staticDir`, asset manifest reading). This enables
   * edge runtime deployments (Cloudflare Workers, Deno Deploy) that have no access
   * to the host filesystem.
   *
   * When omitted, the plugin falls back to Node.js/Bun filesystem APIs (`node:fs`).
   * The Bun runtime's `Bun.file()` API is used automatically when running on Bun.
   *
   * Provide `edgeRuntime()` from `@lastshotlabs/slingshot-runtime-edge` for edge deployments.
   *
   * @example Edge deployment
   * ```ts
   * import { edgeRuntime } from '@lastshotlabs/slingshot-runtime-edge';
   *
   * createSsrPlugin({
   *   runtime: edgeRuntime({
   *     fileStore: (path) => env.ASSETS.fetch(path).then(r => r.ok ? r.text() : null),
   *   }),
   *   // ...
   * });
   * ```
   */
  readonly runtime?: SlingshotRuntime;
  /**
   * Secret token for draft mode enable endpoint.
   *
   * When set, the SSR plugin mounts `GET /api/draft/enable` and
   * `GET /api/draft/disable` endpoints. The enable endpoint requires the caller
   * to supply `?secret=<draftModeSecret>` — requests with a mismatched or absent
   * secret receive 401.
   *
   * Set this to a long random string and keep it out of client-side code.
   * A good approach is to read it from an environment variable:
   * `draftModeSecret: process.env.DRAFT_MODE_SECRET`.
   *
   * When omitted, the draft mode endpoints are not registered.
   *
   * @example
   * ```ts
   * createSsrPlugin({
   *   renderer,
   *   serverRoutesDir,
   *   assetsManifest,
   *   draftModeSecret: process.env.DRAFT_MODE_SECRET,
   * })
   * ```
   */
  readonly draftModeSecret?: string;
  /**
   * Maximum byte length of a single decoded route param value.
   *
   * Requests whose dynamic-segment values exceed this cap (after URL decoding)
   * are rejected with HTTP 414 URI Too Long before any loader runs. Guards
   * against pathological URLs that would otherwise pass the resolver and reach
   * loader/database code.
   *
   * @default 2048
   */
  readonly maxRouteParamBytes?: number;
  /**
   * Strategy for client-side hydration mismatch reporting.
   *
   * Hydration mismatches occur when the SSR-produced HTML differs from the
   * tree the client renders on first mount — usually caused by non-deterministic
   * data sources (e.g. `Date.now()`, `Math.random()`, locale-dependent format).
   * `slingshot-ssr` cannot detect these server-side; React reports them in
   * the browser console.
   *
   * - `'warn-dev'` — (default) emit a `console.warn` from the SSR middleware
   *   in development mode noting that hydration mismatch warnings should
   *   appear in the browser console. Production renders are unaffected.
   * - `'silent'`   — opt out of all framework-side warnings. The application
   *   is responsible for detecting and reporting mismatches.
   *
   * Either way, mismatches surface in the browser via React's built-in
   * warnings — this flag only affects the framework's nudge.
   *
   * @default 'warn-dev'
   */
  readonly hydrationMismatchHandling?: 'warn-dev' | 'silent';
}
