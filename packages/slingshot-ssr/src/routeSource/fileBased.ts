// packages/slingshot-ssr/src/routeSource/fileBased.ts
//
// `createFileBasedRouteSource` — slingshot-ssr's historical route discovery
// behavior, now expressed through the {@link SsrRouteSource} interface.
//
// This is a thin wrapper around the module-level resolver functions in
// `../resolver`. Those functions remain exported from the package's public
// surface (so external callers like `slingshot-ssg` continue to work without
// modification). New code should consume routes via this source.
import {
  initRouteTree,
  invalidateRouteTree,
  resolveGlobalMiddlewarePath,
  resolveRoute,
  resolveRouteChain,
} from '../resolver';
import type { ResolveRouteChainOptions, ResolveRouteOptions, SsrRouteSource } from './types';

/**
 * Configuration for {@link createFileBasedRouteSource}.
 */
export interface FileBasedRouteSourceConfig {
  /**
   * Absolute path to the directory containing SSR route modules.
   *
   * The directory is scanned for `.tsx` / `.ts` files using slingshot-ssr's
   * conventions: `[param]` for dynamic segments, `[...rest]` for catch-alls,
   * `meta.ts` / `error.ts` / `loading.ts` / `not-found.ts` / `forbidden.ts` /
   * `unauthorized.ts` / `template.ts` co-located helpers, and a top-level
   * `middleware.ts` for global middleware.
   */
  readonly serverRoutesDir: string;
}

/**
 * Build the default file-based route source.
 *
 * This is what `createSsrPackage` uses when no explicit `routeSource` is
 * configured. Existing apps that pass `serverRoutesDir` to `createSsrPackage`
 * get this source behind the scenes — no migration needed.
 *
 * @example
 * ```ts
 * createSsrPackage({
 *   renderer,
 *   routeSource: createFileBasedRouteSource({
 *     serverRoutesDir: path.resolve(import.meta.dir, 'server/routes'),
 *   }),
 *   assetsManifest: '...',
 * });
 * ```
 */
export function createFileBasedRouteSource(config: FileBasedRouteSourceConfig): SsrRouteSource {
  const dir = config.serverRoutesDir;

  return {
    id: 'file-based',

    init(): void {
      initRouteTree(dir);
    },

    invalidate(): void {
      invalidateRouteTree(dir);
    },

    resolve(pathname, opts) {
      return resolveRoute(pathname, dir, normalizeRouteOptions(opts));
    },

    resolveChain(pathname, opts) {
      return resolveRouteChain(pathname, dir, opts?.fromPath, normalizeRouteOptions(opts));
    },

    resolveGlobalMiddleware(): string | null {
      return resolveGlobalMiddlewarePath(dir);
    },
  };
}

function normalizeRouteOptions(opts: ResolveRouteOptions | ResolveRouteChainOptions | undefined): {
  maxRouteParamBytes?: number;
} {
  if (!opts) return {};
  return opts.maxRouteParamBytes !== undefined
    ? { maxRouteParamBytes: opts.maxRouteParamBytes }
    : {};
}
