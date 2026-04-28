// packages/slingshot-ssr/src/isr/types.ts

/**
 * A single cached ISR page entry.
 *
 * Stores the rendered HTML, response headers, and timing metadata needed
 * to implement stale-while-revalidate logic. Both memory and Redis adapters
 * use this shape — Redis serializes it as JSON.
 */
export interface IsrCacheEntry {
  /** The full rendered HTML string for this path. */
  readonly html: string;
  /**
   * HTTP status code of the original render.
   *
   * Stored so that cached 404s, redirects, or other non-200 responses are
   * replayed with their original status instead of always serving 200.
   * Defaults to 200 when not set (for backwards compatibility with older entries).
   */
  readonly status?: number;
  /**
   * Response headers captured at render time (e.g. `Content-Type`).
   * Re-applied when serving from cache.
   */
  readonly headers: Record<string, string>;
  /** Unix timestamp (ms) when this entry was generated. */
  readonly generatedAt: number;
  /**
   * Unix timestamp (ms) after which this entry is considered stale.
   * Computed as `generatedAt + revalidate * 1000`.
   * A stale entry triggers background regeneration but is still served immediately.
   */
  readonly revalidateAfter: number;
  /**
   * Cache tags associated with this entry.
   * Used by `revalidateTag()` to invalidate all pages sharing a tag
   * (e.g. all pages tagged `'posts'` when a post is mutated).
   */
  readonly tags: readonly string[];
}

/**
 * Interface for ISR cache backends.
 *
 * Implement this interface to provide a custom cache store. Two built-in
 * adapters are provided: `createMemoryIsrCache()` (single-instance) and
 * `createRedisIsrCache()` (multi-instance/distributed).
 *
 * All methods are async to allow network-backed implementations (Redis, KV stores).
 */
export interface IsrCacheAdapter {
  /**
   * Retrieve the cached entry for a URL path, or `null` on a miss.
   *
   * @param path - The URL pathname to look up (e.g. `'/posts/nba-finals'`).
   */
  get(path: string): Promise<IsrCacheEntry | null>;

  /**
   * Store a rendered entry for a URL path.
   *
   * The adapter is responsible for updating any tag index so that
   * `invalidateTag()` can find all paths associated with a given tag.
   *
   * @param path - The URL pathname to cache.
   * @param entry - The rendered entry to store.
   */
  set(path: string, entry: IsrCacheEntry): Promise<void>;

  /**
   * Remove the cached entry for a specific URL path.
   *
   * Tag index cleanup is adapter-defined — the memory adapter uses lazy cleanup,
   * the Redis adapter removes from the tag set immediately.
   *
   * @param path - The URL pathname to invalidate.
   */
  invalidatePath(path: string): Promise<void>;

  /**
   * Remove all cached entries tagged with the given tag.
   *
   * After this call, any subsequent request for those paths will bypass the
   * cache and trigger a fresh render.
   *
   * @param tag - The tag to invalidate (e.g. `'posts'`, `'post:abc123'`).
   */
  invalidateTag(tag: string): Promise<void>;
}

/**
 * ISR (Incremental Static Regeneration) configuration for `createSsrPlugin()`.
 *
 * When set, any loader returning `revalidate: N` causes the rendered HTML to be
 * stored in the configured adapter. Subsequent requests are served from cache
 * until the entry is stale, at which point it is regenerated in the background
 * (stale-while-revalidate).
 *
 * @example Memory adapter (default for single-instance deployments)
 * ```ts
 * createSsrPlugin({
 *   renderer,
 *   serverRoutesDir,
 *   assetsManifest,
 *   isr: {},  // uses createMemoryIsrCache() automatically
 * })
 * ```
 *
 * @example Redis adapter (multi-instance / distributed deployments)
 * ```ts
 * import { createRedisIsrCache } from '@lastshotlabs/slingshot-ssr/isr';
 * import Redis from 'ioredis';
 *
 * createSsrPlugin({
 *   renderer,
 *   serverRoutesDir,
 *   assetsManifest,
 *   isr: { adapter: createRedisIsrCache(new Redis()) },
 * })
 * ```
 */
