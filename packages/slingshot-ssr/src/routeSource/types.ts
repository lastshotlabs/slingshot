// packages/slingshot-ssr/src/routeSource/types.ts
//
// `SsrRouteSource` — pluggable route discovery + resolution for slingshot-ssr.
//
// The SSR middleware no longer talks to the file-system directly. Instead it
// asks an `SsrRouteSource` to resolve a URL → route match. The default source
// is the file-based one (`createFileBasedRouteSource`), which preserves
// slingshot-ssr's historical behavior. Adapter packages can implement this
// interface to bring routes from a different system — e.g. TanStack Router's
// file-based tree, a custom config object, an in-memory test fixture.
//
// Design intent:
// - **Stable contract.** This is a public API that adapter authors pin against.
//   Everything the middleware needs is exposed here; nothing else.
// - **Sync resolve / async init.** Discovery may be async (filesystem, network,
//   imports). Per-request resolution is hot and must be sync.
// - **Backwards-compatible.** The existing module-level resolver functions
//   (`initRouteTree`, `resolveRoute`, `resolveRouteChain`,
//   `resolveGlobalMiddlewarePath`) remain exported from `@lastshotlabs/slingshot-ssr`.
//   Adapter authors can compose them; the file-based source already does.
import type { SsrRouteChain, SsrRouteMatch } from '../types';

/**
 * Per-call options for {@link SsrRouteSource.resolve}.
 */
export interface ResolveRouteOptions {
  /**
   * Maximum byte length of a single decoded route param value.
   * Sources that enforce this throw `RouteParamTooLargeError`.
   * @default 2048
   */
  readonly maxRouteParamBytes?: number;
}

/**
 * Per-call options for {@link SsrRouteSource.resolveChain}.
 */
export interface ResolveRouteChainOptions extends ResolveRouteOptions {
  /**
   * Source path for an interception navigation (the URL the user was on when
   * they clicked the link, sent in the `X-Snapshot-Navigate` header). Sources
   * that support route interception use this to pick an intercepted variant
   * over the canonical match. Sources that don't support interception ignore
   * this and return the canonical match.
   */
  readonly fromPath?: string;
}

/**
 * Pluggable route discovery + resolution.
 *
 * Implementations must be safe to call concurrently. State changes (init,
 * invalidate) happen at well-defined moments — boot and dev-mode file-watcher
 * notifications. Resolution (`resolve`, `resolveChain`,
 * `resolveGlobalMiddleware`) is called on every SSR request and must be sync
 * and side-effect-free.
 */
export interface SsrRouteSource {
  /**
   * Diagnostic label, e.g. `'file-based'` or `'tanstack'`. Used in logs and
   * error messages so misconfigurations can be traced to the source.
   */
  readonly id: string;

  /**
   * Initialise the source. Idempotent — safe to call multiple times.
   *
   * Called once at plugin boot (during `setupMiddleware`). May read the
   * filesystem, parse files, etc. Must complete before the SSR middleware
   * accepts traffic.
   *
   * Sources that have nothing to do here (e.g. an in-memory fixture) can
   * implement this as a no-op.
   */
  init(): Promise<void> | void;

  /**
   * Invalidate any cached state.
   *
   * Called by the dev-mode file watcher when files in the source's
   * jurisdiction change. Next call to `resolve` / `resolveChain` should
   * reflect the on-disk truth.
   *
   * Production deployments never call this.
   */
  invalidate(): void;

  /**
   * Resolve a URL pathname to a single route match.
   *
   * Returns `null` when no route matches. Throws `RouteParamTooLargeError`
   * when a decoded param exceeds `opts.maxRouteParamBytes`. The middleware
   * catches that and returns 414.
   *
   * Used by callers that don't need the full layout chain (e.g. metadata
   * generators).
   */
  resolve(pathname: string, opts?: ResolveRouteOptions): SsrRouteMatch | null;

  /**
   * Resolve a URL pathname to a full route chain (page + layouts + slots).
   *
   * Returns `null` when no route matches. Throws `RouteParamTooLargeError`
   * when a decoded param exceeds `opts.maxRouteParamBytes`.
   *
   * Sources that don't model layouts return a chain with `layouts: []`.
   */
  resolveChain(pathname: string, opts?: ResolveRouteChainOptions): SsrRouteChain | null;

  /**
   * Absolute path to a global middleware module, or `null` when none exists.
   *
   * The SSR middleware imports and runs this for every request that didn't
   * match a concrete route, so unmatched paths can still redirect or rewrite.
   *
   * Sources that don't support a global middleware file return `null`.
   */
  resolveGlobalMiddleware(): string | null;
}
