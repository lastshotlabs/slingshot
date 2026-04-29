import type { OrganizationsRateLimitDecision, OrganizationsRateLimitStore } from './rateLimit';

/**
 * Minimal Redis client contract satisfied by ioredis, Upstash Redis, etc.
 * Re-exported from `@lastshotlabs/slingshot-core` so callers don't need an extra import.
 */
export type { RedisLike } from '@lastshotlabs/slingshot-core';
import type { RedisLike } from '@lastshotlabs/slingshot-core';

/**
 * Lua script for atomic sliding-window rate limit check.
 *
 * KEYS[1] - the rate limit key
 * ARGV[1] - current timestamp in milliseconds
 * ARGV[2] - window size in milliseconds
 * ARGV[3] - max number of events in the window
 *
 * Returns a 3-element array: [allowed (1|0), retryAfterMs, remaining]
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cutoff = now - windowMs

redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)

if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldestScore = 0
  if #oldest >= 2 then
    oldestScore = tonumber(oldest[2])
  end
  local retryAfterMs = math.max(0, oldestScore + windowMs - now)
  return {0, retryAfterMs, 0}
end

redis.call('ZADD', key, now, now .. ':' .. redis.call('ZCARD', key))
redis.call('PEXPIRE', key, windowMs)
local remaining = math.max(0, limit - count - 1)
return {1, 0, remaining}
`;

/**
 * Redis-backed {@link OrganizationsRateLimitStore} using a sorted-set sliding window.
 *
 * The implementation runs an atomic Lua script so rate-limit checks are safe across
 * concurrent processes. Keys are automatically expired after the window elapses.
 *
 * @param redis - A Redis client satisfying the {@link RedisLike} contract (ioredis, Upstash, etc.).
 * @param keyPrefix - Optional prefix prepended to every Redis key. Defaults to `"org-rl:"`.
 *
 * @example
 * ```ts
 * import Redis from 'ioredis';
 * import { createRedisOrganizationsRateLimitStore } from '@lastshotlabs/slingshot-organizations';
 *
 * const redis = new Redis(process.env.REDIS_URL);
 * const store = createRedisOrganizationsRateLimitStore(redis);
 * ```
 */
export function createRedisOrganizationsRateLimitStore(
  redis: RedisLike,
  keyPrefix = 'org-rl:',
): OrganizationsRateLimitStore {
  return {
    async hit(key, limit, windowMs): Promise<OrganizationsRateLimitDecision> {
      const redisKey = `${keyPrefix}${key}`;
      const now = Date.now();

      try {
        const result = (await redis.eval(
          SLIDING_WINDOW_SCRIPT,
          1,
          redisKey,
          now,
          windowMs,
          limit,
        )) as [number, number, number];

        const allowed = result[0] === 1;
        const retryAfterMs = result[1] ?? 0;
        const remaining = result[2] ?? 0;

        return { allowed, retryAfterMs, remaining };
      } catch (_err) {
        // If Redis is unreachable, fail open to avoid denying all requests.
        // The caller should monitor Redis health independently.
        return { allowed: true, retryAfterMs: 0, remaining: limit };
      }
    },
  };
}
