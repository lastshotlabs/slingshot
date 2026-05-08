// packages/slingshot-ssr-tanstack/src/loader.ts
//
// Module-loader adapter — bridges the TanStack-route + companion-file pair to
// the canonical slingshot-ssr shape.
//
// Companion-file convention (the only supported form post-`v1`):
//
//   `<route>.tsx`        — TanStack route file:
//                            export const Route = createFileRoute(...)({ component, ... })
//
//   `<route>.server.ts`  — server-only loader (stripped from client bundle):
//                            export async function load(ctx) { ... }
//                            export const meta?: (ctx, result) => ...
//
// On the server, we import both files and stitch them into slingshot-ssr's
// canonical `{ load, meta?, default: Page }` shape. On the client, the
// `.server.ts` file is rewritten to an empty module by the Vite plugin and
// `Route.options.component` is what mounts.
//
// Routes with no companion file are CSR-only and not handled here — the
// scanner filters them out before this module sees them.

import type { SsrLoadContext, SsrLoadResult, SsrMeta } from '@lastshotlabs/slingshot-ssr';

/** TanStack `createFileRoute(...)({ ... })` produces a Route object. */
interface TanStackRouteShape {
  readonly options?: {
    readonly component?: unknown;
    // We intentionally do not consume `loader`, `errorComponent`, etc. The
    // SSR loader is `<route>.server.ts#load`; client-side data fetching uses
    // the helper that hits the URL with `Accept: application/json`.
  };
}

/** Slingshot's canonical route-module shape — what `executeRouteModule` consumes. */
export interface CanonicalRouteModule {
  readonly load: (ctx: SsrLoadContext) => Promise<SsrLoadResult<Record<string, unknown>>>;
  readonly meta?: (
    ctx: SsrLoadContext,
    result: SsrLoadResult<Record<string, unknown>>,
  ) => Promise<SsrMeta>;
  readonly default: (props: {
    loaderData: Record<string, unknown>;
    params: Readonly<Record<string, string>>;
    query: Readonly<Record<string, string>>;
  }) => unknown;
}

/** Server companion module. */
interface ServerCompanionExports {
  readonly load: CanonicalRouteModule['load'];
  readonly meta?: CanonicalRouteModule['meta'];
}

/**
 * Per-route module cache. Keyed by the route file path; value is the resolved
 * canonical module (component + companion's load/meta).
 */
const moduleCache = new Map<string, Promise<CanonicalRouteModule>>();

/**
 * Load a TanStack route file together with its server companion and adapt
 * their exports to slingshot-ssr's canonical module shape.
 *
 * Throws when the companion is missing (the scanner should have filtered the
 * route out of the SSR set), when the companion lacks a `load` function, or
 * when the route file has no `Route.options.component`.
 */
export function loadTanStackRouteModule(
  routeFilePath: string,
  serverFilePath: string | null,
): Promise<CanonicalRouteModule> {
  let pending = moduleCache.get(routeFilePath);
  if (pending) return pending;

  pending = (async () => {
    const route = (await import(routeFilePath)) as Record<string, unknown>;
    const Route = route['Route'] as TanStackRouteShape | undefined;
    const Component = Route?.options?.component;
    if (typeof Component !== 'function') {
      throw new Error(
        `[slingshot-ssr-tanstack] route module '${routeFilePath}' has no 'Route' export ` +
          `with an 'options.component'. Ensure the file uses createFileRoute(...)({ component }).`,
      );
    }

    if (serverFilePath === null) {
      // The scanner should never let a leaf without a companion file reach
      // this loader — guard for callers that wire layouts in by hand.
      return Object.freeze({
        load: noopLoad,
        default: Component as CanonicalRouteModule['default'],
      });
    }

    const server = (await import(serverFilePath)) as Partial<ServerCompanionExports>;
    if (typeof server.load !== 'function') {
      throw new Error(
        `[slingshot-ssr-tanstack] companion file '${serverFilePath}' has no 'load' export. ` +
          `Add:\n\n` +
          `    export async function load(ctx) {\n      return { data: { ... } };\n    }\n`,
      );
    }

    return Object.freeze({
      load: server.load,
      meta: server.meta,
      default: Component as CanonicalRouteModule['default'],
    });
  })();

  moduleCache.set(routeFilePath, pending);
  return pending;
}

/** Load a layout file. Layouts may or may not have companion server files. */
export function loadTanStackLayoutModule(
  layoutFilePath: string,
  serverFilePath: string | null,
): Promise<CanonicalRouteModule> {
  return loadTanStackRouteModule(layoutFilePath, serverFilePath);
}

/** Test helper — clear the module cache between cases. */
export function clearTanStackModuleCache(): void {
  moduleCache.clear();
}

/**
 * No-op loader for layouts without server-side data needs. Returns an empty
 * `data` object so `executeRouteModule` can treat the layout uniformly with
 * leaf routes.
 */
const noopLoad: CanonicalRouteModule['load'] = async () => {
  const empty: Record<string, unknown> = {};
  const result: SsrLoadResult<Record<string, unknown>> = { data: empty };
  return result;
};
