// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-ssr/testing — Test utilities
// ---------------------------------------------------------------------------
import type { SlingshotSsrRenderer, SsrRouteChain, SsrRouteMatch } from './types';

/** Standard timeout for SSR render operations in tests. */
export const TEST_SSR_RENDER_TIMEOUT_MS = 30_000;

/**
 * Create a minimal valid SSR plugin config for testing.
 *
 * Returns a frozen config object that passes `ssrPluginConfigSchema.parse()`
 * with sensible defaults for unit and integration tests.
 */
export function createTestSsrConfig(overrides?: {
  serverRoutesDir?: string;
  assetsManifest?: string;
  devMode?: boolean;
  renderer?: Partial<SlingshotSsrRenderer>;
}) {
  return Object.freeze({
    renderer: makeMockRenderer(overrides?.renderer),
    serverRoutesDir: overrides?.serverRoutesDir ?? '/fake/routes',
    assetsManifest: overrides?.assetsManifest ?? '/fake/manifest.json',
    devMode: overrides?.devMode ?? true,
  });
}

/**
 * Create a minimal {@link SsrRouteMatch} for testing.
 */
export function makeRouteMatch(url?: URL): SsrRouteMatch {
  return {
    filePath: '/fake/route.ts',
    metaFilePath: null,
    params: {},
    query: {},
    url: url ?? new URL('http://localhost:3000/test'),
    loadingFilePath: null,
    errorFilePath: null,
    notFoundFilePath: null,
    forbiddenFilePath: null,
    unauthorizedFilePath: null,
    templateFilePath: null,
  };
}

/**
 * Create a mock {@link SlingshotSsrRenderer} for testing.
 *
 * All methods return successful responses by default. Pass overrides
 * to simulate specific renderer behaviors (errors, redirects, etc.).
 */
export function makeMockRenderer(
  overrides?: Partial<SlingshotSsrRenderer>,
): SlingshotSsrRenderer {
  return {
    resolve: async (url): Promise<SsrRouteMatch> => makeRouteMatch(url),
    render: async () =>
      new Response('<html>SSR</html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    renderChain: async (chain: SsrRouteChain) =>
      new Response(`<html>SSR chain ${chain.page.url.pathname}</html>`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    ...overrides,
  };
}
