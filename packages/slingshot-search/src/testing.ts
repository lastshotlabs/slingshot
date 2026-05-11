/**
 * Testing utilities for slingshot-search.
 *
 * Provides pre-configured search providers and plugins for use in tests.
 * Uses the DB-native (in-memory) provider — no external services required.
 */
import type { SlingshotPackageDefinition } from '@lastshotlabs/slingshot-core';
import { createSearchPackage } from './plugin';
import { createDbNativeProvider } from './providers/dbNative';
import type { SearchPluginConfig } from './types/config';
import type { SearchProvider } from './types/provider';

/**
 * Create a DB-native search provider pre-configured for testing.
 *
 * Returns an in-memory `SearchProvider` backed by DB-native queries —
 * no external search service required. Each call returns a fresh instance
 * with its own isolated state.
 *
 * @returns A `SearchProvider` suitable for unit and integration tests.
 *
 * @example
 * ```ts
 * import { createTestSearchProvider } from '@lastshotlabs/slingshot-search/testing';
 *
 * const provider = createTestSearchProvider();
 * await provider.connect();
 * ```
 */
export function createTestSearchProvider(): SearchProvider {
  return createDbNativeProvider();
}

/**
 * Create a pre-configured search package with the DB-native provider for test apps.
 *
 * Provides a zero-config search package suitable for `createApp({ packages: [...] })`
 * in tests. Uses `autoCreateIndexes: true` so entities with `search` config get
 * indexes without extra setup. Accepts optional overrides to customize the config.
 *
 * @param overrides - Optional partial `SearchPluginConfig` to merge on top of
 *   the test defaults.
 * @returns A `SlingshotPackageDefinition` ready for `createApp({ packages })`.
 *
 * @example
 * ```ts
 * import { createTestSearchPackage } from '@lastshotlabs/slingshot-search/testing';
 *
 * const search = createTestSearchPackage();
 * const { app } = await createApp({
 *   routesDir: import.meta.dir + '/routes',
 *   packages: [search],
 * });
 * ```
 */
export function createTestSearchPackage(
  overrides?: Partial<SearchPluginConfig>,
): SlingshotPackageDefinition {
  return createSearchPackage({
    providers: {
      default: { provider: 'db-native' },
    },
    autoCreateIndexes: true,
    ...overrides,
  });
}
