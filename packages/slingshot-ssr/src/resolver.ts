// packages/slingshot-ssr/src/resolver.ts
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { SsrParallelSlot, SsrRouteChain, SsrRouteMatch } from './types';

interface RouteEntry {
  /** Regex pattern matching URL pathnames for this route. */
  pattern: RegExp;
  /** Named capture groups in the pattern → param names. */
  paramNames: string[];
  /** Whether this is a catch-all route. */
  isCatchAll: boolean;
  /** Absolute path to the loader file (load.ts or the single-file route). */
  filePath: string;
  /** Absolute path to meta.ts in directory form, or null. */
  metaFilePath: string | null;
  /** Absolute path to loading.ts co-located in the same directory, or null. */
  loadingFilePath: string | null;
  /** Absolute path to error.ts co-located in the same directory, or null. */
  errorFilePath: string | null;
  /** Absolute path to not-found.ts co-located in the same directory, or null. */
  notFoundFilePath: string | null;
  /** Absolute path to forbidden.ts in directory form, or null. */
  forbiddenFilePath: string | null;
  /** Absolute path to unauthorized.ts in directory form, or null. */
  unauthorizedFilePath: string | null;
  /** Absolute path to template.ts in directory form (for layout matches), or null. */
  templateFilePath: string | null;
}

// Module-level cache: serverRoutesDir → RouteEntry[]
//
// Rule 3 note: this Map is indexed by the serverRoutesDir path, not by app
// instance. Each unique directory path gets its own cache entry. This is safe
// because the route tree is derived entirely from the filesystem — it is
// stateless with respect to any app instance and invalidated explicitly via
// invalidateRouteTree(). It is NOT shared mutable state between app instances.
const routeTreeCache = new Map<string, RouteEntry[]>();

/**
 * Initialise the route tree for a given server routes directory.
 *
 * Scans the directory and caches the result. Safe to call multiple times —
 * returns the cached result if already initialised. Call once during plugin
 * startup (`setupMiddleware`).
 *
 * @param serverRoutesDir - Absolute path to the server/routes directory.
 * @internal
 */
export function initRouteTree(serverRoutesDir: string): void {
  if (routeTreeCache.has(serverRoutesDir)) return;
  routeTreeCache.set(serverRoutesDir, buildRouteTree(serverRoutesDir));
}

/**
 * Invalidate the cached route tree for a directory.
 *
 * Called by the dev mode file watcher when files are added, changed, or
 * removed. After invalidation, the next call to `initRouteTree` will re-scan.
 *
 * @param serverRoutesDir - Absolute path to the server/routes directory.
 * @internal
 */
export function invalidateRouteTree(serverRoutesDir: string): void {
  routeTreeCache.delete(serverRoutesDir);
}

/**
 * Resolve a URL pathname to a server route match.
 *
 * Returns `null` when no file in `serverRoutesDir` matches the pathname, or
 * when the route tree has not been initialised (call `initRouteTree` first).
 *
 * More specific routes (fewer params) take priority over dynamic routes.
 * Catch-all routes (`[...rest]`) match last.
 *
 * @param pathname - The URL pathname to match (e.g. `/posts/nba-finals`).
 * @param serverRoutesDir - Absolute path to the server/routes directory.
 * @returns A resolved `SsrRouteMatch` with params, or `null` for no match.
 *   The `url` field is a placeholder — the middleware populates the real URL.
 * @internal
 */
