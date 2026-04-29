// packages/slingshot-ssg/src/crawler.ts
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { type Logger, TimeoutError, noopLogger, withTimeout } from '@lastshotlabs/slingshot-core';
import type {
  GenerateStaticParams,
  SsrLoadContext,
  StaticParamSet,
} from '@lastshotlabs/slingshot-ssr';
import type { SsgConfig, SsgStaticPathsFn } from './types';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scans the server routes directory for files that are candidates for static
 * site generation, then returns the full list of URL paths to pre-render.
 *
 * **Detection strategy (in order):**
 * 1. If the route file source contains `export async function staticPaths` or
 *    `export function staticPaths`, the file is a dynamic SSG route.
 *    `staticPaths()` is called to enumerate all parameter combinations and each
 *    combination is expanded into a concrete URL path.
 * 2. If the route file source contains a top-level `export.*revalidate.*false`
 *    pattern (static route, no dynamic segments required), the route URL itself
 *    is returned directly.
 *
 * Source-level detection avoids executing untrusted modules at discovery time.
 * The actual `staticPaths()` function is called via `import()` only for files
 * that passed the source check, limiting the execution surface.
 *
 * @param config - Frozen SSG configuration.
 * @returns Sorted list of URL path strings to pre-render.
 *
 * @example
 * ```ts
 * const paths = await collectSsgRoutes(config)
 * // => ['/posts/hello-world', '/posts/another-post', '/about']
 * ```
 */
