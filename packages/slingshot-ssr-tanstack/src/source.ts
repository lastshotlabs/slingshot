// packages/slingshot-ssr-tanstack/src/source.ts
//
// `createTanStackRouteSource` — adapter that lets slingshot-ssr discover and
// resolve routes from a TanStack Router file tree. With this in place, an app
// can express each public URL exactly once (in the TanStack route file) and
// have it serve both as an SSR-rendered first paint AND as a client-side
// navigated SPA route.
//
// What an SSR-eligible TanStack route file looks like:
//
// ```tsx
// // apps/web/src/routes/c/$slug/$threadId.tsx
// import { createFileRoute } from '@tanstack/react-router';
// import { ThreadPage } from '@sgforum/ui/pages/ThreadPage';
//
// export const ssr = {
//   load: async (ctx) => {
//     const thread = await ctx.bsCtx.entities.thread.getById(ctx.params.threadId);
//     if (!thread) return { notFound: true };
//     return {
//       data: { thread },
//       tags: [`thread:${thread.id}`],
//       revalidate: 30,
//     };
//   },
// };
//
// export const Route = createFileRoute('/c/$slug/$threadId')({
//   component: ThreadPage,
// });
// ```
//
// The `ssr` export is what marks a route as SSR-eligible. Files without it are
// CSR-only and the route source returns `null` for those URLs (the caller
// falls through to its SPA-fallback behavior).

import type {
  SsrRouteChain,
  SsrRouteMatch,
  SsrRouteSource,
} from '@lastshotlabs/slingshot-ssr';
import {
  clearTanStackModuleCache,
  loadTanStackLayoutModule,
  loadTanStackRouteModule,
} from './loader';
import {
  buildLayoutChain,
  type LayoutEntry,
  scanRoutesDirectory,
  type ScannedRouteFile,
} from './scanner';

/**
 * Configuration for {@link createTanStackRouteSource}.
 */
export interface TanStackRouteSourceConfig {
  /**
   * Absolute path to the TanStack routes directory (the same one passed to
   * `TanStackRouterVite({ routesDirectory })`).
   */
  readonly routesDirectory: string;
  /**
   * Maximum byte length of a single decoded route param. Mirrors slingshot-ssr's
   * default. @default 2048
   */
  readonly maxRouteParamBytes?: number;
}

/**
 * Build a TanStack-aware route source.
 *
 * Pass to `createSsrPackage({ routeSource })`. The plugin will use this for
 * URL → route resolution and module loading instead of the file-based default.
 *
 * @example
 * ```ts
 * import { createSsrPackage } from '@lastshotlabs/slingshot-ssr';
 * import { createTanStackRouteSource } from '@lastshotlabs/slingshot-ssr-tanstack';
 *
 * createSsrPackage({
 *   renderer,
 *   routeSource: createTanStackRouteSource({
 *     routesDirectory: path.resolve(__dirname, '../web/src/routes'),
 *   }),
 *   assetsManifest: '...',
 * });
 * ```
 */
export function createTanStackRouteSource(
  config: TanStackRouteSourceConfig,
): SsrRouteSource {
  const dir = config.routesDirectory;
  const defaultMaxBytes = config.maxRouteParamBytes ?? 2048;

  // Populated on `init()`. Each entry knows its URL pattern, its absolute
  // file path, the companion-server path (or null), and its layout chain.
  let entries: readonly TanStackRouteEntry[] = [];
  let initialized = false;

  return {
    id: 'tanstack',

    init(): void {
      const { leaves, layouts, rootLayoutPath, rootLayoutServerPath } =
        scanRoutesDirectory(dir);

      // Filter to leaves with a `<route>.server.{ts,tsx}` companion. Leaves
      // without one are CSR-only; we return null for their URLs and the SPA
      // fallback serves them.
      const built: TanStackRouteEntry[] = [];
      for (const leaf of leaves) {
        if (leaf.serverFilePath === null) continue;
        built.push(
          Object.freeze({
            ...leaf,
            layoutChain: buildLayoutChain(
              leaf,
              layouts,
              rootLayoutPath,
              rootLayoutServerPath,
            ),
          }),
        );
      }
      entries = Object.freeze(built);
      initialized = true;
    },

    invalidate(): void {
      entries = [];
      initialized = false;
      clearTanStackModuleCache();
    },

    resolve(pathname, opts) {
      if (!initialized) return null;
      const match = matchEntry(entries, pathname, opts?.maxRouteParamBytes ?? defaultMaxBytes);
      if (!match) return null;
      return buildMatch(match.entry, match.params, pathname);
    },

    resolveChain(pathname, opts) {
      if (!initialized) return null;
      const match = matchEntry(
        entries,
        pathname,
        opts?.maxRouteParamBytes ?? defaultMaxBytes,
      );
      if (!match) return null;

      const page = buildMatch(match.entry, match.params, pathname);
      const layouts = match.entry.layoutChain.map((layout) =>
        buildLayoutShell(layout, pathname),
      );
      const chain: SsrRouteChain = Object.freeze({
        layouts: Object.freeze(layouts),
        page,
        slots: undefined,
        intercepted: undefined,
        middlewareFilePath: null,
      });
      return chain;
    },

    resolveGlobalMiddleware(): string | null {
      // TanStack's model has no convention-located global middleware file.
      // Apps that need cross-route middleware express it via TanStack's
      // route-level `beforeLoad` or via the `__root.tsx` component. The SSR
      // middleware-rewrite feature is not bridged in v1.
      return null;
    },
  };
}