export interface IsrConfig {
  /**
   * ISR cache adapter.
   *
   * Defaults to `createMemoryIsrCache()` when `isr: {}` is set without an adapter.
   * For multi-instance deployments, provide `createRedisIsrCache(redis)` to share
   * the cache across instances.
   */
  readonly adapter?: IsrCacheAdapter;
  /**
   * Maximum time to allow a stale-while-revalidate background regeneration to run.
   *
   * The stale response is returned immediately; this only bounds the detached
   * regeneration task so hung renderers do not keep worker resources alive forever.
   *
   * @default 30000
   */
  readonly backgroundRegenTimeoutMs?: number;
  /**
   * Maximum number of concurrent in-flight background regenerations the SSR
   * middleware will allow per cache instance. Excess regen requests are
   * dropped with a structured warn log entry rather than spawning unbounded
   * regen tasks under sustained stale traffic.
   *
   * P-SSR-1: prior versions had no cap; flaky upstreams or slow renderers
   * could accumulate regen tasks indefinitely.
   *
   * @default 32
   */
  readonly maxConcurrentRegenerations?: number;
  /**
   * Maximum time to wait for in-flight ISR cache writes to settle when the
   * SSR plugin is disposed. Cache writes are issued fire-and-forget on the
   * hot path; this bounds the graceful shutdown drain.
   *
   * P-SSR-7: prior versions could drop pending writes on graceful shutdown.
   *
   * @default 5000
   */
  readonly cacheFlushTimeoutMs?: number;
}

/**
 * A chainable transaction builder returned by `redis.multi()`.
 *
 * Calls to `set`/`sadd` queue commands inside the transaction and return the
 * same pipeline for chaining. `exec()` atomically executes the queued commands
 * and returns an array of results, or `null` if the transaction was aborted.
 *
 * Structurally compatible with ioredis `Pipeline`/`Multi` chains.
 */
export interface RedisMultiLike {
  set(key: string, value: string): RedisMultiLike;
  set(key: string, value: string, expiryMode: 'EX', time: number): RedisMultiLike;
  sadd(key: string, ...members: string[]): RedisMultiLike;
  /**
   * Execute the queued commands atomically.
   *
   * Returns an array of `[err, result]` tuples (ioredis style) or simple
   * results (some clients), or `null` when the transaction was aborted
   * (e.g. due to a failed WATCH/optimistic-lock condition).
   */
  exec(): Promise<unknown[] | null>;
}

/**
 * Minimal structural interface for a Redis client.
 *
 * Defined structurally so `slingshot-ssr` does not import `ioredis` directly.
 * Any Redis client that satisfies these method signatures is compatible
 * (ioredis, `@upstash/redis`, Bun's built-in Redis client, etc.).
 */
export interface RedisLike {
  /**
   * Set a key to a string value, optionally with an expiry.
   *
   * - `set(key, value)` — store without TTL (ISR SWR pattern: serve stale,
   *   let invalidation manage entry lifecycle).
   * - `set(key, value, 'EX', seconds)` — store with TTL in seconds.
   */
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, expiryMode: 'EX', time: number): Promise<unknown>;
  /** Get the string value of a key, or `null` if it does not exist. */
  get(key: string): Promise<string | null>;
  /** Delete one or more keys. */
  del(...keys: string[]): Promise<unknown>;
  /** Add one or more members to a Redis Set. */
  sadd(key: string, ...members: string[]): Promise<unknown>;
  /** Return all members of a Redis Set. */
  smembers(key: string): Promise<string[]>;
  /** Remove one or more members from a Redis Set. */
  srem(key: string, ...members: string[]): Promise<unknown>;
  /**
   * Begin a transactional pipeline. Used by the ISR Redis adapter to atomically
   * write the page entry and update the tag indexes in a single MULTI/EXEC so
   * that a failed SADD does not leave a SET behind without a tag entry.
   */
  multi(): RedisMultiLike;
}
