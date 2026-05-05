// packages/slingshot-ssr/src/index.ts

/** Core renderer, loader, ISR, draft-mode, and page-contract types for `createSsrPlugin()`. */
export type {
  SsrLoadContext,
  SsrLoadResult,
  SsrRedirectResult,
  SsrNotFoundResult,
  SsrForbiddenResult,
  SsrUnauthorizedResult,
  SsrLoaderReturn,
  SsrQueryCacheEntry,
  SsrMeta,
  PageLoaderResult,
  SsrRouteMatch,
  SsrShell,
  IsrSink,
  SlingshotSsrRenderer,
  SsrPluginConfig,
  SsrCacheControl,
  SsgStaticPathsFn,
  IsrCacheAdapter,
  IsrCacheEntry,
  IsrConfig,
  // Phase 25: Nested layouts
  SsrLayoutProps,
  SsrRouteChain,
  // Phase 26: Parallel routes
  SsrParallelSlot,
  // Phase 29: SSR middleware
  SsrMiddlewareContext,
  SsrMiddlewareResult,
  // Static params (generateStaticParams feature)
  StaticParamSet,
  GenerateStaticParams,
  DefineRouteOptions,
} from './types';

/** Type guards and route declaration helpers used by SSR route modules. */
export {
  isRedirect,
  isNotFound,
  isLoadResult,
  isForbidden,
  isUnauthorized,
  defineRoute,
} from './types';

/** Build the SSR plugin that mounts route resolution, rendering, metadata, and ISR behavior. */
export { createSsrPlugin } from './plugin';

/** Error thrown when the client asset manifest cannot be read or parsed. */
export { SsrAssetManifestError } from './assets';
/**
 * Provider-owned package contract for cross-package consumers (server actions,
 * route handlers) that need to invalidate ISR cache entries.
 */
export { Ssr, IsrInvalidatorsCap } from './public';

/** Resolve SSR route trees, nested page chains, and page declarations from the file system. */
export {
  resolveGlobalMiddlewarePath,
  resolveRouteChain,
  initRouteTree,
  invalidateRouteTree,
  RouteParamTooLargeError,
  isRouteParamTooLargeError,
  DEFAULT_MAX_ROUTE_PARAM_BYTES,
} from './resolver';
/**
 * Execute a file-based route module — the canonical helper for renderers.
 * Handles the dynamic import, `load()`, and `meta()` dance so individual
 * `SlingshotSsrRenderer` implementations don't have to.
 */
export {
  executeRouteModule,
  loadRouteModule,
  clearRouteModuleCache,
  type RouteExecution,
} from './routeExecution';
/** Build page-route lookup tables and resolved page chains for file-based SSR apps. */
export { buildPageRouteTable, buildPageChain, resolvePageDeclaration } from './pageResolver';
/** Expand `generateStaticParams` exports into concrete route entries at build time. */
export { generatePageStaticParams } from './static-params/pageStaticParams';
/** Load SSR page modules and surface the error thrown when a page module is missing. */
export { resolvePageLoader, PageNotFoundError, validatePageAdapters } from './pageLoaders';

/** Page declaration and navigation types used by the page-based SSR surface. */
export type {
  SerializableHandlerRef,
  PageTitleField,
  PageTitleTemplate,
  PagePermissionConfig,
  PageDeclarationBase,
  PageFilterConfig,
  EntityListPageDeclaration,
  PageDetailSection,
  PageRelatedSection,
  EntityDetailPageDeclaration,
  PageFieldOverride,
  EntityFormPageDeclaration,
  PageStatConfig,
  PageChartConfig,
  EntityDashboardPageDeclaration,
  CustomPageDeclaration,
  PageDeclaration,
  NavigationBadgeConfig,
  NavigationItem,
  NavigationConfig,
  EntityFieldMeta,
  EntityMeta,
  PageData,
  ResolvedPageDeclaration,
} from './pageDeclarations';

// ─── After callbacks ──────────────────────────────────────────────────────────

/** Register and drain after-render callbacks that need SSR route context. */
export { withAfterContext, buildAfterFn, drainAfterCallbacks } from './after/index';

// ─── Metadata routes ──────────────────────────────────────────────────────────

/** Register sitemap, robots, and related metadata routes for an SSR app. */
export { registerMetadataRoutes } from './metadata/index';
/** Sitemap and robots configuration types used by metadata route registration. */
export type { SitemapEntry, RobotsConfig } from './metadata/index';

// ─── Draft mode ───────────────────────────────────────────────────────────────

/** Draft-mode status types and helpers for previewing unpublished SSR content. */
export type { DraftModeStatus } from './draft/index';
/** Draft-mode cookie constant and request helpers for preview flows. */
export { DRAFT_MODE_COOKIE, draftMode, withDraftContext, isDraftRequest } from './draft/index';

// ─── PPR (Partial Prerendering) ───────────────────────────────────────────────

/**
 * Build-time PPR shell pre-computation.
 *
 * Call after the Vite build (at server startup) to pre-render static shells for
 * all PPR-enabled routes listed in `ppr-routes.json`. Shells are stored in the
 * provided `PprCache` (from `@lastshotlabs/snapshot/ssr`) and served instantly
 * at request time via `renderPprPage()`.
 */
export { prerenderPprShells } from './ppr/index';

/**
 * Descriptor for a PPR-enabled route passed to `prerenderPprShells()`.
 */
export type { PprRouteDescriptor } from './ppr/index';

/**
 * Structural equivalent of `PprCache` from `@lastshotlabs/snapshot/ssr`.
 * Accepted by `prerenderPprShells()` so that slingshot-ssr never imports snapshot directly.
 */
export type { PprCacheShape } from './ppr/index';

// ─── Static params (generateStaticParams feature) ────────────────────────────

/**
 * A route that exports `generateStaticParams` together with the param sets it
 * returned when called at build time.
 *
 * Produced by `scanStaticParams()` in `@lastshotlabs/slingshot-ssr/static-params`.
 */
export type { StaticRoute } from './static-params/index';

// ─── Circuit breaker ───────────────────────────────────────────────────────────

/**
 * Circuit breaker for external rendering dependencies.
 */
export { createCircuitBreaker } from './circuitBreaker';
/**
 * Circuit breaker types.
 */
export type {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitState,
  CircuitResult,
} from './circuitBreaker';

// ─── Retry logic ───────────────────────────────────────────────────────────────

/**
 * Retry with exponential backoff for page load failures.
 */
export { retry } from './retry';
/**
 * Retry types.
 */
export type { RetryOptions } from './retry';