export function resolveRoute(pathname: string, serverRoutesDir: string): SsrRouteMatch | null {
  const entries = routeTreeCache.get(serverRoutesDir);
  if (!entries) return null;

  // Normalize: strip trailing slash except for root
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;

  for (const entry of entries) {
    const match = entry.pattern.exec(normalized);
    if (!match) continue;

    const params: Record<string, string> = {};
    for (const name of entry.paramNames) {
      const value = match.groups?.[name];
      if (value !== undefined) params[name] = decodeURIComponent(value);
    }

    return {
      filePath: entry.filePath,
      metaFilePath: entry.metaFilePath,
      params,
      query: {}, // populated by middleware from URLSearchParams
      url: new URL(pathname, 'http://localhost'), // placeholder — middleware sets real URL
      loadingFilePath: entry.loadingFilePath,
      errorFilePath: entry.errorFilePath,
      notFoundFilePath: entry.notFoundFilePath,
      forbiddenFilePath: entry.forbiddenFilePath,
      unauthorizedFilePath: entry.unauthorizedFilePath,
      templateFilePath: null, // never set on page matches from resolveRoute
    };
  }

  return null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildRouteTree(dir: string): RouteEntry[] {
  const files = collectRouteFiles(dir);
  const entries = files
    .map(f => fileToRouteEntry(f, dir))
    .filter((e): e is RouteEntry => e !== null);

  // Sort: specific (0 params) before dynamic (1+ params), catch-all last.
  entries.sort((a, b) => {
    if (a.isCatchAll !== b.isCatchAll) return a.isCatchAll ? 1 : -1;
    return a.paramNames.length - b.paramNames.length;
  });

  return entries;
}

/**
 * Convention file base names that are side-cars, not route entries.
 * These are excluded from route tree collection but checked as co-located files.
 */
const CONVENTION_BASENAMES = new Set([
  'meta',
  'layout',
  'loading',
  'error',
  'not-found',
  'middleware',
]);

function isConventionFile(entry: string): boolean {
  const base = entry.replace(/\.(ts|tsx|js)$/, '');
  return CONVENTION_BASENAMES.has(base);
}

/**
 * Recursively collect all route files (.ts, .tsx, .js), excluding convention
 * side-car files (meta.ts, layout.ts, loading.ts, error.ts, not-found.ts,
 * middleware.ts) which are loaded separately, not as route entries.
 *
 * Also skips `@`-prefixed directories (parallel slot trees) and interception
 * directories (`(.)`, `(..)`, `(...)`) — those are resolved on-demand.
 */
function collectRouteFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);

    if (stat.isDirectory()) {
      // Skip @slot directories (parallel routes) — resolved on-demand.
      // Skip interception directories: names starting with (.) (..) (...) prefix.
      // Examples: (.)photo, (..)shared, (...)modal — all start with the interception prefix.
      if (entry.startsWith('@') || /^\(\.*\)/.test(entry)) continue;
      results.push(...collectRouteFiles(full));
    } else if (/\.(ts|tsx|js)$/.test(entry) && !isConventionFile(entry)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Look up a convention file (loading.ts, error.ts, not-found.ts) in a directory.
 * Checks `{dir}/{name}.ts`, `{dir}/{name}.tsx`, `{dir}/{name}.js`,
 * and `{dir}/{name}/index.ts` etc.
 *
 * @internal
 */
function findConventionFile(dir: string, name: string): string | null {
  for (const ext of ['ts', 'tsx', 'js']) {
    const direct = join(dir, `${name}.${ext}`);
    if (existsSync(direct)) return direct;
    const indexed = join(dir, name, `index.${ext}`);
    if (existsSync(indexed)) return indexed;
  }
  return null;
}

/** Convert an absolute file path to a RouteEntry, or null if not a valid route file. */
function fileToRouteEntry(filePath: string, routesDir: string): RouteEntry | null {
  // Relative path from routes dir, normalized to forward slashes
  let rel = relative(routesDir, filePath).split(sep).join('/');

  // Strip extension (.ts, .tsx, .js)
  rel = rel.replace(/\.(ts|tsx|js)$/, '');

  // Handle directory form: strip trailing /load or /page
  const isDirectoryForm = rel.endsWith('/load') || rel.endsWith('/page');
  if (rel.endsWith('/load'))
    rel = rel.slice(0, -5); // remove '/load'
  else if (rel.endsWith('/page'))
    rel = rel.slice(0, -5); // remove '/page'
  else if (rel === 'load' || rel === 'page') rel = '/';

  // Directory that contains the route file (for convention file lookup).
  // For directory-form routes (load.ts or page.ts), strip the filename to get
  // the containing directory. For single-file routes, dirname suffices.
  const routeDir = isDirectoryForm
    ? filePath.replace(/[/\\](load|page)\.(ts|tsx|js)$/, '')
    : dirname(filePath);

  // Determine metaFilePath for directory form routes
  let metaFilePath: string | null = null;
  if (isDirectoryForm) {
    for (const ext of ['ts', 'tsx', 'js']) {
      const candidate = join(routeDir, `meta.${ext}`);
      if (existsSync(candidate)) {
        metaFilePath = candidate;
        break;
      }
    }
  }

  // Detect co-located convention files (Phase 28)
  const loadingFilePath = findConventionFile(routeDir, 'loading');
  const errorFilePath = findConventionFile(routeDir, 'error');
  const notFoundFilePath = findConventionFile(routeDir, 'not-found');
  const forbiddenFilePath = isDirectoryForm ? findConventionFile(routeDir, 'forbidden') : null;
  const unauthorizedFilePath = isDirectoryForm
    ? findConventionFile(routeDir, 'unauthorized')
    : null;
  const templateFilePath = null; // only set on layout entries in buildChain()

  // Strip trailing /index (index routes: posts/index → posts)
  if (rel.endsWith('/index')) {
    rel = rel.slice(0, -6) || '/';
  }

  // Remove route group segments.
  // Handles both leading groups: '(auth)/login' → 'login'
  // and mid-path groups: 'nested/(group)/file' → 'nested/file'
  // Note: interception groups ((.)), (..), (...) are also stripped here —
  // they are only relevant as candidates in resolveRouteChain().
  rel = rel.replace(/(?:^|\/)(\([^)]+\))\/?/g, (match, _group, offset) =>
    offset === 0 ? '' : '/',
  );

  // Handle bare index at root
  if (rel === 'index') rel = '/';

  const routePath = rel.startsWith('/') ? rel : '/' + rel;

  const result = buildPattern(routePath);
  if (!result.pattern) return null;
  const { pattern, paramNames, isCatchAll } = result;

  return {
    pattern,
    paramNames,
    isCatchAll,
    filePath,
    metaFilePath,
    loadingFilePath,
    errorFilePath,
    notFoundFilePath,
    forbiddenFilePath,
    unauthorizedFilePath,
    templateFilePath,
  };
}

