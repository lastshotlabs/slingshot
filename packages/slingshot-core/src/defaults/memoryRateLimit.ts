// ---------------------------------------------------------------------------
// In-memory RateLimitAdapter — default when no auth plugin is registered.
// ---------------------------------------------------------------------------
import { DEFAULT_MAX_ENTRIES, evictOldest } from '../memoryEviction';
import type { RateLimitAdapter } from '../rateLimit';

interface RateLimitEntry {
  count: number;
  resetAt: number; // epoch ms
}

/**
 * Creates an in-memory rate limit adapter backed by a `Map`.
 *
 * Tracks request counts per key in a rolling time window. The window resets when
 * the current time exceeds `resetAt` — there is no sliding window; each key gets a
 * fixed-duration bucket that resets on the first request after expiry.
 *
 * @returns A `RateLimitAdapter` suitable for single-process deployments and development.
 *
 * @remarks
 * **Not suitable for multi-instance or distributed deployments.** Rate limit counts are
 * held entirely in the process heap — no synchronisation with other server instances occurs.
 * In a horizontally-scaled deployment each instance enforces its own independent limit, so
 * the effective per-user limit becomes `max × instanceCount`. For production deployments
 * with more than one server process, replace this adapter with a Redis-backed implementation
 * via `ctx.registrar.setRateLimitAdapter(...)` in the auth plugin.
 *
 * **Map eviction strategy:** On every `trackAttempt`, expired entries (those whose `resetAt`
 * has passed) are swept first so they do not consume capacity. If the store is still over
 * `DEFAULT_MAX_ENTRIES` after sweeping, the oldest entries by insertion order are evicted.
 * This bounds memory use while protecting valid entries from being evicted by stale or
 * attacker-generated keys.
 *
 * **Production warning:** this adapter is registered as the framework default so the server
 * starts without requiring an auth plugin. Replace it in any deployment that expects
 * non-trivial traffic or has security requirements around rate limiting.
 *
 * @example
 * ```ts
 * import { createMemoryRateLimitAdapter } from '@lastshotlabs/slingshot-core';
 *
 * const adapter = createMemoryRateLimitAdapter();
 * const exceeded = await adapter.trackAttempt('login:1.2.3.4', { windowMs: 60_000, max: 5 });
 * if (exceeded) throw new HttpError(429, 'Too many attempts');
 * ```
 */
export function createMemoryRateLimitAdapter(): RateLimitAdapter {
  const store = new Map<string, RateLimitEntry>();

  function sweepExpired(): void {
    const now = Date.now();
    for (const [k, entry] of store) {
      if (entry.resetAt <= now) store.delete(k);
    }
  }

  return {
    trackAttempt(key: string, opts: { windowMs: number; max: number }): Promise<boolean> {
      const now = Date.now();
      const existing = store.get(key);

      if (!existing || existing.resetAt <= now) {
        // Sweep expired entries before evicting oldest — this reclaims capacity
        // from stale windows and protects valid entries from being evicted under
        // high-cardinality attack conditions.
        sweepExpired();
        evictOldest(store, DEFAULT_MAX_ENTRIES);
        store.set(key, { count: 1, resetAt: now + opts.windowMs });
        return Promise.resolve(1 > opts.max);
      }

      existing.count += 1;
      return Promise.resolve(existing.count > opts.max);
    },
  };
}
