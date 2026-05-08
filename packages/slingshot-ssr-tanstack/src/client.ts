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
//        - SSR: snapshot's renderer passes loaderData as a prop directly.
//          We use the prop and DO NOT call `useLoaderData()` — there is no
//          TanStack RouterContext during SSR.
//
//        - CSR: TanStack's RouterProvider is mounted; `useLoaderData()`
//          works. We read from it.
//
//      The split is module-load-time, gated on `typeof window`. SSR build
//      and client build each receive the right variant; hooks-rules are
//      respected within each environment.
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
export async function fetchSsrLoader<TData = unknown>(
  ctx: SsrLoaderContext,
): Promise<TData> {
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

function buildUrl(ctx: SsrLoaderContext): string {
  // Prefer the resolved location pathname; fall back to assembling from params
  // is intentionally NOT supported — TanStack always populates `location` for
  // its loaders, and forcing the user to pre-build a path defeats the helper's
  // ergonomics.
  const pathname = ctx.location?.pathname ?? '/';
  const rawSearch = ctx.location?.searchStr ?? '';
  // Normalise to a leading-`?` form so the concatenation below is safe even
  // if a non-standard `searchStr` is passed in (e.g. tests, future TanStack
  // versions).
  const search =
    rawSearch.length === 0 || rawSearch.startsWith('?') ? rawSearch : `?${rawSearch}`;
  // Append `_data=1` so the request explicitly opts into JSON mode even if
  // a proxy normalises Accept headers. The slingshot middleware accepts
  // either signal.
  if (search.length === 0) return `${pathname}?_data=1`;
  // search === '?' alone is harmless: result is `/path?&_data=1` — the api
  // tolerates the empty pair. Avoid an extra branch for it.
  return `${pathname}${search}&_data=1`;
}

// ─── ssrAwareComponent ────────────────────────────────────────────────────────

/**
 * Wraps a page component so it reads `loaderData` from the right source for
 * the current execution environment.
 *
 * **Why this exists.** TanStack's `useLoaderData()` requires a RouterContext
 * provided by `<RouterProvider>`. During SSR, there's no RouterProvider —
 * snapshot's renderer instead passes loaderData to the matched component as
 * a `loaderData` prop. So:
 *
 *   - **server render**: read `loaderData` from props (no hook call).
 *   - **client render**: call `useLoaderData({ from: fromPath })`.
 *
 * The branch is on `typeof window` and is checked **per render**, not at
 * module load. A per-render check is safe because `typeof window` is stable
 * within a given execution environment — production SSR builds never see
 * `window`, browser builds always do — and it sidesteps test-environment
 * fragility (jsdom can be set up after the module is imported).
 *
 * The conditional hook call is fine in practice: React rules-of-hooks require
 * stable hook order *across renders of the same component instance*, and the
 * SSR-vs-CSR boundary is a fresh mount on the client. Within either side,
 * the branch is constant.
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
    if (typeof window === 'undefined') {
      return Page({ loaderData: (props.loaderData ?? null) as TLoaderData });
    }
    // Client render: TanStack's RouterProvider is mounted, hook works.
    // The conditional hook call across the SSR/CSR boundary is intentional;
    // it's a fresh component mount on the client, so React's rules-of-hooks
    // (which require consistent order *across renders of the same instance*)
    // are not violated.
    const loaderData = useLoaderData({ from: fromPath as never }) as TLoaderData;
    return Page({ loaderData });
  };
}

/** A page component that takes `loaderData` as a prop (Page module shape). */
type PageComponent<TLoaderData> = (props: { loaderData: TLoaderData }) => unknown;

/**
 * The shape consumed by TanStack's `component` option. SSR-time invocations
 * receive `loaderData` as a prop (passed by snapshot's renderer); CSR-time
 * invocations receive empty props (TanStack doesn't pass loaderData).
 */
type SsrAwarePageComponent<TLoaderData> = (props?: {
  loaderData?: TLoaderData;
}) => unknown;

import { useLoaderData } from '@tanstack/react-router';