function buildPattern(
  routePath: string,
): { pattern: RegExp; paramNames: string[]; isCatchAll: boolean } | { pattern: null } {
  const paramNames: string[] = [];
  let isCatchAll = false;

  // Split path into segments, keep leading empty string for root
  const rawSegments = routePath.split('/');
  const patternParts: string[] = [];

  for (const segment of rawSegments) {
    if (segment === '') {
      patternParts.push('');
      continue;
    }

    // Catch-all: [...param]
    const catchAllMatch = /^\[\.\.\.([^\]]+)\]$/.exec(segment);
    if (catchAllMatch) {
      const name = catchAllMatch[1];
      // Validate: catch-all param names must be valid JS identifiers
      if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) return { pattern: null };
      paramNames.push(name);
      isCatchAll = true;
      patternParts.push(`(?<${name}>.+)`);
      continue;
    }

    // Dynamic: [param]
    const dynamicMatch = /^\[([^\]]+)\]$/.exec(segment);
    if (dynamicMatch) {
      const name = dynamicMatch[1];
      if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) return { pattern: null };
      paramNames.push(name);
      patternParts.push(`(?<${name}>[^/]+)`);
      continue;
    }

    // Static segment — escape regex special characters
    patternParts.push(escapeRegex(segment));
  }

  const patternStr = patternParts.join('/') || '/';
  const pattern = new RegExp(`^${patternStr}$`);
  return { pattern, paramNames, isCatchAll };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Route chain resolution ───────────────────────────────────────────────────

/**
 * Resolve the global server middleware file path for a given routes directory.
 *
 * Looks for `middleware.ts` adjacent to `serverRoutesDir` (i.e. in the parent
 * `server/` directory). This is the same check performed inside `resolveRouteChain`,
 * but exposed separately so the middleware handler can run global middleware even
 * when no page route matched — enabling redirects, rewrites, and auth guards for
 * unmatched URLs without requiring a file-based page.
 *
 * @param serverRoutesDir - Absolute path to the server/routes directory.
 * @returns Absolute path to the middleware file, or `null` if none found.
 * @internal
 */
