import { useLoaderData, useRouter } from '@tanstack/react-router';

// packages/slingshot-ssr-tanstack/src/client.ts
//
// Client-side helpers for TanStack Router routes whose data flows through
// slingshot-ssr.
//
// Two patterns work together to make the same route component render
// correctly in three contexts (SSR first paint, hydration on initial load,
// and soft client-side navigation between SSR routes):
//
//   1. **`fetchSsrLoader`** — drop-in TanStack `loader` option that hits the
//      route's own URL with `Accept: application/json`. The slingshot-ssr
//      middleware runs the route's `.server.ts#load` and returns the loader
//      result as JSON. So one loader, two delivery channels.
//
//   2. **`ssrAwareComponent`** — wrap the page module to read `loaderData`
//      from the right place per environment:
//
//        - SSR render + SSR hydration: the host passes loaderData as a prop
//          directly (snapshot's renderer on the server, the hydration entry
//          in the browser). We use the prop and DO NOT call `useLoaderData()`
//          — there is no TanStack RouterContext in either context.
//
//        - Soft client-side navigation: TanStack's RouterProvider mounted the
//          component and passes no props; `useLoaderData()` works. We read
//          from it.
//
//      The split is per-render: prop presence decides, with `typeof window`
//      as the server-side backstop. Hook order stays stable because any
//      given component instance is mounted by exactly one of the two hosts.
//
//      This avoids constructing a full TanStack Router during SSR (which
//      would require pre-populating router state with our SSR-computed
//      loader data, a significantly larger surface).
//
// Usage:
//
//   ```tsx
//   // apps/web/src/routes/u/$handle.tsx
//   import { createFileRoute } from '@tanstack/react-router';
//   import { fetchSsrLoader } from '@lastshotlabs/slingshot-ssr-tanstack/client';
//   import { ProfilePage } from '@sgforum/ui/pages/ProfilePage';
//
//   export const Route = createFileRoute('/u/$handle')({
//     component: ProfilePage,
//     loader: fetchSsrLoader,
//   });
//   ```
//
// What you get:
//   - Client navigation: `useLoaderData()` returns the same `data` shape that
//     `<route>.server.ts#load` returned for the SSR first-paint.
//   - Redirect signals are handled by performing a real navigation.
//   - 401/403/404 throw with a structured cause so TanStack's `errorComponent`
//     and `notFoundComponent` can render appropriately.

/**
 * Loader context shape that TanStack Router passes. We type only what we
 * read so we don't pin to a specific @tanstack/react-router version.
 */
interface SsrLoaderContext {
  readonly abortController?: AbortController;
  readonly location?: { readonly pathname?: string; readonly searchStr?: string };
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly context?: unknown;
}

/** Hydration-window source of loader data that a host SSR renderer computed. */
export interface SsrLoaderDataSource {
  consume(
    href: string,
  ): { readonly found: true; readonly data: unknown } | { readonly found: false };
}

/**
 * Create a preload source for a TanStack router context.
 *
 * A host that ran the route's server loader before constructing TanStack's
 * router can pass this source as `context.slingshotSsrLoaderData`. TanStack may
 * invoke the initial loader more than once while establishing its match tree,
 * so the source remains readable for the hydration window. The host removes it
 * after hydration; later navigations then use the normal `_data=1` protocol.
 */
export function createSsrLoaderDataSource(href: string, data: unknown): SsrLoaderDataSource {
  return {
    consume(candidate: string) {
      if (candidate !== href) return { found: false };
      return { found: true, data };
    },
  };
}

/**
 * Loader return shape produced by slingshot-ssr's JSON-mode response.
 * Everything other than `data` is metadata the page may inspect via
 * `useLoaderData()` (we expose it as-is).
 */
export interface SsrLoaderResult<TData = unknown> {
  readonly data: TData;
  readonly meta?: unknown;
  readonly tags?: readonly string[];
  readonly revalidate?: number | false;
  readonly queryCache?: readonly { queryKey: readonly unknown[]; data: unknown }[];
}

