// packages/slingshot-ssg/src/renderer.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SlingshotSsrRenderer, SsrShell } from '@lastshotlabs/slingshot-ssr';
import { resolveRouteChain } from '@lastshotlabs/slingshot-ssr';
import type { SsgConfig, SsgPageResult, SsgResult } from './types';

// ─── Public API ───────────────────────────────────────────────────────────────

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
  const start = Date.now();
  const filePath = resolveOutputPath(urlPath, config.outDir);
  const url = new URL(urlPath, 'http://localhost');

  // Build a minimal stub — satisfies the SlingshotContext structural contract at
  // runtime without importing slingshot-core (which is not a dependency of this
  // package). Renderers that call bsCtx.db at build time will fail and the page
  // will be recorded as failed rather than producing broken output.
  // The cast boundary is acceptable per Rule 5: opaque peer-dep boundary.
  const bsCtxStub = Object.freeze({ pluginState: new Map() }) as unknown as Parameters<
    SlingshotSsrRenderer['resolve']
  >[1];

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
    const chain = Object.freeze({
      ...rawChain,
      page: hydratedPage,
      layouts: Object.freeze(hydratedLayouts),
    });

    let response: Response;
    try {
      response = await renderer.renderChain(chain, shell, bsCtxStub);
    } catch (err) {
      const error = toError(err);
      console.warn(`[slingshot-ssg] renderChain() failed for ${urlPath}:`, error.message);
      return { path: urlPath, filePath, durationMs: Date.now() - start, error };
    }

    if (response.status !== 200) {
      const error = new Error(
        `Renderer returned HTTP ${response.status} for "${urlPath}" — skipping.`,
      );
      console.warn(`[slingshot-ssg] ${error.message}`);
      return { path: urlPath, filePath, durationMs: Date.now() - start, error };
    }

    const html = await response.text();
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, html, 'utf8');
    } catch (err) {
      const error = toError(err);
      console.warn(`[slingshot-ssg] Failed to write ${filePath}:`, error.message);
      return { path: urlPath, filePath, durationMs: Date.now() - start, error };
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
    console.warn(`[slingshot-ssg] resolve() failed for ${urlPath}:`, error.message);
    return { path: urlPath, filePath, durationMs: Date.now() - start, error };
  }

  if (!match) {
    const error = new Error(`No route matched "${urlPath}" — skipping.`);
    console.warn(`[slingshot-ssg] ${error.message}`);
    return { path: urlPath, filePath, durationMs: Date.now() - start, error };
  }

  let response: Response;
  try {
    response = await renderer.render(match, shell, bsCtxStub);
  } catch (err) {
    const error = toError(err);
    console.warn(`[slingshot-ssg] render() failed for ${urlPath}:`, error.message);
    return { path: urlPath, filePath, durationMs: Date.now() - start, error };
  }

  // Skip non-OK responses (redirects, 404, etc.)
  if (response.status !== 200) {
    const error = new Error(
      `Renderer returned HTTP ${response.status} for "${urlPath}" — skipping.`,
    );
    console.warn(`[slingshot-ssg] ${error.message}`);
    return { path: urlPath, filePath, durationMs: Date.now() - start, error };
  }

  const html = await response.text();

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, html, 'utf8');
  } catch (err) {
    const error = toError(err);
    console.warn(`[slingshot-ssg] Failed to write ${filePath}:`, error.message);
    return { path: urlPath, filePath, durationMs: Date.now() - start, error };
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
  const concurrency = config.concurrency ?? 4;
  const pages: SsgPageResult[] = [];

  // Process in concurrency-limited batches
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(p => renderSsgPage(p, renderer, config, assetTagsHtml)),
    );
    pages.push(...results);
  }

  const durationMs = Date.now() - start;
  const succeeded = pages.filter(p => !p.error).length;
  const failed = pages.length - succeeded;

  return Object.freeze({
    pages: Object.freeze([...pages]),
    durationMs,
    succeeded,
    failed,
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute the absolute output file path for a URL path.
 *
 * - `/`            → `{outDir}/index.html`
 * - `/about`       → `{outDir}/about/index.html`
 * - `/posts/foo`   → `{outDir}/posts/foo/index.html`
 */
function resolveOutputPath(urlPath: string, outDir: string): string {
  if (urlPath === '/' || urlPath === '') {
    return join(outDir, 'index.html');
  }
  return join(outDir, urlPath, 'index.html');
}

/** Coerce an unknown thrown value to an Error. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