export function resolveGlobalMiddlewarePath(serverRoutesDir: string): string | null {
  const serverDir = dirname(serverRoutesDir);
  return (
    findConventionFile(serverDir, 'middleware') ??
    findConventionFile(join(serverDir, 'middleware'), 'index') ??
    null
  );
}

/**
 * Resolve a URL pathname to a full route chain including all ancestor `layout.ts`
 * files, parallel `@slot` directories, interception routes, and middleware.
 *
 * Returns `null` if no matching page route is found.
 *
 * **Layout detection** (Phase 25): Walks up from the matched file's directory toward
 * `serverRoutesDir`, checking for `layout.ts` or `layout/index.ts` at each level.
 * Layouts are collected in root-first order.
 *
 * **Parallel routes** (Phase 26): Scans the leaf directory for `@`-prefixed
 * subdirectories and attempts to resolve the pathname within each slot's tree.
 *
 * **Intercepting routes** (Phase 27): When `fromPath` is provided, checks for
 * `(.)`, `(..)`, and `(...)` interception directories relative to `fromPath`'s
 * level and tries to match `pathname` within them before the direct match.
 *
 * **Middleware** (Phase 29): Checks for `middleware.ts` adjacent to `serverRoutesDir`
 * (i.e., `server/middleware.ts` when `serverRoutesDir` is `server/routes`).
 *
 * @param pathname - The URL pathname to resolve (e.g. `/posts/nba-finals`).
 * @param serverRoutesDir - Absolute path to the server/routes directory.
 * @param fromPath - Optional source path for interception context (Phase 27).
 *   Pass the `X-Snapshot-Navigate` header value from the client.
 * @returns A fully resolved `SsrRouteChain`, or `null` when no page matches.
 */
export function resolveRouteChain(
  pathname: string,
  serverRoutesDir: string,
  fromPath?: string,
): SsrRouteChain | null {
  // ── Middleware detection (Phase 29) ────────────────────────────────────────
  // Check for server/middleware.ts adjacent to serverRoutesDir
  const serverDir = dirname(serverRoutesDir);
  const middlewareFilePath =
    findConventionFile(serverDir, 'middleware') ??
    findConventionFile(join(serverDir, 'middleware'), 'index');

  // ── Intercepting route resolution (Phase 27) ───────────────────────────────
  // When fromPath is provided, check for interception directories before the direct match.
  if (fromPath) {
    const interceptionMatch = resolveInterceptingRoute(pathname, serverRoutesDir, fromPath);
    if (interceptionMatch) {
      return buildChain(interceptionMatch, serverRoutesDir, middlewareFilePath, true);
    }
  }

  // ── Direct page resolution ─────────────────────────────────────────────────
  const pageMatch = resolveRoute(pathname, serverRoutesDir);
  if (!pageMatch) return null;

  return buildChain(pageMatch, serverRoutesDir, middlewareFilePath, false);
}

/**
 * Build the full `SsrRouteChain` for a resolved page match.
 *
 * Walks up directories from the leaf toward `serverRoutesDir` collecting layouts,
 * then scans the leaf directory for parallel `@slot` subdirectories.
 *
 * @internal
 */
