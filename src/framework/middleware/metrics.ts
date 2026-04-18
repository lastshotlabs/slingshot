import type { MetricsState } from '@framework/metrics/registry';
import {
  defaultNormalizePath,
  incrementCounter,
  observeHistogram,
} from '@framework/metrics/registry';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

export interface MetricsMiddlewareOptions {
  /** Instance-owned metrics registry. */
  state: MetricsState;
  /** Paths to exclude from metrics collection. Strings use prefix matching. */
  excludePaths?: (string | RegExp)[];
  /** Custom path normalizer to prevent cardinality explosion. */
  normalizePath?: (path: string) => string;
}

const DEFAULT_EXCLUDE: (string | RegExp)[] = ['/metrics', '/health', '/docs', '/openapi.json'];

/**
 * Hono middleware that records Prometheus-compatible HTTP metrics for every
 * non-excluded request.
 *
 * Records two metrics per request:
 * - `http_requests_total` — counter labelled by `method`, `path`, `status`,
 *   and optionally `tenant`.
 * - `http_request_duration_seconds` — histogram labelled by `method`, `path`,
 *   and optionally `tenant`.
 *
 * The `normalizePath` function collapses dynamic path segments (e.g. `/users/123`
 * to `/users/:id`) to keep cardinality manageable.  Use a custom `normalizePath`
 * for application-specific path shapes.
 *
 * @param options - Configuration for the metrics collector middleware.
 * @param options.state - Instance-owned `MetricsState` registry.  Each
 *   `createApp()` call supplies its own state — no cross-app pollution.
 * @param options.excludePaths - Paths to skip.  Strings use prefix matching;
 *   RegExp entries use `.test()`.  Defaults to
 *   `["/metrics", "/health", "/docs", "/openapi.json"]`.
 * @param options.normalizePath - Custom path normalizer.  Defaults to
 *   `defaultNormalizePath` which replaces numeric segments with `:id`.
 * @returns A Hono `MiddlewareHandler` that records counters and histograms on
 *   the provided `MetricsState` after each non-excluded request completes.
 *
 * @example
 * ```ts
 * app.use(metricsCollector({
 *   state: metricsState,
 *   excludePaths: ['/health', '/internal'],
 *   normalizePath: path => path.replace(/\/[0-9a-f-]{36}/g, '/:uuid'),
 * }));
 * ```
 */
export const metricsCollector = (options: MetricsMiddlewareOptions): MiddlewareHandler<AppEnv> => {
  const { state, excludePaths = DEFAULT_EXCLUDE, normalizePath = defaultNormalizePath } = options;

  return async (c, next) => {
    const rawPath = c.req.path;
    const excluded = excludePaths.some(p =>
      typeof p === 'string' ? rawPath.startsWith(p) : p.test(rawPath),
    );
    if (excluded) return next();

    const start = performance.now();
    await next();
    const duration = (performance.now() - start) / 1000; // seconds

    const method = c.req.method;
    const path = normalizePath(rawPath);
    const status = String(c.res.status);
    const tenantId = c.get('tenantId') ?? undefined;

    const labels: Record<string, string> = { method, path, status };
    const durationLabels: Record<string, string> = { method, path };
    if (tenantId) {
      labels.tenant = tenantId;
      durationLabels.tenant = tenantId;
    }

    incrementCounter(state, 'http_requests_total', labels);
    observeHistogram(state, 'http_request_duration_seconds', durationLabels, duration);
  };
};
