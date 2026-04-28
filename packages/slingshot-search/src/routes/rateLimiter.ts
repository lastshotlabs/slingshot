/**
 * In-memory token-bucket rate limiter for search and suggest routes.
 *
 * The store is injectable so deployments can swap the in-memory implementation
 * for a Redis or Memcached backend without touching the route handlers.
 *
 * Default policy: 60 requests / 60 s per `(tenant, ip)` tuple.
 */
import type { Context } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

/**
 * Persistence contract for the rate limiter — only one method, so any storage
 * backend can implement it. The implementation must be reasonably atomic
 * across concurrent calls; the default in-memory store relies on JavaScript's
 * single-threaded event loop, which is sufficient for one-process deployments.
 */
export interface RateLimitStore {
  /**
   * Increment the counter for `key` and return the post-increment count plus
   * the absolute reset time (epoch ms). When the existing window has expired
   * the counter is reset to `1` and a new window of `windowMs` begins.
   */
  increment(key: string, windowMs: number): { count: number; resetAt: number };
}

/**
 * Build the default in-memory rate-limit store. Each key tracks `count` and
 * `resetAt`; entries past their reset time are reset on the next access.
 *
 * The store does not actively GC stale keys — entries reset themselves when
 * touched again. For a long-running process with many one-off keys this could
 * grow unbounded; in practice tenant + IP cardinality is bounded for any
 * single deployment, and operators who want hard limits should plug in a
 * Redis-backed store.
 */
export function createInMemoryRateLimitStore(): RateLimitStore {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    increment(key, windowMs) {
      const now = Date.now();
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= now) {
        const next = { count: 1, resetAt: now + windowMs };
        buckets.set(key, next);
        return next;
      }
      existing.count += 1;
      return existing;
    },
  };
}

/** Configuration for `createRateLimitMiddleware()`. */
export interface RateLimitOptions {
  /** Window length in milliseconds. Default: `60_000` (60 s). */
  readonly windowMs?: number;
  /** Maximum requests per window per `(tenant, ip)` tuple. Default: `60`. */
  readonly max?: number;
  /** Storage backend. Default: in-memory. */
  readonly store?: RateLimitStore;
  /**
   * Override the tenant resolver. When omitted the middleware reads the
   * `tenantId` Hono context variable set by the framework tenancy middleware
   * (or by `SearchPluginConfig.tenantResolver`); falls back to the literal
   * string `'_anonymous'`.
   */
  readonly tenantResolver?: (c: Context<AppEnv>) => string | undefined;
  /**
   * Override the client IP resolver. Defaults to the `x-forwarded-for`
   * header's first entry, then `x-real-ip`, then `'_unknown'`. Tests pass an
   * explicit resolver to drive the limiter deterministically.
   */
  readonly ipResolver?: (c: Context<AppEnv>) => string;
}

/**
 * Create a Hono middleware that enforces a per-(tenant, ip) request budget.
 *
 * Returns 429 with a `Retry-After` header (seconds) when the bucket is full.
 * Adds `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`
 * headers on every response, even successful ones, so clients can throttle
 * pre-emptively.
 *
 * **Why a custom impl** — the framework already has rate-limit infra in some
 * packages but slingshot-search needs a small, dependency-free, injectable
 * shape that mirrors the organizations plugin's pattern. Shared abstraction
 * is a non-goal until two packages agree on a single contract.
 */
export function createRateLimitMiddleware(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 60;
  const store = options.store ?? createInMemoryRateLimitStore();

  const resolveTenant = options.tenantResolver ?? defaultTenantResolver;
  const resolveIp = options.ipResolver ?? defaultIpResolver;

  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const tenant = resolveTenant(c) ?? '_anonymous';
    const ip = resolveIp(c);
    const key = `search:${tenant}:${ip}`;

    const { count, resetAt } = store.increment(key, windowMs);
    const remaining = Math.max(0, max - count);
    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.floor(resetAt / 1000)));

    if (count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      c.header('Retry-After', String(retryAfterSec));
      return c.json(
        {
          error: 'rate_limited',
          message: `Too many search requests for tenant '${tenant}'. Retry after ${retryAfterSec}s.`,
          retryAfterSec,
        },
        429,
      );
    }

    await next();
  };
}

function defaultTenantResolver(c: Context<AppEnv>): string | undefined {
  // The framework tenancy middleware (and `SearchPluginConfig.tenantResolver`)
  // both stash the resolved tenant on `c.var.tenantId`. We read it here so
  // the limiter shares the same identity surface as the rest of the plugin.
  const fromVar = c.get('tenantId') as unknown;
  if (typeof fromVar === 'string' && fromVar.length > 0) return fromVar;
  return undefined;
}

function defaultIpResolver(c: Context<AppEnv>): string {
  // Prefer x-forwarded-for (front of comma-separated list) when present.
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = c.req.header('x-real-ip');
  if (realIp) return realIp;
  return '_unknown';
}
