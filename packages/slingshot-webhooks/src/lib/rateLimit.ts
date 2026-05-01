/**
 * In-memory sliding-window rate limiter for inbound webhook endpoints.
 *
 * Each provider name is tracked independently with a configurable maximum number
 * of requests within a rolling time window. Old entries are pruned on every check
 * so memory does not grow unbounded under low-traffic conditions.
 *
 * This limiter is per-process only. In multi-instance deployments, pair it with
 * a distributed rate limiter (e.g. Redis-backed) — the `RateLimiter` interface
 * is intentionally narrow so consumers can swap in a different backend without
 * changing the route code.
 */

/**
 * Result returned by {@link RateLimiter.check}.
 */
export interface RateLimitResult {
  /** `true` when the request is within the configured limit. */
  readonly allowed: boolean;
  /** Number of requests remaining in the current window. */
  readonly remaining: number;
  /** Milliseconds until the oldest tracked request in the window expires. */
  readonly resetMs: number;
}

/**
 * Contract for rate limiter implementations used by the inbound webhook router.
 *
 * @example Custom Redis-backed limiter
 * ```ts
 * const limiter: RateLimiter = {
 *   check(key) {
 *     // ... INCR + EXPIRE via Redis ...
 *     return { allowed, remaining, resetMs };
 *   },
 * };
 * ```
 */
export interface RateLimiter {
  /**
   * Check whether `key` is within its rate limit.
   *
   * Implementations should record the request attempt atomically and return the
   * post-decision state so the caller can set `X-RateLimit-*` response headers.
   */
  check(key: string): RateLimitResult;
  /**
   * Release any background resources (timers, connections) held by this limiter.
   * After calling `close()`, subsequent `check()` calls produce undefined behavior.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  close?(): void;
}

/**
 * Options for {@link createSlidingWindowRateLimiter}.
 */
export interface SlidingWindowRateLimiterOptions {
  /**
   * Maximum number of requests allowed within `windowMs`.
   * @default 100
   */
  maxRequests: number;
  /**
   * Sliding window duration in milliseconds.
   * @default 60_000 (1 minute)
   */
  windowMs: number;
}

/**
 * Default options used when the caller omits values.
 */
const DEFAULT_OPTIONS: SlidingWindowRateLimiterOptions = {
  maxRequests: 100,
  windowMs: 60_000,
};

/**
 * Create an in-memory sliding-window rate limiter.
 *
 * Tracks request timestamps per key in a `Map`. On each `check()` call,
 * timestamps older than `windowMs` are pruned. If the remaining entry count
 * is at or above `maxRequests`, the request is denied.
 *
 * @param options - Rate limit configuration. Falls back to defaults when omitted.
 * @returns A `RateLimiter` instance.
 *
 * @example
 * ```ts
 * const limiter = createSlidingWindowRateLimiter({ maxRequests: 10, windowMs: 1000 });
 * const result = limiter.check('stripe');
 * if (!result.allowed) {
 *   return new Response('Too Many Requests', { status: 429 });
 * }
 * ```
 */
export function createSlidingWindowRateLimiter(
  options: Partial<SlidingWindowRateLimiterOptions> = {},
): RateLimiter {
  const { maxRequests, windowMs } = { ...DEFAULT_OPTIONS, ...options };
  const windows = new Map<string, number[]>();

  // Periodic cleanup every 60s so abandoned keys do not leak memory.
  // Use an integer timer handle on Bun/Node so it can be cleared.
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of windows) {
      const valid = timestamps.filter(ts => now - ts < windowMs);
      if (valid.length === 0) {
        windows.delete(key);
      } else if (valid.length < timestamps.length) {
        windows.set(key, valid);
      }
    }
  }, 60_000);
  if (typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    (cleanupTimer as { unref(): void }).unref();
  }

  let closed = false;

  return {
    check(key: string): RateLimitResult {
      const now = Date.now();
      let timestamps = windows.get(key);
      if (!timestamps) {
        timestamps = [];
        windows.set(key, timestamps);
      }

      // Prune expired entries.
      const cutoff = now - windowMs;
      while (timestamps.length > 0 && timestamps[0] < cutoff) {
        timestamps.shift();
      }

      if (timestamps.length >= maxRequests) {
        const resetMs = timestamps[0] + windowMs - now;
        return { allowed: false, remaining: 0, resetMs: Math.max(resetMs, 0) };
      }

      timestamps.push(now);
      return { allowed: true, remaining: maxRequests - timestamps.length, resetMs: windowMs };
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(cleanupTimer);
      windows.clear();
    },
  };
}
