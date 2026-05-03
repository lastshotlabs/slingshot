// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-ssg/testing — Test utilities
// ---------------------------------------------------------------------------

/** Standard timeout for SSG render operations in tests. */
export const TEST_SSG_RENDER_TIMEOUT_MS = 30_000;

/** Exit codes returned by the SSG CLI. */
export { SsgExitCode, resolveExitCode } from './cli';

/** Create a minimal valid SSG config for testing. */
export function createTestSsgConfig(overrides?: {
  outDir?: string;
  baseUrl?: string;
  routes?: readonly string[];
}) {
  return {
    outDir: overrides?.outDir ?? '/tmp/ssg-test-out',
    baseUrl: overrides?.baseUrl ?? 'https://example.test',
    routes: overrides?.routes ?? ['/'],
  };
}