/**
 * Error thrown by `fetchSsrLoader` when the SSR loader returned a 401/403/404
 * signal or the network request failed. Caller's `errorComponent` /
 * `notFoundComponent` can introspect via `cause`.
 */
export class SsrLoaderError extends Error {
  readonly status: number;
  readonly cause: unknown;
  constructor(message: string, status: number, cause: unknown) {
    super(message);
    this.name = 'SsrLoaderError';
    this.status = status;
    this.cause = cause;
  }
}

/**
 * TanStack `loader` implementation that fetches the route's URL with
 * `Accept: application/json`.
 *
 * Drop-in: pass directly as `loader` on `createFileRoute(...)({ loader })`.
 */
export async function fetchSsrLoader<TData = unknown>(ctx: SsrLoaderContext): Promise<TData> {
  const href = buildHref(ctx);
  const preloaded = readLoaderDataSource(ctx.context)?.consume(href);
  if (preloaded?.found) return preloaded.data as TData;

  const url = buildUrl(ctx);
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    signal: ctx.abortController?.signal,
  });

  // Read body once as text so we can differentiate empty bodies (which
  // typically indicate the SSR middleware didn't match the URL and the
  // request fell through to the SPA fallback / dev-server proxy) from
  // structured JSON loader signals.
  const rawBody = await res.text();

  if (rawBody.length === 0) {
    // Empty 404/etc — the URL doesn't have a `.server.ts` companion or
    // doesn't match an SSR route at all. Surface as a TanStack notFound.
    throw new SsrLoaderError(
      `SSR loader for ${url} returned empty body (status ${res.status}). ` +
        `This usually means no .server.ts companion is registered for this route.`,
      res.status === 0 ? 404 : res.status,
      null,
    );
  }

  if (res.status >= 500) {
    throw new SsrLoaderError(
      `SSR loader for ${url} returned ${res.status}: ${rawBody.slice(0, 200)}`,
      res.status,
      rawBody,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // Non-JSON body — likely HTML from the SPA fallback. Caller hit a URL
    // that flowed through the wrong handler; surface a clear error.
    throw new SsrLoaderError(
      `SSR loader for ${url} returned non-JSON body (status ${res.status}): ${rawBody.slice(0, 200)}`,
      res.status,
      rawBody,
    );
  }

  if (typeof body['redirect'] === 'string') {
    // Navigate the browser to the target. TanStack Router's standard
    // `redirect()` throw isn't accessible here without a router import; the
    // simplest correct behavior is to set `location.href` so the browser
    // performs a normal navigation, which TanStack picks up.
    if (typeof window !== 'undefined') {
      window.location.href = body['redirect'] as string;
    }
    // Throw to halt loader resolution; caller's error boundary won't render
    // because navigation is already in flight.
    throw new SsrLoaderError(
      `SSR loader requested redirect to ${body['redirect'] as string}`,
      302,
      body,
    );
  }
  if (body['notFound'] === true) {
    throw new SsrLoaderError('Not found', 404, body);
  }
  if (body['forbidden'] === true) {
    throw new SsrLoaderError('Forbidden', 403, body);
  }
  if (body['unauthorized'] === true) {
    throw new SsrLoaderError('Unauthorized', 401, body);
  }

  // Success path. The full SsrLoaderResult is on `body`; expose just the
  // `data` field via TanStack's loader API. Components access it via
  // `useLoaderData()`.
  return (body['data'] ?? null) as TData;
}

function readLoaderDataSource(context: unknown): SsrLoaderDataSource | undefined {
  if (typeof context !== 'object' || context === null) return undefined;
  const source = (context as { slingshotSsrLoaderData?: unknown }).slingshotSsrLoaderData;
  if (typeof source !== 'object' || source === null) return undefined;
  return typeof (source as { consume?: unknown }).consume === 'function'
    ? (source as SsrLoaderDataSource)
    : undefined;
}

function buildUrl(ctx: SsrLoaderContext): string {
  // Prefer the resolved location pathname; fall back to assembling from params
  // is intentionally NOT supported — TanStack always populates `location` for
  // its loaders, and forcing the user to pre-build a path defeats the helper's
  // ergonomics.
  const href = buildHref(ctx);
  const separator = href.includes('?') ? '&' : '?';
  return `${href}${separator}_data=1`;
}

