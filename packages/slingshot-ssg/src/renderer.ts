// packages/slingshot-ssg/src/renderer.ts
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PathTraversalError, createConsoleLogger, deepFreeze, safeJoin } from '@lastshotlabs/slingshot-core';
import type { SlingshotSsrRenderer, SsrShell } from '@lastshotlabs/slingshot-ssr';
import { resolveRouteChain } from '@lastshotlabs/slingshot-ssr';
import {
  type SsgCircuitBreaker,
  SsgCircuitOpenError,
  createSsgCircuitBreaker,
} from './circuitBreaker';
import type { SsgConfig, SsgPageResult, SsgResult } from './types';

const logger = createConsoleLogger({ base: { component: 'slingshot-ssg' } });

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_RENDER_PAGE_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 1;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

class SsgPluginStateMap extends Map<string, unknown> {
  set(): this {
    throw new Error('[slingshot-ssg] pluginState is read-only during static generation');
  }

  delete(): boolean {
    throw new Error('[slingshot-ssg] pluginState is read-only during static generation');
  }

  clear(): void {
    throw new Error('[slingshot-ssg] pluginState is read-only during static generation');
  }
}

function writeFileAtomicSync(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = join(
    dirname(filePath),
    `.${filePath.split('/').pop() ?? 'index.html'}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileSync(tmpPath, contents, 'utf8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Internal: execute a single render attempt, wrapping with timeout.
 *
 * Returns a `SsgPageResult` regardless of success or failure — the result
 * carries an `error` field when the attempt failed.
 */
async function executeRenderAttempt(
  urlPath: string,
  renderer: SlingshotSsrRenderer,
  config: SsgConfig,
  assetTagsHtml: string,
  attemptStart: number,
  filePath: string,
): Promise<SsgPageResult> {
  const renderPromise = renderSsgPageUnchecked(
    urlPath,
    renderer,
    config,
    assetTagsHtml,
    attemptStart,
    filePath,
  );
  const timeoutMs = config.renderPageTimeoutMs ?? DEFAULT_RENDER_PAGE_TIMEOUT_MS;
  if (timeoutMs <= 0) return renderPromise;
  return withPageTimeout(renderPromise, urlPath, filePath, attemptStart, timeoutMs);
}

/**
 * Determine whether an error from the render pipeline is potentially transient
 * and worth retrying.
 *
 * Non-transient errors:
 * - Non-200 HTTP response (redirect, 404, 500 — semantic decision by renderer)
 * - No route matched (route doesn't exist, won't exist on retry)
 * - File write failure (filesystem issue unlikely to resolve in ms)
 *
 * Everything else (renderer throws, timeout, circuit open) is considered
 * transient and eligible for retry.
 */
function isTransientError(error: Error): boolean {
  const msg = error.message;
  if (msg.includes('Renderer returned HTTP')) return false;
  if (msg.includes('No route matched')) return false;
  if (msg.includes('Failed to write')) return false;
  return true;
}

/**
 * Compute exponential backoff delay with jitter.
 *
 * delay = min(baseDelayMs * 2^(attempt-1), maxDelayMs)
 * jitter = delay * (0.75 + random * 0.5)
 */
function calculateBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
  const jitter = delay * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Internal render function that supports retry and circuit breaker.
 *
 * Exposed as the implementation behind both the public `renderSsgPage` and
 * `renderSsgPages` APIs so the circuit breaker (created once per batch) is
 * shared across all pages.
 */
async function renderSsgPageInternal(
  urlPath: string,
  renderer: SlingshotSsrRenderer,
  config: SsgConfig,
  assetTagsHtml: string,
  breaker?: SsgCircuitBreaker,
): Promise<SsgPageResult> {
  const start = Date.now();
  let filePath: string;
  try {
    filePath = resolveOutputPath(urlPath, config.outDir);
  } catch (err) {
    // Reject malicious or malformed URL paths (path traversal, NUL byte, etc.)
    // before any rendering occurs. The page is recorded as failed so the build
    // surfaces it in the summary instead of silently writing outside outDir.
    if (err instanceof PathTraversalError) {
      const error = new Error(`[slingshot-ssg] rejected URL path "${urlPath}": ${err.message}`);
      logger.warn(error.message);
      return makeFailedResult(urlPath, '', start, error);
    }
    throw err;
  }

  const maxAttempts = config.retry?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
  const baseDelayMs = config.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maxDelayMs = config.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now();

    try {
      // Define the render function, optionally guarded by the circuit breaker
      const attemptFn = async (): Promise<SsgPageResult> =>
        executeRenderAttempt(urlPath, renderer, config, assetTagsHtml, attemptStart, filePath);

      let result: SsgPageResult;
      if (breaker) {
        result = await breaker.guard(attemptFn);
      } else {
        result = await attemptFn();
      }

      // Success
      if (!result.error) return result;

      // Non-transient error — don't retry
      if (!isTransientError(result.error) || attempt >= maxAttempts) {
        return result;
      }

      // Transient error — backoff and retry
      const delay = calculateBackoff(attempt, baseDelayMs, maxDelayMs);
      console.log(
        `[slingshot-ssg] Retry ${attempt}/${maxAttempts - 1} for "${urlPath}" ` +
          `in ${delay}ms (${result.error.message})`,
      );
      await sleep(delay);
    } catch (err) {
      if (err instanceof SsgCircuitOpenError) {
        if (attempt >= maxAttempts) {
          const error = new Error(
            `[slingshot-ssg] Circuit breaker tripped for "${urlPath}" ` +
              `after ${attempt} attempt(s)`,
          );
          return makeFailedResult(urlPath, filePath, attemptStart, error);
        }
        // Wait for cooldown then retry
        const delay = Math.min(err.retryAfterMs + 100, maxDelayMs);
        console.log(
          `[slingshot-ssg] Circuit breaker open, waiting ${delay}ms ` +
            `before retry ${attempt + 1}/${maxAttempts} for "${urlPath}"`,
        );
        await sleep(delay);
        continue;
      }

      // Infrastructure error (not wrapped in SsgPageResult)
      if (attempt >= maxAttempts) {
        const error = err instanceof Error ? err : new Error(String(err));
        return makeFailedResult(urlPath, filePath, attemptStart, error);
      }

      const delay = calculateBackoff(attempt, baseDelayMs, maxDelayMs);
      await sleep(delay);
    }
  }

  // TypeScript exhaustiveness guard — the loop always returns.
  throw new Error('[slingshot-ssg] Retry loop exhausted unexpectedly');
}

/**
 * Render a single URL path to a static HTML file.
 *
 * Preferred path: resolves the full file-based route chain via
 * `resolveRouteChain()` and renders with `renderer.renderChain()`, faithfully
 * reproducing the SSR pipeline (layouts, slots, interception, middleware).
 *
 * Fallback path: when no file-based chain is found (e.g. custom renderer with
 * manifest-driven routing), falls back to `renderer.resolve()` + `render()`.
 *
 * The rendered HTML is written to `config.outDir/{path}/index.html`. When the
 * renderer returns a non-200 response (redirect, 404, etc.) the page is skipped
 * and a warning is logged. `SsgPageResult.error` will be set.
 *
 * Transient failures (timeout, renderer throws) are retried automatically
 * according to `config.retry`.
 *
 * @param urlPath        - The URL path to render (e.g. `/posts/hello-world`).
 * @param renderer       - An initialised `SlingshotSsrRenderer`.
 * @param config         - Frozen SSG configuration.
 * @param assetTagsHtml  - Pre-resolved Vite asset tag HTML to inject in the shell.
 * @returns A `SsgPageResult` describing the outcome.
 */
export async function renderSsgPage(
  urlPath: string,
  renderer: SlingshotSsrRenderer,
  config: SsgConfig,
  assetTagsHtml: string = '',
): Promise<SsgPageResult> {
  return renderSsgPageInternal(urlPath, renderer, config, assetTagsHtml);
}

async function renderSsgPageUnchecked(
  urlPath: string,
  renderer: SlingshotSsrRenderer,
  config: SsgConfig,
  assetTagsHtml: string,
  start: number,
  filePath: string,
): Promise<SsgPageResult> {
  const url = new URL(urlPath, 'http://localhost');

  // Build a minimal stub — satisfies the SlingshotContext structural contract at
  // runtime without importing slingshot-core (which is not a dependency of this
  // package). Renderers that call bsCtx.db at build time will fail and the page
  // will be recorded as failed rather than producing broken output.
  // The cast boundary is acceptable per Rule 5: opaque peer-dep boundary.
  const bsCtxStub = Object.freeze({
    pluginState: new SsgPluginStateMap(),
  }) as unknown as Parameters<SlingshotSsrRenderer['resolve']>[1];

  const shell: SsrShell = {
    headTags: '',
    assetTags: assetTagsHtml,
    nonce: undefined,
  };

  // ── Prefer file-based chain pipeline (layouts, slots, middleware) ────────────
  // resolveRouteChain() mirrors what the SSR middleware does at request time:
  // it resolves the full chain including layouts, slots, interception routes, and
  // the per-route middleware file. renderChain() then executes the full pipeline.
  // Falling back to resolve()+render() only when no file-based match is found.
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    query[k] = v;
  });

  const rawChain = resolveRouteChain(urlPath, config.serverRoutesDir);

  if (rawChain) {
    const hydratedPage = { ...rawChain.page, url, query };
    const hydratedLayouts = rawChain.layouts.map(l => ({ ...l, url, query }));
    const chain = deepFreeze({
      ...rawChain,
      page: hydratedPage,
      layouts: hydratedLayouts,
    });

    let response: Response;
    try {
      response = await renderer.renderChain(chain, shell, bsCtxStub);
    } catch (err) {
      const error = toError(err);
      logger.warn(`[slingshot-ssg] renderChain() failed for ${urlPath}:`, error.message);
      return makeFailedResult(urlPath, filePath, start, error);
    }

    if (response.status !== 200) {
      const error = new Error(
        `Renderer returned HTTP ${response.status} for "${urlPath}" — skipping.`,
      );
      logger.warn(`[slingshot-ssg] ${error.message}`);
      return makeFailedResult(urlPath, filePath, start, error);
    }

    const html = await response.text();
    try {
      writeFileAtomicSync(filePath, html);
    } catch (err) {
      const error = toError(err);
      logger.warn(`[slingshot-ssg] Failed to write ${filePath}:`, error.message);
      return makeFailedResult(urlPath, filePath, start, error);
    }

    const durationMs = Date.now() - start;
    console.log(`[slingshot-ssg] ✓ ${urlPath}  →  ${filePath}  (${durationMs}ms)`);
    return { path: urlPath, filePath, durationMs };
  }
  // ── End chain pipeline ───────────────────────────────────────────────────────

  // Fallback: manifest/config-driven routing via renderer.resolve() + render().
  // Used when there is no file-based route tree (e.g. custom renderer without
  // a serverRoutesDir convention).
  let match: Awaited<ReturnType<SlingshotSsrRenderer['resolve']>>;
  try {
    match = await renderer.resolve(url, bsCtxStub);
  } catch (err) {
    const error = toError(err);
    logger.warn(`[slingshot-ssg] resolve() failed for ${urlPath}:`, error.message);
    return makeFailedResult(urlPath, filePath, start, error);
  }

  if (!match) {
    const error = new Error(`No route matched "${urlPath}" — skipping.`);
    logger.warn(`[slingshot-ssg] ${error.message}`);
    return makeFailedResult(urlPath, filePath, start, error);
  }

  let response: Response;
  try {
    response = await renderer.render(match, shell, bsCtxStub);
  } catch (err) {
    const error = toError(err);
    logger.warn(`[slingshot-ssg] render() failed for ${urlPath}:`, error.message);
    return makeFailedResult(urlPath, filePath, start, error);
  }

  // Skip non-OK responses (redirects, 404, etc.)
  if (response.status !== 200) {
    const error = new Error(
      `Renderer returned HTTP ${response.status} for "${urlPath}" — skipping.`,
    );
    logger.warn(`[slingshot-ssg] ${error.message}`);
    return makeFailedResult(urlPath, filePath, start, error);
  }

  const html = await response.text();

  try {
    writeFileAtomicSync(filePath, html);
  } catch (err) {
    const error = toError(err);
    logger.warn(`[slingshot-ssg] Failed to write ${filePath}:`, error.message);
    return makeFailedResult(urlPath, filePath, start, error);
  }

  const durationMs = Date.now() - start;
  console.log(`[slingshot-ssg] ✓ ${urlPath}  →  ${filePath}  (${durationMs}ms)`);
  return { path: urlPath, filePath, durationMs };
}

/**
 * Run `renderSsgPage` for a list of URL paths with a concurrency limit.
 *
 * Pages are processed in parallel up to `config.concurrency` at a time.
 * Individual page failures do not abort the batch — they are recorded in the
 * returned `SsgResult`.
 *
 * When `config.circuitBreaker` is set, a single circuit breaker is created for
 * the entire run and shared across all pages. If the breaker trips (too many
 * consecutive failures), subsequent pages fail fast without invoking the
 * renderer, protecting upstream services from being hammered.
 *
 * @param paths         - URL paths to render.
 * @param renderer      - An initialised `SlingshotSsrRenderer`.
 * @param config        - Frozen SSG configuration.
 * @param assetTagsHtml - Pre-resolved Vite asset tag HTML string.
 * @returns Aggregate `SsgResult` with per-page details.
 */
export async function renderSsgPages(
  paths: readonly string[],
  renderer: SlingshotSsrRenderer,
  config: SsgConfig,
  assetTagsHtml: string = '',
): Promise<SsgResult> {
  const start = Date.now();

  // Create a shared circuit breaker for the entire run when configured.
  const breaker =
    config.circuitBreaker !== undefined
      ? createSsgCircuitBreaker({
          threshold: config.circuitBreaker.threshold,
          cooldownMs: config.circuitBreaker.cooldownMs,
        })
      : undefined;

  const concurrency = resolveConcurrency(config.concurrency);
  const pages: SsgPageResult[] = [];

  // Process in concurrency-limited batches
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(p => renderSsgPageInternal(p, renderer, config, assetTagsHtml, breaker)),
    );
    pages.push(...results);
  }

  const durationMs = Date.now() - start;
  const succeeded = pages.filter(p => !p.error).length;
  const failed = pages.length - succeeded;

  return deepFreeze({
    pages: [...pages],
    durationMs,
    succeeded,
    failed,
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function withPageTimeout(
  renderPromise: Promise<SsgPageResult>,
  urlPath: string,
  filePath: string,
  start: number,
  timeoutMs: number,
): Promise<SsgPageResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      renderPromise,
      new Promise<SsgPageResult>(resolve => {
        timeout = setTimeout(() => {
          const error = new Error(`SSG render timed out after ${timeoutMs}ms for "${urlPath}"`);
          logger.warn(`[slingshot-ssg] ${error.message}`);
          resolve(makeFailedResult(urlPath, filePath, start, error));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Compute the absolute output file path for a URL path.
 *
 * - `/`            → `{outDir}/index.html`
 * - `/about`       → `{outDir}/about/index.html`
 * - `/posts/foo`   → `{outDir}/posts/foo/index.html`
 *
 * Hardened against path-traversal: a `urlPath` containing `..` segments or a
 * NUL byte (e.g. a malformed manifest route name like `../../etc/passwd`) is
 * rejected via `safeJoin()` rather than silently writing outside `outDir`.
 */
function resolveOutputPath(urlPath: string, outDir: string): string {
  if (urlPath === '/' || urlPath === '') {
    return join(outDir, 'index.html');
  }
  // Strip leading slashes so safeJoin treats the path as relative to outDir.
  // Without this, a urlPath beginning with `/` would resolve from filesystem
  // root and trigger PathTraversalError for legitimate routes like `/about`.
  const relative = normalizeOutputRelativePath(urlPath.replace(/^\/+/, ''));
  const dir = safeJoin(outDir, relative);
  return join(dir, 'index.html');
}

function normalizeOutputRelativePath(relativePath: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch (err) {
    throw new PathTraversalError(
      `malformed URL path encoding: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (const segment of decoded.split(/[\\/]+/)) {
    if (/^\.{3,}$/.test(segment)) {
      throw new PathTraversalError(`suspicious dot segment in path: ${decoded}`);
    }
  }
  return decoded;
}

/**
 * Re-export for tests and callers that want to detect path-traversal
 * rejections explicitly. {@link resolveOutputPath} throws this when a route
 * name escapes `outDir`.
 */
export { PathTraversalError };

function resolveConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 4;
  const normalized = Math.floor(value);
  return normalized >= 1 ? normalized : 1;
}

/** Coerce an unknown thrown value to an Error. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * P-SSG-5: build an SsgPageResult for a failed render with both the legacy
 * `error` field (Error instance) and the new structured `errorDetail`
 * placeholder so the build summary surfaces structured per-page failures.
 */
function makeFailedResult(
  urlPath: string,
  filePath: string,
  start: number,
  error: Error,
): SsgPageResult {
  return {
    path: urlPath,
    filePath,
    durationMs: Date.now() - start,
    error,
    errorDetail: {
      message: error.message,
      name: error.name,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
      route: urlPath,
    },
  };
}