function buildChain(
  pageMatch: SsrRouteMatch,
  serverRoutesDir: string,
  middlewareFilePath: string | null,
  intercepted: boolean,
): SsrRouteChain {
  // ── Layout discovery (Phase 25) ────────────────────────────────────────────
  // Walk up from the leaf directory toward serverRoutesDir collecting layout files.
  // We start at the leaf route's OWN directory and walk up toward (but not into)
  // serverRoutesDir. Each directory is checked for a layout.ts convention file.
  //
  // Walk order: leaf-dir → parent → ... → serverRoutesDir (exclusive)
  // Collected order: leaf-first; reversed at the end for root-first order.
  const layouts: SsrRouteMatch[] = [];

  // Determine the "conceptual" directory of the page route:
  // - Single-file route (e.g., dashboard/page.ts) → dirname = dashboard/
  // - Directory-form route (e.g., dashboard/load.ts) → dirname = dashboard/
  // Both cases are the same — dirname of the file is the route's directory.
  let currentDir = dirname(pageMatch.filePath);

  // Walk from currentDir UP to (but not including) serverRoutesDir
  while (currentDir.startsWith(serverRoutesDir) && currentDir !== serverRoutesDir) {
    const layoutFile = findConventionFile(currentDir, 'layout');
    if (layoutFile) {
      // Build a synthetic SsrRouteMatch for the layout
      layouts.push({
        filePath: layoutFile,
        metaFilePath: null,
        params: pageMatch.params,
        query: pageMatch.query,
        url: pageMatch.url,
        loadingFilePath: null,
        errorFilePath: null,
        notFoundFilePath: null,
        forbiddenFilePath: null,
        unauthorizedFilePath: null,
        templateFilePath: findConventionFile(currentDir, 'template'), // detect co-located template
      });
    }
    currentDir = dirname(currentDir);
  }

  // Also check serverRoutesDir itself for a root layout.ts
  const rootLayoutFile = findConventionFile(serverRoutesDir, 'layout');
  if (rootLayoutFile) {
    layouts.push({
      filePath: rootLayoutFile,
      metaFilePath: null,
      params: pageMatch.params,
      query: pageMatch.query,
      url: pageMatch.url,
      loadingFilePath: null,
      errorFilePath: null,
      notFoundFilePath: null,
      forbiddenFilePath: null,
      unauthorizedFilePath: null,
      templateFilePath: findConventionFile(serverRoutesDir, 'template'), // detect root template
    });
  }

  // Layouts are collected leaf-to-root during the walk; reverse for root-first order
  layouts.reverse();

  // ── Parallel slot discovery (Phase 26) ─────────────────────────────────────
  // Scan the leaf route's directory for @-prefixed subdirectories
  const leafDir = dirname(pageMatch.filePath);
  const slots = resolveParallelSlots(pageMatch, leafDir, serverRoutesDir);

  return Object.freeze({
    layouts: Object.freeze(layouts),
    page: pageMatch,
    slots: slots.length > 0 ? Object.freeze(slots) : undefined,
    intercepted: intercepted || undefined,
    middlewareFilePath,
  });
}

/**
 * Find interception directories in a parent directory matching the given prefix dots
 * and target segment name.
 *
 * Scans `parentDir` for directories matching `(${dots})${targetSegment}` or
 * the bare interception dir `(${dots})` (used when the target is a sub-path).
 *
 * Examples:
 * - `findInterceptionDirs('/routes/gallery', '.', 'photo')` → `['/routes/gallery/(.)photo']`
 * - `findInterceptionDirs('/routes', '..', 'photo')` → `['/routes/(..)photo']`
 *
 * @internal
 */
function findInterceptionDirs(parentDir: string, dots: string, targetSegment: string): string[] {
  if (!existsSync(parentDir)) return [];

  const prefix = `(${dots})`;
  const results: string[] = [];

  for (const entry of readdirSync(parentDir)) {
    if (!entry.startsWith(prefix)) continue;
    const full = join(parentDir, entry);
    if (!statSync(full).isDirectory()) continue;
    // Match: (.)photo, (.)photo-detail, (..)shared, (..)  (bare prefix also accepted)
    const suffix = entry.slice(prefix.length);
    if (suffix === '' || suffix === targetSegment || targetSegment.startsWith(suffix)) {
      results.push(full);
    }
  }

  return results;
}

/**
 * Attempt to resolve an intercepting route for `pathname` based on `fromPath`.
 *
 * Checks `(.)`, `(..)`, and `(...)` interception directories at the appropriate
 * level relative to `fromPath`'s directory within `serverRoutesDir`.
 *
 * - `(.)` — same level as `fromPath`'s directory
 * - `(..)` — one level up from `fromPath`'s directory
 * - `(...)` — from the root of `serverRoutesDir`
 *
 * Returns the first intercepting route match, or `null` when none match.
 *
 * @internal
 */
