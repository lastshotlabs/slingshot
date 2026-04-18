/**
 * Testing utilities for slingshot-search.
 *
 * Provides pre-configured search providers and plugins for use in tests.
 * Uses the DB-native (in-memory) provider — no external services required.
 */
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { createSearchPlugin } from './plugin';
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
 * Create a pre-configured search plugin with the DB-native provider for test apps.
 *
 * Provides a zero-config search plugin suitable for `createApp()` in tests.
 * Uses `autoCreateIndexes: true` so entities with `search` config get indexes
 * without extra setup. Accepts optional overrides to customize the plugin config.
 *
 * @param overrides - Optional partial `SearchPluginConfig` to merge on top of
 *   the test defaults.
 * @returns A `SlingshotPlugin` with name `'slingshot-search'`.
 *
 * @example
 * ```ts
 * import { createTestSearchPlugin } from '@lastshotlabs/slingshot-search/testing';
 *
 * const search = createTestSearchPlugin();
 * const { app } = await createApp({
 *   routesDir: import.meta.dir + '/routes',
 *   plugins: [search],
 * });
 * ```
 */
export function createTestSearchPlugin(overrides?: Partial<SearchPluginConfig>): SlingshotPlugin {
  return createSearchPlugin({
    providers: {
      default: { provider: 'db-native' },
    },
    autoCreateIndexes: true,
    ...overrides,
  });
}