export async function collectSsgRoutes(config: SsgConfig): Promise<string[]> {
  const logger: Logger = config.logger ?? noopLogger;
  const routeFiles = await collectRouteFiles(config.serverRoutesDir, logger);
  const paths: string[] = [];
  const staticPathsTimeoutMs = config.staticPathsTimeoutMs ?? 60_000;
  const maxStaticPathsPerRoute = config.maxStaticPathsPerRoute ?? 10_000;

  // P-SSG-1: read sources asynchronously in concurrency-limited batches so a
  // 5k+ route tree does not block the event loop. The previous implementation
  // used readFileSync per file inside a tight loop; with even moderately
  // large route trees that prevented timeouts and progress hooks from firing.
  const sources = new Map<string, string>();
  for (let i = 0; i < routeFiles.length; i += COLLECT_CONCURRENCY) {
    const batch = routeFiles.slice(i, i + COLLECT_CONCURRENCY);
    const settled = await Promise.all(batch.map(p => safeReadSourceAsync(p, logger)));
    for (let j = 0; j < batch.length; j += 1) {
      if (settled[j] !== '') sources.set(batch[j], settled[j]);
    }
    if (i + COLLECT_CONCURRENCY < routeFiles.length) {
      await yieldToEventLoop();
    }
  }

  for (const filePath of routeFiles) {
    const source = sources.get(filePath);
    if (!source) continue;

    const isDynamic = hasDynamicSegments(filePath, config.serverRoutesDir);
    const hasStaticPathsFn = sourceHasStaticPaths(source);
    const hasRevalidateFalse = sourceHasRevalidateFalse(source);

    if (!hasStaticPathsFn && !hasRevalidateFalse) continue;

    if (isDynamic) {
      if (!hasStaticPathsFn) {
        // Dynamic route with revalidate:false but no staticPaths/generateStaticParams — warn and skip.
        logger.warn('ssg.dynamic.skip.no_static_paths', {
          filePath,
          reason:
            'revalidate: false detected but no staticPaths()/generateStaticParams() export found',
        });
        continue;
      }

      // Call staticPaths() to expand all concrete paths for this dynamic route
      const expandedPaths = await callStaticPaths(
        filePath,
        config.serverRoutesDir,
        staticPathsTimeoutMs,
        maxStaticPathsPerRoute,
        logger,
      );
      paths.push(...expandedPaths);
    } else {
      // Static route — derive the URL directly from the file path
      const urlPath = filePathToUrlPath(filePath, config.serverRoutesDir);
      if (urlPath !== null) paths.push(urlPath);
    }
  }

  // Deduplicate and sort for deterministic output
  return [...new Set(paths)].sort();
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Basenames (without extension) that are convention files in Slingshot's file-
 * system router and must never be treated as crawlable page routes.
 *
 * - `meta`       — route metadata side-car
 * - `layout`     — wraps child routes; not a page
 * - `loading`    — suspense fallback; not a page
 * - `error`      — error boundary; not a page
 * - `not-found`  — 404 fallback; not a page
 * - `middleware` — request middleware; not a page
 */
const CONVENTION_BASENAMES = new Set([
  'meta',
  'layout',
  'loading',
  'error',
  'not-found',
  'forbidden',
  'unauthorized',
  'template',
  'middleware',
]);

/**
 * Recursively collect all route `.ts` / `.tsx` / `.js` files in the routes
 * directory. Excludes convention side-car files (meta, layout, loading, error,
 * not-found, middleware).
 */
const COLLECT_CONCURRENCY = 32;

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * P-SSG-3: track per-directory read outcomes so we can distinguish a fully
 * empty crawl (no routes) from an entire route tree that is unreadable. The
 * helper records every read attempt and lets the top-level caller decide
 * whether to fail loudly or continue with partial data.
 */
interface CrawlState {
  readonly logger: Logger;
  /** Number of directories we attempted to read. */
  attemptedReads: number;
  /** Number of directory reads that failed. */
  failedReads: number;
}

async function collectRouteFiles(dir: string, logger: Logger): Promise<string[]> {
  const state: CrawlState = { logger, attemptedReads: 0, failedReads: 0 };
  const results = await collectRouteFilesInner(dir, state);
  if (state.attemptedReads > 0 && state.failedReads === state.attemptedReads) {
    throw new Error(
      `[slingshot-ssg] All ${state.attemptedReads} directory read(s) failed for routes dir "${dir}". ` +
        `Verify the path exists and is readable (e.g. has not been removed or had permissions revoked).`,
    );
  }
  return results;
}

async function collectRouteFilesInner(dir: string, state: CrawlState): Promise<string[]> {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  state.attemptedReads += 1;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err: unknown) {
    // P-SSG-3: catch ENOENT/EACCES per-dir read; on error log structured
    // warning and continue with other dirs. The top-level caller throws when
    // every read fails; otherwise the crawl proceeds with partial results.
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR') {
      state.failedReads += 1;
      state.logger.warn('ssg.crawl.readdir.failed', {
        dir,
        code,
        error: err instanceof Error ? err.message : String(err),
      });
      return results;
    }
    throw err;
  }

  // Process in bounded batches to avoid exhausting file descriptors on large directories.
  for (let i = 0; i < entries.length; i += COLLECT_CONCURRENCY) {
    await Promise.all(
      entries.slice(i, i + COLLECT_CONCURRENCY).map(async entry => {
        const full = join(dir, entry);
        let fileStat;
        try {
          fileStat = await stat(full);
        } catch (err: unknown) {
          // Mid-crawl removal: a dirent we just listed may already be gone
          // (race with `rm`). Treat ENOENT/EACCES on stat() identically to a
          // failed readdir — log and skip so the rest of the tree completes.
          const code =
            typeof err === 'object' && err !== null && 'code' in err
              ? String((err as { code?: unknown }).code)
              : '';
          if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
            state.logger.warn('ssg.crawl.stat.failed', {
              path: full,
              code,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
          throw err;
        }

        if (fileStat.isDirectory()) {
          results.push(...(await collectRouteFilesInner(full, state)));
        } else if (/\.(ts|tsx|js)$/.test(entry)) {
          const basename = entry.replace(/\.(ts|tsx|js)$/, '');
          if (!CONVENTION_BASENAMES.has(basename)) {
            results.push(full);
          }
        }
      }),
    );
  }
  return results.sort();
}

/**
 * P-SSG-1: read the source of a route file asynchronously. Returning an empty
 * string on error keeps the crawler resilient to mid-crawl removals — a
 * missing or unreadable file just gets skipped.
 *
 * Replaces the previous synchronous `readFileSync()` callsite. With large
 * route trees the sync read blocked the event loop for hundreds of ms,
 * preventing the staticPaths timeout and other timer-based safety nets from
 * firing during discovery.
 */
async function safeReadSourceAsync(filePath: string, logger: Logger): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    logger.warn('ssg.crawl.read_source.failed', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

/**
 * Returns `true` when the file path contains a dynamic segment like `[slug]`
 * or a catch-all like `[...rest]`.
 */
function hasDynamicSegments(filePath: string, routesDir: string): boolean {
  const rel = relative(routesDir, filePath);
  return /\[[^\]]+\]/.test(rel);
}

/**
 * Returns `true` when the source text exports a static path enumeration
 * function under either the legacy `staticPaths` name or the Next.js-aligned
 * `generateStaticParams` name.
 *
 * Matches any of:
 * - `export async function staticPaths(`
 * - `export function staticPaths(`
 * - `export const staticPaths`
 * - `export async function generateStaticParams(`
 * - `export function generateStaticParams(`
 * - `export const generateStaticParams`
 */
function sourceHasStaticPaths(source: string): boolean {
  return (
    /export\s+(async\s+)?function\s+staticPaths\b/.test(source) ||
    /export\s+const\s+staticPaths\b/.test(source) ||
    /export\s+(async\s+)?function\s+generateStaticParams\b/.test(source) ||
    /export\s+const\s+generateStaticParams\b/.test(source)
  );
}

/**
 * Returns `true` when the source text contains a `revalidate: false` assignment
 * that suggests SSG intent (top-level export or returned from `load()`).
 *
 * This is a heuristic — not a full AST check. It errs on the side of inclusion:
 * false positives at this stage are harmless (the route won't have `staticPaths`
 * so it'll be treated as a static route and we'll emit one URL for it).
 */
function sourceHasRevalidateFalse(source: string): boolean {
  return /revalidate\s*:\s*false\b/.test(source);
}

function createBuildTimeContext(): SsrLoadContext {
  const injectedBsCtx = (globalThis as Record<string, unknown>)['__ssgBsCtx'];
  const params: Record<string, string> = {};
  const query: Record<string, string> = {};
  const context: SsrLoadContext = {
    params: Object.freeze(params),
    query: Object.freeze(query),
    url: new URL('http://localhost/'),
    headers: new Headers(),
    getUser() {
      return Promise.resolve(null);
    },
    draftMode() {
      return { isEnabled: false };
    },
    after() {},
    get bsCtx() {
      if (injectedBsCtx !== undefined) {
        return injectedBsCtx as SsrLoadContext['bsCtx'];
      }
      throw new Error(
        '[slingshot-ssg] generateStaticParams: bsCtx is not available at build time. ' +
          'Inject a real context via globalThis.__ssgBsCtx before running the crawler.',
      );
    },
  };

  return Object.freeze(context);
}

/**
 * Convert an absolute file path to the URL path it serves.
 *
 * Rules (mirrors the resolver in slingshot-ssr):
 * - Strip extension, strip leading routes dir
 * - `/load` suffix (directory form) → strip
 * - `/index` suffix → strip (or `/` for root)
 * - Route groups `(group)` → strip segment
 *
 * Returns `null` for files that produce invalid URL paths.
 */
function filePathToUrlPath(filePath: string, routesDir: string): string | null {
  let rel = relative(routesDir, filePath).split(sep).join('/');

  // Strip extension
  rel = rel.replace(/\.(ts|tsx|js)$/, '');

  // Directory form: strip trailing /load or /page
  if (rel.endsWith('/load')) rel = rel.slice(0, -5);
  else if (rel.endsWith('/page')) rel = rel.slice(0, -5);
  else if (rel === 'load' || rel === 'page') rel = '/';

  // Index routes
  if (rel.endsWith('/index')) {
    rel = rel.slice(0, -6) || '/';
  } else if (rel === 'index') {
    rel = '/';
  }

  // Strip route group segments
  rel = rel.replace(/(?:^|\/)(\([^)]+\))\/?/g, (match, _group, offset) =>
    offset === 0 ? '' : '/',
  );

  const urlPath = rel.startsWith('/') ? rel : '/' + rel;
  return urlPath || '/';
}

