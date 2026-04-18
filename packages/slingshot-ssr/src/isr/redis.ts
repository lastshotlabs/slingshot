// packages/slingshot-ssr/src/isr/redis.ts
import type { IsrCacheAdapter, IsrCacheEntry, RedisLike } from './types';

/** Redis key prefix for ISR page entries. */
const PAGE_PREFIX = 'isr:page:';
/** Redis key prefix for ISR tag index (Redis Sets). */
const TAG_PREFIX = 'isr:tag:';

function pageKey(path: string): string {
  return `${PAGE_PREFIX}${path}`;
}

function tagKey(tag: string): string {
  return `${TAG_PREFIX}${tag}`;
}

/**
 * Create a Redis-backed ISR cache adapter.
 *
 * Page entries are stored as JSON strings **without a TTL** so that stale
 * entries are served immediately (stale-while-revalidate) while a background
 * regeneration populates a fresh entry. Staleness is determined at read time
 * by comparing `entry.revalidateAfter` against `Date.now()` — the caller
 * (middleware) is responsible for that check.
 *
 * Setting `EX` equal to `revalidateAfter - now()` would cause hard cache
 * misses (404 → full render on the hot path) instead of the intended SWR
 * behaviour (serve stale → regen in background). The entry lifecycle is
 * managed by explicit invalidation via `invalidatePath` / `invalidateTag`.
 *
 * Tag membership is tracked using Redis Sets: each tag key holds the set of
 * paths that carry that tag.
 *
 * **Key scheme:**
 * - Page entries: `isr:page:{path}` — JSON-serialized {@link IsrCacheEntry}, no TTL
 * - Tag index:    `isr:tag:{tag}`   — Redis Set of paths
 *
 * **Suitable for:** Multi-instance / distributed deployments where the cache
 * must be shared across processes or servers.
 *
 * @param redis - Any Redis client satisfying the {@link RedisLike} interface.
 *   Structurally compatible with `ioredis`, `@upstash/redis`, and Bun's built-in Redis.
 * @returns An {@link IsrCacheAdapter} backed by Redis.
 *
 * @example
 * ```ts
 * import { createRedisIsrCache } from '@lastshotlabs/slingshot-ssr/isr';
 * import Redis from 'ioredis';
 *
 * const redis = new Redis(process.env.REDIS_URL);
 * const cache = createRedisIsrCache(redis);
 * ```
 */
export function createRedisIsrCache(redis: RedisLike): IsrCacheAdapter {
  return {
    async get(path: string): Promise<IsrCacheEntry | null> {
      const raw = await redis.get(pageKey(path));
      if (raw === null) return null;

      try {
        return JSON.parse(raw) as IsrCacheEntry;
      } catch {
        // Corrupt or unexpected value — treat as a cache miss.
        return null;
      }
    },

    async set(path: string, entry: IsrCacheEntry): Promise<void> {
      // Store without TTL — entries must survive past revalidateAfter so that
      // stale-while-revalidate can serve them while background regen runs.
      // Explicit invalidation via invalidatePath() / invalidateTag() manages
      // entry lifecycle. Setting EX = revalidateAfter - now() would cause a
      // hard miss on the revalidation boundary instead of serving stale content.
      await redis.set(pageKey(path), JSON.stringify(entry));

      // Update the tag index: add this path to each tag's Redis Set.
      if (entry.tags.length > 0) {
        await Promise.all(entry.tags.map(tag => redis.sadd(tagKey(tag), path)));
      }
    },

    async invalidatePath(path: string): Promise<void> {
      await redis.del(pageKey(path));
    },

    async invalidateTag(tag: string): Promise<void> {
      const paths = await redis.smembers(tagKey(tag));

      if (paths.length > 0) {
        // Delete all page entries for this tag in one DEL call.
        await redis.del(...paths.map(pageKey));
      }

      // Remove the tag set itself.
      await redis.del(tagKey(tag));
    },
  };
}
