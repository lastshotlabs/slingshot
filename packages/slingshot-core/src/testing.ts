/**
 * Testing utilities for `@lastshotlabs/slingshot-core`.
 *
 * Import from `@lastshotlabs/slingshot-core/testing` — never from the main entry.
 */
import type { StoreInfra } from './storeInfra';

export { resetPackageStabilityWarnings } from './stability';

/**
 * Creates a minimal in-memory `StoreInfra` for use in tests.
 *
 * All getter methods throw with a descriptive message if called, since
 * memory-only tests should never need Redis, Mongo, SQLite, or Postgres.
 * Pass this as the `storeInfra` field of a fake `SlingshotFrameworkConfig`
 * in plugin unit tests.
 *
 * @example
 * ```ts
 * import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
 *
 * const fakeConfig: SlingshotFrameworkConfig = {
 *   ...otherFields,
 *   storeInfra: createMemoryStoreInfra(),
 * };
 * ```
 */
export function createMemoryStoreInfra(): StoreInfra {
  return {
    appName: 'test',
    getRedis() {
      throw new Error('[test] Redis not available in memory test environment');
    },
    getMongo() {
      throw new Error('[test] MongoDB not available in memory test environment');
    },
    getSqliteDb() {
      throw new Error('[test] SQLite not available in memory test environment');
    },
    getPostgres() {
      throw new Error('[test] Postgres not available in memory test environment');
    },
  };
}
