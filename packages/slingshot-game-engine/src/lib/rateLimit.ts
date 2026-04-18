/**
 * Per-player per-channel rate limiting.
 *
 * Extends the `RateLimitBackend` pattern from `slingshot-polls` for
 * game-specific channel rate limiting. This is the ONLY rate limiter
 * the game engine implements itself.
 *
 * See spec §29.2, §2.4.7 (layer 3).
 */
import type { RateLimitBackend } from '../types/adapters';

interface RateLimitEntry {
  timestamps: number[];
}

/**
 * Create an in-memory rate limit backend.
 *
 * Uses a sliding window algorithm. Entries are per-key (composite of
 * session, channel, and userId). Closure-owned state (Rule 3).
 */
export function createInMemoryRateLimiter(): RateLimitBackend {
  const entries = new Map<string, RateLimitEntry>();

  return {
    check(
      key: string,
      window: number,
      max: number,
    ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
      const now = Date.now();
      const windowStart = now - window;

      let entry = entries.get(key);
      if (!entry) {
        entry = { timestamps: [] };
        entries.set(key, entry);
      }

      // Remove expired timestamps
      entry.timestamps = entry.timestamps.filter(t => t > windowStart);

      if (entry.timestamps.length >= max) {
        const resetAt = entry.timestamps[0] + window;
        return Promise.resolve({
          allowed: false,
          remaining: 0,
          resetAt,
        });
      }

      entry.timestamps.push(now);
      return Promise.resolve({
        allowed: true,
        remaining: max - entry.timestamps.length,
        resetAt: now + window,
      });
    },
  };
}

/**
 * Build a rate limit key for per-player per-channel limiting.
 */
export function channelRateLimitKey(sessionId: string, channel: string, userId: string): string {
  return `game:rate:${sessionId}:${channel}:${userId}`;
}
