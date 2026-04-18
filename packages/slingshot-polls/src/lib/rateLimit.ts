/**
 * Per-operation rate limiting for polls.
 *
 * Ships with an in-memory sliding window backend. A Redis-backed backend can
 * be added later by implementing the `RateLimitBackend` interface.
 *
 * @module
 */
import type { MiddlewareHandler } from 'hono';

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

/**
 * Swappable rate-limit backend.
 *
 * v1 ships with `createInMemoryRateLimiter()` only. Add a Redis-backed
 * implementation for multi-instance deployments without touching middleware.
 */
export interface RateLimitBackend {
  check(
    key: string,
    window: number,
    max: number,
  ): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
  }>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

interface WindowEntry {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * Create a closure-owned in-memory sliding-window rate limiter.
 *
 * Not suitable for multi-instance deployments — each process has independent
 * limits. Use `createRedisRateLimiter()` (out of scope for v1) when
 * horizontal scaling requires shared state.
 */
export function createInMemoryRateLimiter(): RateLimitBackend {
  const store = new Map<string, WindowEntry>();

  return {
    check(key: string, windowMs: number, max: number) {
      const now = Date.now();
      const existing = store.get(key);

      if (!existing || existing.resetAt <= now) {
        // Evict oldest entries if we hit the cap.
        if (store.size >= DEFAULT_MAX_ENTRIES) {
          const firstKey = store.keys().next().value;
          if (typeof firstKey === 'string') {
            store.delete(firstKey);
          }
        }
        const resetAt = now + windowMs;
        store.set(key, { count: 1, resetAt });
        return Promise.resolve({ allowed: 1 <= max, remaining: Math.max(0, max - 1), resetAt });
      }

      existing.count += 1;
      const allowed = existing.count <= max;
      return Promise.resolve({
        allowed,
        remaining: Math.max(0, max - existing.count),
        resetAt: existing.resetAt,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Duration parser
// ---------------------------------------------------------------------------

/**
 * Parse a duration string (`"10s"`, `"1m"`, `"1h"`) into milliseconds.
 *
 * @throws {Error} On invalid format.
 */
export function parseDuration(input: string): number {
  const match = input.match(/^(\d+)([smh])$/);
  if (!match) throw new Error(`Invalid duration format: "${input}". Expected "Ns", "Nm", or "Nh".`);

  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 's':
      return value * 1_000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    default:
      throw new Error(`Unknown unit: ${match[2]}`);
  }
}

// ---------------------------------------------------------------------------
// Rate-limit rule type
// ---------------------------------------------------------------------------

/** A rate-limit rule for a single operation. */
export interface PollsRateLimitRule {
  perUser?: { window: string; max: number };
  perTenant?: { window: string; max: number };
}

/** Per-operation rate-limit config. */
export interface PollsRateLimitConfig {
  vote?: PollsRateLimitRule;
  pollCreate?: PollsRateLimitRule;
  results?: PollsRateLimitRule;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Build a Hono middleware that enforces a polls rate-limit rule.
 *
 * Runs AFTER auth/policy — unauthorized callers are rejected before consuming
 * quota. Returns 429 with structured headers and body on limit exceeded.
 *
 * @param opName - The operation name for the error body (`'vote'`, `'pollCreate'`, `'results'`).
 * @param rule - The rate-limit rule to enforce.
 * @param backend - The rate-limit backend to track attempts.
 */
export function buildRateLimitMiddleware(
  opName: string,
  rule: PollsRateLimitRule,
  backend: RateLimitBackend,
): MiddlewareHandler {
  // Pre-parse durations at construction time.
  const perUser = rule.perUser
    ? { windowMs: parseDuration(rule.perUser.window), max: rule.perUser.max }
    : null;
  const perTenant = rule.perTenant
    ? { windowMs: parseDuration(rule.perTenant.window), max: rule.perTenant.max }
    : null;

  return async (c, next) => {
    // Check per-user limit first (tighter scope).
    if (perUser) {
      const userId = c.get('authUserId' as never) as string | undefined;
      if (userId) {
        const result = await backend.check(
          `${opName}:user:${userId}`,
          perUser.windowMs,
          perUser.max,
        );
        if (!result.allowed) {
          return rateLimitResponse(c, result, perUser.max, 'user', opName);
        }
      }
    }

    // Check per-tenant limit.
    if (perTenant) {
      const tenantId = c.get('tenantId' as never) as string | undefined;
      if (tenantId) {
        const result = await backend.check(
          `${opName}:tenant:${tenantId}`,
          perTenant.windowMs,
          perTenant.max,
        );
        if (!result.allowed) {
          return rateLimitResponse(c, result, perTenant.max, 'tenant', opName);
        }
      }
    }

    await next();
  };
}

function rateLimitResponse(
  c: Parameters<MiddlewareHandler>[0],
  result: { remaining: number; resetAt: number },
  max: number,
  scope: 'user' | 'tenant',
  op: string,
) {
  const retryAfterSec = Math.ceil((result.resetAt - Date.now()) / 1_000);
  c.header('Retry-After', String(Math.max(1, retryAfterSec)));
  c.header('X-RateLimit-Limit', String(max));
  c.header('X-RateLimit-Remaining', '0');
  c.header('X-RateLimit-Reset', String(Math.floor(result.resetAt / 1_000)));
  return c.json({ error: 'RATE_LIMITED', scope, op }, 429);
}
