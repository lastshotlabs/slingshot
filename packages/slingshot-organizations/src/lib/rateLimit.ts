/**
 * Result of a sliding-window rate-limit check.
 */
export type OrganizationsRateLimitDecision = {
  /** True when the request is permitted under the configured limit. */
  allowed: boolean;
  /** Number of milliseconds the caller should wait before the oldest event ages out. */
  retryAfterMs: number;
  /** Number of remaining permitted requests in the active window. */
  remaining: number;
};

/**
 * Pluggable backing store for the organizations rate-limit middleware.
 *
 * Implementations record a hit and return whether the limit has been exceeded
 * given the configured window. The default implementation
 * (`createMemoryOrganizationsRateLimitStore`) is a process-local Map suitable
 * for single-instance deployments and tests; production users should provide a
 * Redis- or otherwise-shared backing store.
 */
export interface OrganizationsRateLimitStore {
  /**
   * Record a hit on `key` and return whether it is allowed under the limit.
   *
   * @param key - Identity for the rate-limit bucket (e.g. `orgId:actorId`).
   * @param limit - Maximum number of allowed events within the window.
   * @param windowMs - Sliding window size in milliseconds.
   */
  hit(key: string, limit: number, windowMs: number): Promise<OrganizationsRateLimitDecision>;
}

/**
 * Default in-memory implementation of `OrganizationsRateLimitStore`.
 *
 * Stores per-key timestamp arrays and prunes events older than the window on
 * each hit. Eviction of completely-quiet keys happens lazily on hit; an
 * optional `maxEntries` cap drops the oldest tracked key when exceeded to
 * bound memory usage.
 *
 * @param options.maxEntries - Maximum number of distinct keys to track. When
 *   exceeded the oldest key (by most-recent activity) is evicted.
 */
export function createMemoryOrganizationsRateLimitStore(options?: {
  maxEntries?: number;
}): OrganizationsRateLimitStore {
  const maxEntries = options?.maxEntries ?? 10_000;
  const buckets = new Map<string, number[]>();

  return {
    async hit(key, limit, windowMs) {
      const now = Date.now();
      const cutoff = now - windowMs;
      const existing = buckets.get(key) ?? [];
      // Drop expired entries.
      const fresh = existing.filter(ts => ts > cutoff);
      if (fresh.length >= limit) {
        // Move to most-recent so eviction prefers truly idle keys.
        buckets.delete(key);
        buckets.set(key, fresh);
        const oldest = fresh[0] ?? now;
        return {
          allowed: false,
          retryAfterMs: Math.max(0, oldest + windowMs - now),
          remaining: 0,
        };
      }
      fresh.push(now);
      buckets.delete(key);
      buckets.set(key, fresh);
      if (buckets.size > maxEntries) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey !== undefined) {
          buckets.delete(oldestKey);
        }
      }
      return {
        allowed: true,
        retryAfterMs: 0,
        remaining: Math.max(0, limit - fresh.length),
      };
    },
  };
}