/** A scanned leaf with its layout chain attached. */
interface TanStackRouteEntry extends ScannedRouteFile {
  readonly layoutChain: readonly LayoutEntry[];
}

interface MatchedEntry {
  readonly entry: TanStackRouteEntry;
  readonly params: Record<string, string>;
}

function matchEntry(
  entries: readonly TanStackRouteEntry[],
  pathname: string,
  maxRouteParamBytes: number,
): MatchedEntry | null {
  // Normalize: strip trailing slash except for root.
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  for (const entry of entries) {
    const m = entry.translation.regex.exec(normalized);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const name of entry.translation.paramNames) {
      const raw = m.groups?.[name];
      if (raw === undefined) continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        return null;
      }
      const byteLen = utf8ByteLength(decoded);
      if (byteLen > maxRouteParamBytes) {
        // Mirror slingshot-ssr's RouteParamTooLargeError contract — the
        // middleware catches a value with `name === 'RouteParamTooLargeError'`
        // and returns 414. We construct a structurally compatible error.
        const err = new Error(
          `Route param "${name}" decoded to ${byteLen} bytes, exceeding the ${maxRouteParamBytes}-byte cap`,
        ) as Error & { name: string; param: string; byteLength: number; limit: number };
        err.name = 'RouteParamTooLargeError';
        err.param = name;
        err.byteLength = byteLen;
        err.limit = maxRouteParamBytes;
        throw err;
      }
      params[name] = decoded;
    }
    return { entry, params };
  }
  return null;
}

function buildMatch(
  entry: TanStackRouteEntry,
  params: Record<string, string>,
  pathname: string,
): SsrRouteMatch {
  const emptyQuery: Readonly<Record<string, string>> = {};
  return Object.freeze({
    filePath: entry.filePath,
    metaFilePath: null,
    params: Object.freeze(params),
    query: emptyQuery, // populated by middleware
    url: new URL(pathname, 'http://localhost'), // placeholder — middleware sets real URL
    loadingFilePath: null,
    errorFilePath: null,
    notFoundFilePath: null,
    forbiddenFilePath: null,
    unauthorizedFilePath: null,
    templateFilePath: null,
    loadModule: () => loadTanStackRouteModule(entry.filePath, entry.serverFilePath),
  });
}

function buildLayoutShell(layout: LayoutEntry, pathname: string): SsrRouteMatch {
  const emptyParams: Readonly<Record<string, string>> = {};
  const emptyQuery: Readonly<Record<string, string>> = {};
  return Object.freeze({
    filePath: layout.filePath,
    metaFilePath: null,
    params: emptyParams,
    query: emptyQuery,
    url: new URL(pathname, 'http://localhost'),
    loadingFilePath: null,
    errorFilePath: null,
    notFoundFilePath: null,
    forbiddenFilePath: null,
    unauthorizedFilePath: null,
    templateFilePath: null,
    loadModule: () =>
      loadTanStackLayoutModule(layout.filePath, layout.serverFilePath),
  });
}

function utf8ByteLength(value: string): number {
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(value, 'utf8');
  }
  return new TextEncoder().encode(value).length;
}