function resolveInterceptingRoute(
  pathname: string,
  serverRoutesDir: string,
  fromPath: string,
): SsrRouteMatch | null {
  // Normalize fromPath
  const normalizedFrom = fromPath.length > 1 ? fromPath.replace(/\/$/, '') : fromPath;
  const fromSegments = normalizedFrom.split('/').filter(Boolean);

  // Determine fromPath's directory level relative to serverRoutesDir
  // by counting path segments (each segment = one directory level)
  const fromDepth = fromSegments.length;

  // Build the target path segment we're trying to intercept.
  // For pathname /photo/42, the target segment is "photo".
  const pathSegments = pathname.split('/').filter(Boolean);
  const targetSegment = pathSegments[0] ?? '';

  // Build candidate interception dirs to check.
  // We look for directories with the interception prefix followed by the target segment:
  //   (.) → same level: scan fromPath's parent directory for (.)targetSegment
  //   (..) → one level up: scan grandparent for (..)targetSegment
  //   (...) → root: scan serverRoutesDir for (...)targetSegment
  const candidateDirs: string[] = [];

  // (.) — same level: fromPath's directory
  const sameLevelDir = join(serverRoutesDir, ...fromSegments.slice(0, Math.max(0, fromDepth - 1)));
  candidateDirs.push(...findInterceptionDirs(sameLevelDir, '.', targetSegment));

  // (..) — one level up
  const oneLevelUpDir =
    fromDepth >= 2
      ? join(serverRoutesDir, ...fromSegments.slice(0, fromDepth - 2))
      : serverRoutesDir;
  candidateDirs.push(...findInterceptionDirs(oneLevelUpDir, '..', targetSegment));

  // (...) — from root
  candidateDirs.push(...findInterceptionDirs(serverRoutesDir, '...', targetSegment));

  for (const interceptDir of candidateDirs) {
    if (!existsSync(interceptDir)) continue;
    // useSubdirAsRoot=true: interception dirs act as their own route root so that
    // files inside are matched relative to the interception dir, not serverRoutesDir.
    const match = resolveRouteInDir(pathname, interceptDir, serverRoutesDir, true);
    if (match) return match;
  }

  return null;
}

/**
 * Resolve parallel `@slot` directories within a leaf route directory.
 *
 * For each `@{slotName}` subdirectory, checks whether the slot has a `page.ts`
 * (or `load.ts`) at the root level (direct match for the parent URL) or attempts
 * to resolve the current pathname within the slot's sub-tree for dynamic segments.
 *
 * Slot matching semantics (mirrors Next.js parallel routes):
 * - A `page.ts` directly in `@slotName/` always matches the parent route's URL
 * - Sub-directories (`@slotName/[id]/page.ts`) are matched against the pathname
 *
 * @internal
 */
function resolveParallelSlots(
  pageMatch: SsrRouteMatch,
  leafDir: string,
  serverRoutesDir: string,
): SsrParallelSlot[] {
  const slots: SsrParallelSlot[] = [];
  if (!existsSync(leafDir)) return slots;

  for (const entry of readdirSync(leafDir)) {
    if (!entry.startsWith('@')) continue;
    const slotDir = join(leafDir, entry);
    if (!statSync(slotDir).isDirectory()) continue;

    const slotName = entry.slice(1); // strip '@'
    const defaultFilePath = findConventionFileDirect(slotDir, 'default');

    // Check for a direct page.ts/load.ts in the slot directory (matches the parent URL)
    const directPage =
      findConventionFileDirect(slotDir, 'page') ??
      findConventionFileDirect(slotDir, 'load') ??
      findConventionFileDirect(slotDir, 'index');

    if (directPage) {
      // Direct page match — this slot always renders for the parent's URL
      const slotMatch: SsrRouteMatch = {
        filePath: directPage,
        metaFilePath: null,
        params: pageMatch.params,
        query: pageMatch.query,
        url: pageMatch.url,
        loadingFilePath: findConventionFile(slotDir, 'loading'),
        errorFilePath: findConventionFile(slotDir, 'error'),
        notFoundFilePath: findConventionFile(slotDir, 'not-found'),
        forbiddenFilePath: findConventionFile(slotDir, 'forbidden'),
        unauthorizedFilePath: findConventionFile(slotDir, 'unauthorized'),
        templateFilePath: null,
      };
      slots.push({ name: slotName, match: slotMatch, defaultFilePath });
    } else {
      // No direct page — try to match the pathname within the slot's sub-tree.
      //
      // Bug fix (Bug 2): use the parent URL path as the base, not slotDir itself.
      // With slotDir as effectiveRoot, a pattern like `/[id]` derived from
      // `@sidebar/[id]/page.ts` would match the parent's OWN pathname (e.g.
      // `/inbox`) — assigning `id="inbox"` even though no deeper navigation
      // occurred. The slot directory itself is NOT a route endpoint; only its
      // children are. We therefore derive the sub-path by stripping the parent
      // route's URL prefix before matching, so slot patterns are anchored one
      // level deeper than the parent URL.
      const parentPathname = pageMatch.url.pathname;
      const normParent =
        parentPathname.length > 1 ? parentPathname.replace(/\/$/, '') : parentPathname;
      const normFull =
        pageMatch.url.pathname.length > 1
          ? pageMatch.url.pathname.replace(/\/$/, '')
          : pageMatch.url.pathname;
      // Compute the sub-path relative to the parent URL.
      // When the request URL equals the parent URL, subPathname is '/' — which
      // will not match any non-root slot-subtree pattern (the direct-page case
      // above handles same-URL slots).
      const subPathname =
        normFull.length > normParent.length && normFull.startsWith(normParent)
          ? normFull.slice(normParent.length)
          : '/';

      const subMatch = resolveRouteInDir(
        subPathname,
        slotDir,
        serverRoutesDir,
        true, // useSubdirAsRoot
      );
      slots.push({ name: slotName, match: subMatch, defaultFilePath });
    }
  }

  return slots;
}

