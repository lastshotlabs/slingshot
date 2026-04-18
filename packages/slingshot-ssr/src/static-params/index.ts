// packages/slingshot-ssr/src/static-params/index.ts
import type { Dirent } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { GenerateStaticParams, SsrLoadContext, StaticParamSet } from '../types';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * A single route that exports `generateStaticParams`, plus the pre-computed
 * param sets returned by calling it at build time.
 *
 * `routePath` uses the file-system-derived URL pattern (e.g. `/players/[id]`).
 * `paramSets` is the array returned by the route's `generateStaticParams` export.
 */
export interface StaticRoute {
  /**
   * The URL pattern for this route, derived from the file path.
   * Dynamic segments retain their bracket notation: `/players/[id]`.
   */
  readonly routePath: string;
  /**
   * Absolute path to the route file that exported `generateStaticParams`.
   */
  readonly filePath: string;
  /**
   * The param sets returned by calling `generateStaticParams` for this route.
   * Each entry maps segment names to concrete values: `{ id: '42' }`.
   */
  readonly paramSets: readonly StaticParamSet[];
}

// ─── Build-time context stub ──────────────────────────────────────────────────

/**
 * Minimal `SsrLoadContext` stub used when calling `generateStaticParams` at
 * build time. Request-specific fields (`params`, `query`, `url`, `headers`)
 * are empty because static params are enumerated before any request exists.
 *
 * The `bsCtx` stub throws when accessed so that routes which accidentally
 * try to use it outside the SSG crawler get a clear error message rather than
 * a silent null/undefined.
 *
 * @internal
 */
function createBuildTimeContext(): SsrLoadContext {
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
    get bsCtx(): never {
      throw new Error(
        '[slingshot-ssr] generateStaticParams: bsCtx is not available at build time outside the SSG crawler. ' +
          'Inject a real context via globalThis.__ssgBsCtx before calling scanStaticParams().',
      );
    },
  };

  return Object.freeze(context);
}

// ─── File discovery ───────────────────────────────────────────────────────────

/**
 * Recursively collect all `.ts` and `.tsx` files under `dir`.
 *
 * @param dir - Absolute path to the directory to walk.
 * @returns Absolute paths to every `.ts`/`.tsx` file found.
 * @internal
 */
async function collectTsFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    // Directory does not exist or is unreadable — return empty.
    return results;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectTsFiles(full)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }

  return results;
}

/**
 * Derive the URL route pattern from a file path relative to the routes root.
 *
 * Strips the extension and `/load` suffix (directory-form routes), collapses
 * `/index` to the parent path, and removes route-group segments `(…)`.
 * Does NOT replace dynamic segments — `[id]` stays as `[id]` in the output.
 *
 * @param filePath - Absolute path to the route file.
 * @param routesDir - Absolute path to the routes directory root.
 * @returns A slash-prefixed route pattern like `/players/[id]`.
 * @internal
 */
function filePathToRoutePath(filePath: string, routesDir: string): string {
  // Relative path, normalized to forward slashes
  let rel = relative(routesDir, filePath).split(sep).join('/');

  // Strip extension
  rel = rel.replace(/\.(ts|tsx|js)$/, '');

  // Handle directory-form route: strip trailing /load or /page
  if (rel.endsWith('/load')) rel = rel.slice(0, -5);
  else if (rel.endsWith('/page')) rel = rel.slice(0, -5);
  else if (rel === 'load' || rel === 'page') rel = '/';

  // Collapse /index to parent
  if (rel.endsWith('/index')) rel = rel.slice(0, -6) || '/';
  if (rel === 'index') return '/';

  // Remove route-group segments like (auth), (public), etc.
  rel = rel.replace(/(?:^|\/)(\([^)]+\))\/?/g, (match, _group, offset) =>
    offset === 0 ? '' : '/',
  );

  return rel.startsWith('/') ? rel : '/' + rel;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Walk `routesDir` recursively, import every `.ts`/`.tsx` file, and call any
 * `generateStaticParams` export found to produce the list of static param sets.
 *
 * Files that do not export `generateStaticParams` are silently skipped.
 * Import errors are logged as warnings and the file is skipped.
 *
 * @param routesDir - Absolute path to the server routes directory
 *   (e.g. `process.cwd() + '/server/routes'`).
 * @returns An array of `StaticRoute` objects — one per route that exported
 *   `generateStaticParams` with at least one param set.
 *
 * @example
 * ```ts
 * import { scanStaticParams } from '@lastshotlabs/slingshot-ssr/static-params'
 *
 * const routes = await scanStaticParams(process.cwd() + '/server/routes')
 * console.log(routes)
 * // [{ routePath: '/players/[id]', filePath: '…', paramSets: [{ id: '1' }, { id: '2' }] }]
 * ```
 */
export async function scanStaticParams(routesDir: string): Promise<StaticRoute[]> {
  const files = await collectTsFiles(routesDir);
  const ctx = createBuildTimeContext();
  const results: StaticRoute[] = [];

  for (const filePath of files) {
    let mod: Record<string, unknown>;
    try {
      // Dynamic import — Bun resolves .ts natively at runtime.
      mod = (await import(filePath)) as Record<string, unknown>;
    } catch (err) {
      console.warn(
        `[slingshot-ssr/static-params] Failed to import ${filePath} — skipping.`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    if (typeof mod['generateStaticParams'] !== 'function') continue;

    const fn = mod['generateStaticParams'] as GenerateStaticParams;
    let paramSets: StaticParamSet[];
    try {
      paramSets = await fn(ctx);
    } catch (err) {
      console.warn(
        `[slingshot-ssr/static-params] generateStaticParams() threw in ${filePath} — skipping.`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    if (!Array.isArray(paramSets) || paramSets.length === 0) continue;

    const routePath = filePathToRoutePath(filePath, routesDir);

    results.push(
      Object.freeze({
        routePath,
        filePath,
        paramSets: Object.freeze(paramSets.map(s => Object.freeze({ ...s }))),
      }),
    );
  }

  return results;
}

/**
 * Serialize the output of `scanStaticParams()` to `static-params.json` in the
 * given output directory. Creates the directory if it does not exist.
 *
 * The file is used at deploy time by the ISR pre-renderer and can be inspected
 * for debugging. The format is a JSON array of `StaticRoute` objects (without
 * the `filePath` field — that is a build-machine-local path not useful at runtime).
 *
 * @param routes - The routes array returned by `scanStaticParams()`.
 * @param outputDir - Absolute path to the directory where `static-params.json`
 *   should be written (typically the client build output directory).
 *
 * @example
 * ```ts
 * const routes = await scanStaticParams(serverRoutesDir)
 * await writeStaticParamsManifest(routes, path.join(process.cwd(), 'dist/client'))
 * ```
 */
export async function writeStaticParamsManifest(
  routes: StaticRoute[],
  outputDir: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  // Omit filePath from the manifest — it's a build-time absolute path that
  // means nothing at runtime. Consumers only need routePath and paramSets.
  const serializable = routes.map(r => ({
    routePath: r.routePath,
    paramSets: r.paramSets,
  }));

  const outPath = join(outputDir, 'static-params.json');
  await writeFile(outPath, JSON.stringify(serializable, null, 2), 'utf-8');
}
