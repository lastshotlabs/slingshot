// packages/slingshot-ssr/src/config.schema.ts
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { IsrCacheAdapter } from './isr/types';
import type { NavigationConfig, PageDeclaration } from './pageDeclarations';

/**
 * Zod schema for {@link SsrCacheControl}.
 * @internal
 */
export const ssrCacheControlSchema = z.object({
  default: z
    .string()
    .optional()
    .describe(
      'Default Cache-Control header value applied to SSR responses. Omit to leave cache-control unset by default.',
    ),
  routes: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Per-route Cache-Control header overrides keyed by route pattern. Omit to use the default cache-control value for every route.',
    ),
});

/**
 * Zod schema for {@link IsrConfig}.
 *
 * The `adapter` field accepts any object satisfying `IsrCacheAdapter` —
 * validated structurally at runtime via `z.custom`. The schema does not
 * inspect the adapter's internals; type correctness is enforced by TypeScript.
 *
 * @internal
 */
export const isrConfigSchema = z
  .object({
    adapter: z
      .custom<IsrCacheAdapter>()
      .optional()
      .describe('Incremental static regeneration cache adapter. Omit to disable ISR caching.'),
    backgroundRegenTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum milliseconds to wait for a background ISR regeneration before abandoning it. Default: 30000.',
      ),
    maxConcurrentRegenerations: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum number of concurrent in-flight background regenerations per cache instance. Excess regen requests are dropped (logged as warn) so flaky stale traffic cannot exhaust resources. Default: 32.',
      ),
    cacheFlushTimeoutMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Maximum milliseconds to wait for in-flight ISR cache writes to settle during dispose(). Default: 5000.',
      ),
  })
  .optional();

/**
 * Zod schema for {@link SsrPluginConfig}.
 *
 * Used by `createSsrPlugin()` to validate config at construction time.
 * Exported so callers can pre-validate before passing in, or use it to
 * generate JSON Schema for tooling.
 *
 * @internal
 */
