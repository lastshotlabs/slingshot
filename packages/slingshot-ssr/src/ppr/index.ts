// packages/slingshot-ssr/src/ppr/index.ts
// Build-time PPR (Partial Prerendering) shell pre-computation.
//
// Call `prerenderPprShells()` after the Vite build to pre-render the static
// shells for all PPR-enabled routes. The resulting shells are stored in the
// provided `PprCache` and served instantly at request time.
// Avoid importing from 'react' directly — @types/react may not be in this
// package's devDependencies. Use a structural type compatible with ReactElement.
import { createConsoleLogger } from '@lastshotlabs/slingshot-core';

const logger = createConsoleLogger({ base: { component: 'slingshot-ssr' } });

type ReactElement = { type: unknown; props: unknown; key: string | null };

// ─── Cross-repo structural types ──────────────────────────────────────────────
// We deliberately avoid importing from @lastshotlabs/snapshot to prevent a
// circular dependency between the two packages. Instead we use structural
// typing (Rule 9: structural typing — no forced imports).

/**
 * Structural equivalent of `PprShell` from `@lastshotlabs/snapshot/ssr`.
 * @internal
 */
interface PprShellShape {
  shellHtml: string;
  ok: boolean;
}

/**
 * Structural equivalent of `PprCache` from `@lastshotlabs/snapshot/ssr`.
 *
 * Passed by the consumer app (which imports from both packages) so that
 * `slingshot-ssr` never imports from `snapshot` directly.
 */
export interface PprCacheShape {
  /**
   * Store a pre-computed shell for a route path.
   * @param path - URL pathname the shell covers.
   * @param shell - The extracted shell result.
   */
  set(path: string, shell: PprShellShape): void;
  /**
   * Returns `true` when a shell is already cached for this path.
   * @param path - URL pathname to check.
   */
  has(path: string): boolean;
}

// ─── Route descriptor ─────────────────────────────────────────────────────────

/**
 * A PPR-enabled route descriptor passed to `prerenderPprShells()`.
 *
 * The caller is responsible for constructing the `element` (the full React
 * tree for this route, including all providers) before calling the build step.
 */
export interface PprRouteDescriptor {
  /**
   * The URL pathname this route serves (e.g. `'/dashboard'`, `'/home'`).
   * Used as the cache key in the `PprCache`.
   */
  path: string;
  /**
   * The fully constructed React element tree for this route.
   * Should include all providers (QueryClientProvider, etc.) so that the
   * shell extraction sees the same tree that runs at request time.
   */
  element: ReactElement;
}

// ─── Build-time pre-renderer ──────────────────────────────────────────────────

/**
 * PPR build-time pre-rendering.
 *
 * Call this after the Vite build to pre-compute static shells for all PPR routes.
 * Each route's element is rendered via `extractPprShell()` (from snapshot/ssr);
 * successful shells are stored in `cache` keyed by route path.
 *
 * **Usage pattern:**
 * ```ts
 * import { prerenderPprShells } from '@lastshotlabs/slingshot-ssr/ppr'
 * import { createPprCache, extractPprShell } from '@lastshotlabs/snapshot/ssr'
 *
 * const pprCache = createPprCache()
 *
 * await prerenderPprShells(
 *   [
 *     { path: '/dashboard', element: <DashboardPage loaderData={...} /> },
 *     { path: '/home',      element: <HomePage loaderData={...} />      },
 *   ],
 *   pprCache,
 *   // Pass extractPprShell from snapshot/ssr — avoids circular dep
 *   extractPprShell,
 * )
 * ```
 *
 * **Why pass `extractPprShell` as a parameter?**
 * `slingshot-ssr` must not import from `@lastshotlabs/snapshot` to avoid a
 * circular package dependency. The consumer app imports both packages and passes
 * `extractPprShell` as a callback — structural typing ensures compatibility.
 *
 * @param routes - Array of PPR-enabled route descriptors (path + React element).
 * @param cache - PPR shell cache to write into. Use `createPprCache()` from snapshot/ssr.
 * @param extractShell - The `extractPprShell` function from `@lastshotlabs/snapshot/ssr`.
 *   Injected to avoid a hard dependency from slingshot-ssr → snapshot.
 */
export async function prerenderPprShells(
  routes: readonly PprRouteDescriptor[],
  cache: PprCacheShape,
  extractShell: (element: ReactElement) => Promise<PprShellShape>,
): Promise<void> {
  if (routes.length === 0) {
    logger.info('[slingshot-ssr] PPR: no routes to pre-render.');
    return;
  }

  logger.info(`[slingshot-ssr] PPR: pre-rendering ${routes.length} static shell(s)…`);

  // Pre-render shells concurrently — each extraction is independent.
  const results = await Promise.allSettled(
    routes.map(async route => {
      const shell = await extractShell(route.element);
      cache.set(route.path, shell);

      if (shell.ok) {
        logger.info(`[slingshot-ssr] PPR: ✓ ${route.path} (${shell.shellHtml.length} bytes)`);
      } else {
        logger.warn(`[slingshot-ssr] PPR: ✗ ${route.path} — shell extraction failed`);
      }

      return { path: route.path, ok: shell.ok };
    }),
  );

  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  const succeeded = results.filter(
    (r): r is PromiseFulfilledResult<{ path: string; ok: boolean }> =>
      r.status === 'fulfilled' && r.value.ok,
  );

  logger.info(
    `[slingshot-ssr] PPR: pre-render complete — ${succeeded.length} succeeded, ${failed.length} failed.`,
  );

  if (failed.length > 0) {
    for (const failure of failed) {
      logger.error('[slingshot-ssr] PPR shell extraction rejected:', failure.reason);
    }
  }
}