/**
 * Find a route file (page.ts, index.ts) directly in a directory, without subdirs.
 * Used for slot direct-page detection.
 *
 * @internal
 */
function findConventionFileDirect(dir: string, name: string): string | null {
  for (const ext of ['ts', 'tsx', 'js']) {
    const candidate = join(dir, `${name}.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a pathname against an arbitrary subtree directory.
 *
 * Builds a temporary route tree for the given directory and matches `pathname`.
 * The `effectiveRoot` parameter controls how file paths are translated into URL
 * patterns:
 * - For parallel slots: use `serverRoutesDir` (full path context)
 * - For interception routes: use `dir` itself so that files inside the interception
 *   directory are treated as root-relative (e.g., `(.)photo/[id]/page.ts` under
 *   `gallery/(.)` matches `/photo/[id]` when `dir` is the effective root)
 *
 * Results are NOT cached — these are on-demand sub-tree walks.
 *
 * @internal
 */
function resolveRouteInDir(
  pathname: string,
  dir: string,
  serverRoutesDir: string,
  useSubdirAsRoot = false,
): SsrRouteMatch | null {
  if (!existsSync(dir)) return null;

  // For interception routes, treat the interception directory itself as the route root
  // so that file-to-pattern translation produces paths like /photo/[id] not /gallery/(.)photo/[id]
  const effectiveRoot = useSubdirAsRoot ? dir : serverRoutesDir;

  const files = collectRouteFiles(dir);
  const entries = files
    .map(f => fileToRouteEntry(f, effectiveRoot))
    .filter((e): e is RouteEntry => e !== null);

  entries.sort((a, b) => {
    if (a.isCatchAll !== b.isCatchAll) return a.isCatchAll ? 1 : -1;
    return a.paramNames.length - b.paramNames.length;
  });

  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;

  for (const entry of entries) {
    const match = entry.pattern.exec(normalized);
    if (!match) continue;

    const params: Record<string, string> = {};
    for (const name of entry.paramNames) {
      const value = match.groups?.[name];
      if (value !== undefined) params[name] = decodeURIComponent(value);
    }

    return {
      filePath: entry.filePath,
      metaFilePath: entry.metaFilePath,
      params,
      query: {},
      url: new URL(pathname, 'http://localhost'),
      loadingFilePath: entry.loadingFilePath,
      errorFilePath: entry.errorFilePath,
      notFoundFilePath: entry.notFoundFilePath,
      forbiddenFilePath: entry.forbiddenFilePath,
      unauthorizedFilePath: entry.unauthorizedFilePath,
      templateFilePath: null, // never set on page matches from resolveRouteInDir
    };
  }

  return null;
}
