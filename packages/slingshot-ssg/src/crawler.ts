// packages/slingshot-ssg/src/crawler.ts
import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
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
  const routeFiles = await collectRouteFiles(config.serverRoutesDir);
  const paths: string[] = [];

  for (const filePath of routeFiles) {
    const source = safeReadSource(filePath);
    if (!source) continue;

    const isDynamic = hasDynamicSegments(filePath, config.serverRoutesDir);
    const hasStaticPathsFn = sourceHasStaticPaths(source);
    const hasRevalidateFalse = sourceHasRevalidateFalse(source);

    if (!hasStaticPathsFn && !hasRevalidateFalse) continue;

    if (isDynamic) {
      if (!hasStaticPathsFn) {
        // Dynamic route with revalidate:false but no staticPaths/generateStaticParams — warn and skip.
        console.warn(
          `[slingshot-ssg] Skipping dynamic route ${filePath}: ` +
            `revalidate: false detected but no \`staticPaths()\` or \`generateStaticParams()\` export found. ` +
            `Add one of these exports to enumerate all paths.`,
        );
        continue;
      }

      // Call staticPaths() to expand all concrete paths for this dynamic route
      const expandedPaths = await callStaticPaths(filePath, config.serverRoutesDir);
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
async function collectRouteFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = await readdir(dir);
  await Promise.all(
    entries.map(async entry => {
      const full = join(dir, entry);
      const fileStat = await stat(full);

      if (fileStat.isDirectory()) {
        results.push(...(await collectRouteFiles(full)));
      } else if (/\.(ts|tsx|js)$/.test(entry)) {
        const basename = entry.replace(/\.(ts|tsx|js)$/, '');
        if (!CONVENTION_BASENAMES.has(basename)) {
          results.push(full);
        }
      }
    }),
  );
  return results.sort();
}

/**
 * Read the source of a route file, returning an empty string on any error.
 * Never throws — a missing or unreadable file just gets skipped.
 */
function safeReadSource(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
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
async function callStaticPaths(filePath: string, routesDir: string): Promise<string[]> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(filePath)) as Record<string, unknown>;
  } catch (err) {
    console.warn(`[slingshot-ssg] Failed to import ${filePath}:`, err);
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
    console.warn(
      `[slingshot-ssg] ${filePath}: neither staticPaths nor generateStaticParams is a function`,
    );
    return [];
  }

  let paramSets: StaticParamSet[];
  try {
    const STATIC_PATHS_TIMEOUT_MS = 60_000;
    const timeoutSignal = AbortSignal.timeout(STATIC_PATHS_TIMEOUT_MS);
    const callPromise =
      resolvedFnName === 'generateStaticParams'
        ? (resolvedFn as GenerateStaticParams)(createBuildTimeContext())
        : (resolvedFn as SsgStaticPathsFn)();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutSignal.addEventListener('abort', () => {
        reject(
          new Error(
            `staticPaths() timed out after 60s — check for infinite generators or unresolved promises`,
          ),
        );
      });
    });
    paramSets = await Promise.race([callPromise, timeoutPromise]);
  } catch (err) {
    console.warn(`[slingshot-ssg] ${filePath}: ${resolvedFnName}() threw:`, err);
    return [];
  }

  const template = filePathToUrlPathTemplate(filePath, routesDir);
  if (!template) return [];

  return paramSets
    .map(params => expandTemplate(template, params))
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
function expandTemplate(template: string, params: Record<string, string>): string | null {
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
    console.warn(
      `[slingshot-ssg] Incomplete params for template "${template}": ` + JSON.stringify(params),
    );
    return null;
  }

  return result;
}
