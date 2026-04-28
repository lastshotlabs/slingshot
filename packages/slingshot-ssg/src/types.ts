// packages/slingshot-ssg/src/types.ts

import type { Logger } from '@lastshotlabs/slingshot-core';

// Re-export the static paths function type from slingshot-ssr so consumers of
// slingshot-ssg don't need a direct slingshot-ssr import for this type.
export type { SsgStaticPathsFn } from '@lastshotlabs/slingshot-ssr';

/**
 * Configuration for the SSG crawler and renderer.
 *
 * All paths must be absolute. Relative paths will produce incorrect output.
 *
 * @example
 * ```ts
 * const config: SsgConfig = Object.freeze({
 *   serverRoutesDir: import.meta.dir + '/server/routes',
 *   assetsManifest: import.meta.dir + '/dist/client/.vite/manifest.json',
 *   outDir: import.meta.dir + '/dist/static',
 *   concurrency: 4,
 * })
 * ```
 */
export interface SsgConfig {
  /** Absolute path to the server routes directory. */
  readonly serverRoutesDir: string;
  /** Absolute path to the Vite client manifest (e.g. dist/client/.vite/manifest.json). */
  readonly assetsManifest: string;
  /**
   * Absolute path to the output directory for pre-rendered `.html` files.
   * @default 'dist/static'
   */
  readonly outDir: string;
  /**
   * Maximum number of pages to render in parallel.
   * @default 4
   */
  readonly concurrency?: number;
  /**
   * The Vite manifest key for the client entry chunk (i.e. the value of the
   * `input` option passed to Vite for the browser build). Only assets from
   * this chunk are injected into pre-rendered pages.
   *
   * Checked in order against common conventions when omitted:
   * `src/client/main.ts`, `src/client/main.tsx`, `src/client/index.ts`,
   * `src/client/index.tsx`.
   *
   * @example 'src/client/main.ts'
   */
  readonly clientEntry?: string;
  /**
   * Maximum milliseconds that `staticPaths()` / `generateStaticParams()` may run
   * before the build fails. Default: 60000.
   */
  readonly staticPathsTimeoutMs?: number;
  /**
   * Maximum number of route parameter sets a single dynamic route may return.
   * Protects builds from unbounded `staticPaths()` / `generateStaticParams()`
   * output. Default: 10000.
   */
  readonly maxStaticPathsPerRoute?: number;
  /**
   * Maximum milliseconds a single page render may take before it is recorded
   * as failed so the rest of the batch can continue. Default: 60000.
   * Set to 0 to disable.
   */
  readonly renderPageTimeoutMs?: number;
  /**
   * Optional structured logger used by the crawler and renderer for
   * diagnostics (skipped routes, mid-crawl directory removal, per-page
   * errors). Omit to default to a noop logger.
   */
  readonly logger?: Logger;
}

/**
 * P-SSG-5: serializable per-page error placeholder included in {@link SsgPageResult}
 * so the build summary lists each failure with structured fields rather than
 * just emitting them as `console.error` lines. Consumers (CI dashboards,
 * automated PR comments) can iterate `result.pages` and route the failures
 * without scraping stderr.
 */
export interface SsgPageError {
  /** Error.message string from the underlying failure. */
  readonly message: string;
  /** Error.name string, e.g. "Error", "TimeoutError". */
  readonly name: string;
  /** Optional stack trace; present when the underlying error provided one. */
  readonly stack?: string;
  /** The route path the failure was associated with. */
  readonly route: string;
}

/**
 * Result for a single pre-rendered page.
 */
export interface SsgPageResult {
  /** The URL path that was rendered (e.g. `/posts/hello-world`). */
  readonly path: string;
  /** Absolute path to the `.html` file written to disk. */
  readonly filePath: string;
  /** Wall-clock time taken to render and write this page, in milliseconds. */
  readonly durationMs: number;
  /**
   * Set when rendering this page failed.
   * Other pages continue rendering even when one fails.
   */
  readonly error?: Error;
  /**
   * P-SSG-5: structured error placeholder mirroring {@link error} for callers
   * that need a serializable summary (CI tooling, JSON log sinks). Present
   * iff `error` is set; the same `route` value as `path`.
   */
  readonly errorDetail?: SsgPageError;
}

/**
 * Aggregate result for a full SSG run.
 */
export interface SsgResult {
  /** Per-page results, in the order pages were completed. */
  readonly pages: readonly SsgPageResult[];
  /** Total wall-clock duration for the entire run, in milliseconds. */
  readonly durationMs: number;
  /** Number of pages that rendered successfully. */
  readonly succeeded: number;
  /** Number of pages that failed. */
  readonly failed: number;
}
