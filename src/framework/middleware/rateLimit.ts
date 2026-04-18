import type { MiddlewareHandler } from 'hono';
import {
  getClientIp,
  getFingerprintBuilder,
  getRateLimitAdapter,
  getSlingshotCtx,
  isPublicPath,
} from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Also rate-limit by HTTP fingerprint in addition to IP. Default: false */
  fingerprintLimit?: boolean;
}

/**
 * Hono middleware that enforces request-rate limits per client IP address,
 * with optional secondary limiting by HTTP fingerprint.
 *
 * Rate-limit buckets are namespaced per tenant when a `tenantId` is present on
 * the request context, so each tenant gets independent counters.
 *
 * Relies on the `RateLimitAdapter` registered in `SlingshotContext` — the
 * adapter is resolved at request time via {@link getRateLimitAdapter}.
 *
 * @param options - Rate limit configuration.
 * @param options.windowMs - Rolling time window in **milliseconds**.
 * @param options.max - Maximum number of requests permitted within `windowMs`
 *   before the client is throttled.
 * @param options.fingerprintLimit - When `true`, also applies a secondary limit
 *   keyed by an HTTP fingerprint (derived from headers, TLS properties, etc.).
 *   Useful to catch clients that rotate IPs but share a fingerprint.
 *   Default: `false`.
 * @returns A Hono `MiddlewareHandler` that responds with `429 Too Many Requests`
 *   when either the IP or fingerprint bucket is exhausted.
 *
 * @example
 * ```ts
 * // 100 requests per minute per IP
 * app.use(rateLimit({ windowMs: 60_000, max: 100 }));
 *
 * // Stricter limit on auth routes with fingerprint tracking
 * app.use('/auth/*', rateLimit({ windowMs: 60_000, max: 10, fingerprintLimit: true }));
 * ```
 */
export const rateLimit = ({
  windowMs,
  max,
  fingerprintLimit = false,
}: RateLimitOptions): MiddlewareHandler<AppEnv> => {
  const opts = { windowMs, max };

  return async (c, next) => {
    const ctx = getSlingshotCtx(c);
    if (isPublicPath(c.req.path, ctx.publicPaths)) {
      await next();
      return;
    }

    const adapter = getRateLimitAdapter(ctx);
    const ip = getClientIp(c);

    // Per-tenant namespacing: each tenant gets independent rate limit buckets
    const tenantId = c.get('tenantId');
    const prefix = tenantId ? `t:${tenantId}:` : '';

    if (await adapter.trackAttempt(`${prefix}ip:${ip}`, opts)) {
      return c.json({ error: 'Too Many Requests' }, 429);
    }

    if (fingerprintLimit) {
      const fp = await getFingerprintBuilder(ctx).buildFingerprint(c.req.raw);
      if (await adapter.trackAttempt(`${prefix}fp:${fp}`, opts)) {
        return c.json({ error: 'Too Many Requests' }, 429);
      }
    }

    await next();
  };
};