export const ssrPluginConfigSchema = z.object({
  renderer: z
    .object({
      resolve: z
        .function()
        .describe('Renderer function that resolves a page declaration into renderable state.'),
      render: z
        .function()
        .describe('Renderer function that renders a resolved page into an HTTP response payload.'),
      // Phase 25: renderChain is required when layouts are used. Validated at runtime
      // rather than schema time because not all renderers need it (manifest renderer
      // stubs it). The middleware dispatches chain.layouts.length > 0 → renderChain.
      renderChain: z
        .function()
        .optional()
        .describe(
          'Renderer function for layout chains. Omit when the renderer does not support layouts.',
        ),
      renderPage: z
        .function()
        .optional()
        .describe(
          'Renderer function for direct page rendering. Omit when the renderer handles rendering through render or renderChain only.',
        ),
    })
    .describe('Renderer implementation used by the SSR plugin.'),
  pages: z
    .record(z.string(), z.custom<PageDeclaration>())
    .optional()
    .describe(
      'Page declarations owned directly by the SSR plugin. Omit to render only manifest or externally supplied pages.',
    ),
  navigation: z
    .custom<NavigationConfig>()
    .optional()
    .describe(
      'Navigation configuration passed through to the renderer. Omit to render without plugin-level navigation config.',
    ),
  serverRoutesDir: z
    .string()
    .min(1, 'serverRoutesDir must be a non-empty path')
    .refine(isAbsolute, { message: 'serverRoutesDir must be an absolute path' })
    .describe('Absolute path to the directory containing SSR server route modules.'),
  assetsManifest: z
    .string()
    .min(1, 'assetsManifest must be a non-empty path')
    .describe('Path to the client assets manifest used to resolve bundled assets.'),
  entryPoint: z
    .string()
    .optional()
    .describe(
      'Explicit SSR entry module path. Omit to let the plugin resolve its default entrypoint.',
    ),
  cacheControl: ssrCacheControlSchema
    .optional()
    .describe(
      'Cache-Control header configuration for SSR responses. Omit to leave cache-control handling at the renderer or server default.',
    ),
  exclude: z
    .array(z.string())
    .optional()
    .describe('Route patterns the SSR plugin should skip. Omit to evaluate every request path.'),
  devMode: z
    .boolean()
    .optional()
    .describe(
      'Whether the SSR plugin should run in development mode. Omit to use the runtime default.',
    ),
  staticDir: z
    .string()
    .optional()
    .describe(
      'Directory of static assets served alongside SSR routes. Omit to use the renderer or app default.',
    ),
  isr: isrConfigSchema.describe(
    'Incremental static regeneration configuration. Omit to disable ISR.',
  ),
  /**
   * Trusted origins for server action CSRF protection.
   * Values must be full origins (e.g. `'https://app.example.com'`), not bare hostnames.
   * Requests whose Origin header does not match the server origin and is not in this list are rejected with 403.
   * @default []
   */
  trustedOrigins: z
    .array(
      z.string().refine(
        val => {
          try {
            const u = new URL(val);
            return (u.protocol === 'http:' || u.protocol === 'https:') && u.pathname === '/';
          } catch {
            return false;
          }
        },
        {
          message:
            "Each trustedOrigin must be a full HTTP/HTTPS origin, e.g. 'https://app.example.com'",
        },
      ),
    )
    .optional()
    .describe(
      "Additional trusted origins for server action CSRF checks. Must be full HTTP/HTTPS origins (e.g. 'https://app.example.com'). Omit to trust only the server origin.",
    ),
  /**
   * Absolute path to the directory containing server action modules.
   * @default process.cwd() + '/server/actions'
   */
  serverActionsDir: z
    .string()
    .refine(isAbsolute, { message: 'serverActionsDir must be an absolute path' })
    .optional()
    .describe(
      "Absolute path to the directory containing server action modules. Omit to use process.cwd() + '/server/actions'.",
    ),
  /**
   * Runtime implementation override for file I/O.
   * Validated structurally — any object satisfying SlingshotRuntime is accepted.
   */
  runtime: z
    .custom<import('@lastshotlabs/slingshot-core').SlingshotRuntime>()
    .optional()
    .describe(
      'Runtime file-system implementation override used by the SSR plugin. Omit to use the default runtime.',
    ),
  /**
   * Secret token for draft mode enable endpoint.
   *
   * When set, the SSR plugin mounts `GET /api/draft/enable` and
   * `GET /api/draft/disable`. The enable endpoint validates `?secret=` against
   * this value. When omitted, the draft mode endpoints are not registered.
   */
  draftModeSecret: z
    .string()
    .optional()
    .describe(
      'Secret required to enable or disable draft mode endpoints. Omit to disable draft mode endpoints.',
    ),
  /**
   * Maximum byte length of a single decoded route param value.
   *
   * Requests with route params exceeding this cap are rejected with 414 URI
   * Too Long. Default: 2048 bytes per param.
   */
  maxRouteParamBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum byte length of a single decoded route param. Requests exceeding the cap return 414. Default: 2048.',
    ),
  hydrationMismatchHandling: z
    .enum(['warn-dev', 'silent'])
    .optional()
    .describe(
      "Hydration mismatch reporting strategy. 'warn-dev' emits a console.warn in dev mode reminding developers to watch the browser console; 'silent' disables the nudge. Default: 'warn-dev'.",
    ),
  logger: z
    .custom<import('@lastshotlabs/slingshot-core').Logger>()
    .optional()
    .describe(
      'Structured logger used for ISR background regen and response stream diagnostics. Omit to fall back to console output.',
    ),
  onStreamError: z
    .function()
    .optional()
    .describe(
      'Callback invoked when the response body stream errors during pipeTo. Receives error and request metadata for metrics wiring.',
    ),
  /**
   * Circuit breaker for external rendering dependencies.
   *
   * When configured, the SSR middleware wraps renderer calls in a circuit breaker
   * that opens after `failureThreshold` consecutive failures and stays open for
   * `cooldownMs` milliseconds before allowing a probe. While open, renderer calls
   * are short-circuited and fall through to the SPA with a logged warning.
   *
   * Omit to disable the circuit breaker (default).
   */
  circuitBreaker: z
    .object({
      failureThreshold: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Consecutive failures before the circuit opens. Default: 5.'),
      cooldownMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Milliseconds before transitioning from OPEN to HALF_OPEN. Default: 30000.'),
    })
    .optional()
    .describe('Circuit breaker configuration for renderer dependency isolation.'),
  /**
   * Retry configuration for page load failures.
   *
   * When configured, renderer calls that fail with retryable errors are retried
   * with exponential backoff up to `maxAttempts` additional attempts. Non-retryable
   * errors (determined by the renderer or by inspecting the error) are thrown
   * immediately.
   *
   * Omit to disable automatic retries (default).
   */
  pageLoadRetry: z
    .object({
      maxAttempts: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Maximum retry attempts for page load failures. Default: 2.'),
      baseDelayMs: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Base delay in ms for exponential backoff. Default: 200.'),
    })
    .optional()
    .describe('Retry configuration for page load failures.'),
});