function buildHref(ctx: SsrLoaderContext): string {
  const pathname = ctx.location?.pathname ?? '/';
  const rawSearch = ctx.location?.searchStr ?? '';
  // Normalise to a leading-`?` form so the concatenation below is safe even
  // if a non-standard `searchStr` is passed in (e.g. tests, future TanStack
  // versions).
  const search = rawSearch.length === 0 || rawSearch.startsWith('?') ? rawSearch : `?${rawSearch}`;
  return `${pathname}${search}`;
}

// ─── ssrAwareComponent ────────────────────────────────────────────────────────

/**
 * Wraps a page component so it reads `loaderData` from the right source for
 * the current execution environment.
 *
 * **Why this exists.** TanStack's `useLoaderData()` requires a RouterContext
 * provided by `<RouterProvider>`. Two render paths run without one: SSR
 * (snapshot's renderer) and browser hydration of SSR markup (the app's
 * hydration entry). Both pass loaderData to the matched component as a
 * `loaderData` prop instead. So:
 *
 *   - **prop present**: read `loaderData` from props (Snapshot's routerless
 *     SSR/hydration host).
 *   - **router context present**: read TanStack loader data. This includes
 *     router-owned SSR as well as browser navigation.
 *   - **neither present**: normalize to null for a routerless host.
 *
 * The branch is checked **per render**, keyed on prop presence with
 * `typeof window` as the server-side backstop. Keying on `typeof window`
 * alone was a shipped bug: hydration happens in a browser, so the old check
 * routed it to the hook, which threw ("useRouter must be used inside a
 * <RouterProvider>") and blanked every SSR page the moment JS ran.
 *
 * The conditional hook call is fine in practice: React rules-of-hooks require
 * stable hook order *across renders of the same component instance*, and a
 * given instance is mounted either by a prop-passing host (SSR/hydration) or
 * by TanStack (never passes the prop) — it never switches sides mid-life.
 *
 * @example
 * ```tsx
 * import { createFileRoute } from '@tanstack/react-router';
 * import { ssrAwareComponent, fetchSsrLoader } from '@lastshotlabs/slingshot-ssr-tanstack/client';
 * import ProfilePage from '@sgforum/ui/pages/ProfilePage';
 *
 * export const Route = createFileRoute('/_public/u/$handle')({
 *   component: ssrAwareComponent(ProfilePage, '/_public/u/$handle'),
 *   loader: fetchSsrLoader,
 * });
 * ```
 */
export function ssrAwareComponent<TLoaderData>(
  Page: PageComponent<TLoaderData>,
  fromPath: string,
): SsrAwarePageComponent<TLoaderData> {
  return function SsrAwareComponent(props = {}) {
    const router = useRouter({ warn: false });
    // A `loaderData` prop (even null) means the host render tree supplied the
    // data directly — SSR render AND browser hydration of SSR markup, both of
    // which run without a TanStack RouterProvider. `typeof window` alone is
    // NOT a safe discriminator: hydration happens in a browser too, and
    // calling `useLoaderData()` there throws ("useRouter must be used inside
    // a <RouterProvider>"), unwinding React and blanking the page.
    if (props.loaderData !== undefined) {
      return Page({ loaderData: (props.loaderData ?? null) as TLoaderData });
    }
    if (router) {
      const loaderData = useLoaderData({ from: fromPath as never }) as TLoaderData;
      return Page({ loaderData });
    }
    return Page({ loaderData: null as TLoaderData });
  };
}

/** A page component that takes `loaderData` as a prop (Page module shape). */
type PageComponent<TLoaderData> = (props: { loaderData: TLoaderData }) => unknown;

/**
 * The shape consumed by TanStack's `component` option. SSR-time invocations
 * receive `loaderData` as a prop (passed by snapshot's renderer); CSR-time
 * invocations receive empty props (TanStack doesn't pass loaderData).
 */
type SsrAwarePageComponent<TLoaderData> = (props?: { loaderData?: TLoaderData }) => unknown;
