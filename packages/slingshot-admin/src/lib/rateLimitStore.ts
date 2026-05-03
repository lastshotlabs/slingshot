/**
 * Pluggable rate-limit store interface and built-in implementations.
 *
 * The admin plugin uses this to enforce destructive-mutation rate limits per
 * principal+route+IP. The default in-process implementation does not survive a
 * multi-instance deploy — production deploys should inject a Redis-backed
 * implementation so all replicas share the same counter.
 */
import { type Logger, noopLogger } from '@lastshotlabs/slingshot-core';

/** Result returned by {@link AdminRateLimitStore.hit}. */
export interface AdminRateLimitHitResult {
  /** Counter value AFTER this hit was recorded. */
  count: number;
  /**
   * `true` when this hit pushed the counter above `limit`. Callers should
   * reject the request with 429 when set.
   */
  exceeded: boolean;
  /**
   * Absolute Unix epoch (ms) at which the current window expires. Use this to
   * compute a `Retry-After` header.
   */
  resetAt: number;
}

/** Options accepted by {@link AdminRateLimitStore.hit}. */
export interface AdminRateLimitHitOptions {
  /** Max hits allowed per window (inclusive). */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Pluggable counter store backing the admin destructive-mutation rate limiter.
 *
 * Implementations must atomically increment the counter for `key` and (re)set
 * the TTL when the key is first created in a window so that concurrent calls
 * cannot mint two windows for the same key.
 */
export interface AdminRateLimitStore {
  /**
   * Atomically increment the counter for `key` and return the post-increment
   * count plus a hint about whether `limit` has been exceeded. When the key
   * does not yet exist, implementations must initialise it to 1 with a TTL of
   * `windowMs` so the window expires automatically.
   */
  hit(key: string, opts: AdminRateLimitHitOptions): Promise<AdminRateLimitHitResult>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

interface MemoryBucket {
  count: number;
  resetAt: number;
}

/**
 * Build an in-process rate-limit store. Suitable for single-instance deploys
 * and tests. State is stored in a plain `Map`; no eviction other than the
 * window-expiry check on each hit.
 */
export function createMemoryRateLimitStore(): AdminRateLimitStore {
  const buckets = new Map<string, MemoryBucket>();

  return {
    async hit(key, { limit, windowMs }) {
      const now = Date.now();
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= now) {
        const resetAt = now + windowMs;
        buckets.set(key, { count: 1, resetAt });
        return { count: 1, exceeded: 1 > limit, resetAt };
      }
      existing.count += 1;
      return {
        count: existing.count,
        exceeded: existing.count > limit,
        resetAt: existing.resetAt,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Redis-backed implementation
// ---------------------------------------------------------------------------

/** Chainable transaction builder structurally compatible with ioredis. */
export interface RedisRateLimitMultiLike {
  /** Increment the counter. */
  incr(key: string): RedisRateLimitMultiLike;
  /**
   * Set a millisecond TTL on `key` only when no TTL is currently set (`NX`).
   * We use `NX` so concurrent hits in the same window do not extend it.
   */
  pexpire(key: string, ms: number, nx: 'NX'): RedisRateLimitMultiLike;
  /**
   * Execute the queued commands atomically. Returns either an array of plain
   * results (Bun-style clients) or `[err, result]` tuples (ioredis), or `null`
   * when the transaction was aborted.
   */
  exec(): Promise<unknown[] | null>;
}

/** Minimal structural Redis client used by {@link createRedisRateLimitStore}. */
export interface RedisRateLimitClientLike {
  /** Atomic increment of an integer counter. Returns the post-increment value. */
  incr(key: string): Promise<number>;
  /** Get the remaining TTL for `key` in milliseconds, or a negative sentinel. */
  pttl(key: string): Promise<number>;
  /** Set a millisecond TTL on `key`. */
  pexpire(key: string, ms: number): Promise<unknown>;
  /** Begin a transactional pipeline. */
  multi(): RedisRateLimitMultiLike;
}

/** Options for creating a Redis-backed rate-limit store used by admin endpoints. */
export interface CreateRedisRateLimitStoreOptions {
  /** Redis client instance. Any client matching {@link RedisRateLimitClientLike}. */
  client: RedisRateLimitClientLike;
  /**
   * Optional key prefix. Defaults to `slingshot:admin:rl:`. Useful when the
   * Redis instance is shared between apps.
   */
  keyPrefix?: string;
  /**
   * Optional structured logger for operational warnings (e.g. when PEXPIRE
   * fails and a key may leak). Defaults to a no-op logger.
   */
  logger?: Logger;
}

const DEFAULT_KEY_PREFIX = 'slingshot:admin:rl:';

/**
 * Pull a numeric INCR result out of either an ioredis-style `[err, result]`
 * tuple or a plain value. Returns `NaN` on shape mismatch — callers fall back
 * to a fresh INCR.
 */
function extractIncrResult(raw: unknown): number {
  if (Array.isArray(raw)) {
    // ioredis returns [err, result]; pull index 1.
    const [, value] = raw as [unknown, unknown];
    return typeof value === 'number' ? value : Number.NaN;
  }
  return typeof raw === 'number' ? raw : Number.NaN;
}

/**
 * Build a Redis-backed rate-limit store. Uses MULTI + INCR + PEXPIRE NX so the
 * counter increment and TTL initialisation happen atomically and the window
 * cannot be silently extended by concurrent hits.
 */
export function createRedisRateLimitStore(
  opts: CreateRedisRateLimitStoreOptions,
): AdminRateLimitStore {
  const { client } = opts;
  const prefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const logger: Logger = opts.logger ?? noopLogger;

  return {
    async hit(key, { limit, windowMs }) {
      const fullKey = `${prefix}${key}`;
      const tx = client.multi();
      tx.incr(fullKey);
      tx.pexpire(fullKey, windowMs, 'NX');
      const results = await tx.exec();

      let count: number;
      if (results == null || results.length < 1) {
        // Transaction aborted — fall back to a single INCR so we still apply
        // back-pressure rather than silently allowing the request through.
        count = await client.incr(fullKey);
        await client.pexpire(fullKey, windowMs).catch(() => {
          logger.warn('[slingshot-admin] rate-limit PEXPIRE failed after transaction abort', {
            event: 'rate_limit_pexpire_failed',
            key: fullKey,
          });
        });
      } else {
        const parsed = extractIncrResult(results[0]);
        count = Number.isFinite(parsed) ? parsed : await client.incr(fullKey);
      }

      // Look up the remaining TTL to compute the absolute reset time. If the
      // server returns a negative value (`-1` no expire, `-2` missing key) we
      // fall back to "now + windowMs" so a Retry-After header is still useful.
      let resetAt = Date.now() + windowMs;
      try {
        const ttl = await client.pttl(fullKey);
        if (typeof ttl === 'number' && ttl > 0) {
          resetAt = Date.now() + ttl;
        }
      } catch {
        // Ignore — fall back to the conservative reset estimate above.
      }

      return { count, exceeded: count > limit, resetAt };
    },
  };
}