/**
 * Dynamically import a route file, call its `staticPaths()` export, and
 * expand the returned parameter maps into concrete URL paths.
 *
 * @param filePath - Absolute path to the route file.
 * @param routesDir - Absolute path to the server routes directory.
 * @returns Array of concrete URL paths.
 */
async function callStaticPaths(
  filePath: string,
  routesDir: string,
  timeoutMs: number,
  maxParamSets: number,
  logger: Logger,
): Promise<string[]> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(filePath)) as Record<string, unknown>;
  } catch (err) {
    logger.warn('ssg.static_paths.import.failed', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  // Accept both legacy `staticPaths` and Next.js-aligned `generateStaticParams`.
  const staticPathsFn = mod['staticPaths'];
  const generateStaticParamsFn = mod['generateStaticParams'];
  const resolvedFn =
    typeof staticPathsFn === 'function'
      ? staticPathsFn
      : typeof generateStaticParamsFn === 'function'
        ? generateStaticParamsFn
        : null;
  const resolvedFnName =
    typeof staticPathsFn === 'function'
      ? 'staticPaths'
      : typeof generateStaticParamsFn === 'function'
        ? 'generateStaticParams'
        : null;
  if (resolvedFn === null || resolvedFnName === null) {
    logger.warn('ssg.static_paths.missing_export', { filePath });
    return [];
  }

  // P-SSG-4: bound staticPaths/generateStaticParams via the core withTimeout
  // helper. A hung generator (infinite loop, unresolved promise) rejects with
  // TimeoutError, which the catch arm normalises into a labelled
  // [slingshot-ssg] error so the build surfaces the offending route file.
  let paramSets: StaticParamSet[];
  try {
    const callPromise =
      resolvedFnName === 'generateStaticParams'
        ? (resolvedFn as GenerateStaticParams)(createBuildTimeContext())
        : (resolvedFn as SsgStaticPathsFn)();
    paramSets = await withTimeout(
      Promise.resolve(callPromise),
      timeoutMs,
      `${resolvedFnName}() in ${filePath}`,
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      throw new Error(
        `[slingshot-ssg] ${filePath}: ${resolvedFnName}() failed: ${err.message} — check for infinite generators or unresolved promises`,
        { cause: err },
      );
    }
    throw new Error(`[slingshot-ssg] ${filePath}: ${resolvedFnName}() failed`, { cause: err });
  }

  if (!Array.isArray(paramSets)) {
    throw new Error(
      `[slingshot-ssg] ${filePath}: ${resolvedFnName}() must return an array of parameter objects`,
    );
  }
  if (paramSets.length > maxParamSets) {
    throw new Error(
      `[slingshot-ssg] ${filePath}: ${resolvedFnName}() returned ${paramSets.length} parameter sets; ` +
        `maxStaticPathsPerRoute is ${maxParamSets}`,
    );
  }

  const template = filePathToUrlPathTemplate(filePath, routesDir);
  if (!template) return [];

  return paramSets
    .map(params => expandTemplate(template, params, logger))
    .filter((p): p is string => p !== null);
}

/**
 * Convert a file path to a URL path template with `[param]` placeholders intact.
 * Used to build concrete URLs from the parameter sets returned by `staticPaths()`.
 */
function filePathToUrlPathTemplate(filePath: string, routesDir: string): string | null {
  let rel = relative(routesDir, filePath).split(sep).join('/');

  // Strip extension
  rel = rel.replace(/\.(ts|tsx|js)$/, '');

  // Directory form: strip trailing /load or /page
  if (rel.endsWith('/load')) rel = rel.slice(0, -5);
  else if (rel.endsWith('/page')) rel = rel.slice(0, -5);
  else if (rel === 'load' || rel === 'page') rel = '/';

  // Index routes
  if (rel.endsWith('/index')) {
    rel = rel.slice(0, -6) || '/';
  } else if (rel === 'index') {
    rel = '/';
  }

  // Strip route group segments
  rel = rel.replace(/(?:^|\/)(\([^)]+\))\/?/g, (match, _group, offset) =>
    offset === 0 ? '' : '/',
  );

  return rel.startsWith('/') ? rel : '/' + rel;
}

/**
 * Replace `[param]` and `[...param]` placeholders in a URL template with
 * values from a parameter map.
 *
 * Returns `null` when any required parameter is missing from `params`.
 */
function expandTemplate(
  template: string,
  params: Record<string, string>,
  logger: Logger = noopLogger,
): string | null {
  let result = template;
  const paramLookup = params as Record<string, string | undefined>;

  // Replace catch-all first to avoid partial matches
  result = result.replace(/\[\.\.\.([^\]]+)\]/g, (_, name: string) => {
    const value = paramLookup[name];
    return value ?? '\0'; // sentinel for missing
  });

  result = result.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const value = paramLookup[name];
    return value ?? '\0'; // sentinel for missing
  });

  if (result.includes('\0')) {
    logger.warn('ssg.static_paths.incomplete_params', { template, params });
    return null;
  }

  return result;
}
