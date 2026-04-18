/**
 * Canonical backing store type union shared across all slingshot packages.
 *
 * Used as the key type in `RepoFactories<T>` and `CacheStoreName` so that a single
 * source-of-truth controls which stores are supported. Adding a new store here
 * propagates to auth adapters, framework persistence, and cache adapters automatically.
 *
 * @remarks
 * `'memory'` is always available without external dependencies, making it the
 * default for development, testing, and single-process deployments.
 */
export type StoreType = 'redis' | 'mongo' | 'sqlite' | 'memory' | 'postgres';
