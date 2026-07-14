import type { MiddlewareHandler } from 'hono';
import {
  getActor,
  getClientIp,
  getFingerprintBuilder,
  getRateLimitAdapter,
  getSlingshotCtx,
  isPublicPath,
} from '@lastshotlabs/slingshot-core';
import type { Actor, AppEnv } from '@lastshotlabs/slingshot-core';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Also rate-limit by HTTP fingerprint in addition to IP. Default: false */
  fingerprintLimit?: boolean;
}

/**
 * The bucket this request counts against.
 *
 * ## Why this is not just the IP
 *
 * Keying purely by IP is wrong for anything people use *together*. A party game is
 * the sharpest case: six phones, a TV, and the host are all in one living room,
 * behind one home NAT, presenting **one** public IP. Under an IP-keyed limit they
 * share a single bucket, so the room's budget is divided by the number of guests —
 * and live gameplay is chatty by design (state polls plus socket-triggered
 * refetches from every device). The result is a flat `429` in the middle of a
 * game, which surfaces as garbled UI rather than as an obvious rate-limit error.
 * It gets *worse* the better the party goes.
 *
 * The thing a request-rate limit actually defends against is **one client**
 * hammering the server. So key by the client when we know who it is:
 *
 *   - an authenticated user (including a guest session — every player on this
 *     platform has one, which is the whole identity model);
 *   - a display/TV, which gets its own bucket so a polling TV can neither eat the
 *     room's budget nor be starved by it;
 *   - and only for genuinely anonymous traffic, the IP — which is exactly where
 *     IP is the right answer, because it's all we have.
 *
 * A shared IP therefore no longer means a shared budget, while an anonymous flood
 * from one address is still limited as before.
 */
function rateLimitSubject(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string {
  const actor: Actor = getActor(c);

  if (actor.id) return `user:${actor.id}`;

  // A TV has no user id on purpose (see slingshot-game-engine display tokens), so
  // it would otherwise fall through to the shared household IP — the one bucket we
  // most need it out of.
  if (actor.kind === 'display') {
    const session = actor.claims.displaySessionId;
    const token = actor.claims.displayTokenId;
    if (typeof session === 'string' && typeof token === 'string') {
      return `display:${session}:${token}`;
    }
  }

  return `ip:${getClientIp(c)}`;
}

/**
 * Hono middleware that enforces request-rate limits per **client** — an
 * authenticated user or display when there is one, and the client IP only for
 * anonymous traffic — with optional secondary limiting by HTTP fingerprint.
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
 *   Useful to catch clients that rotate IPs but share a fingerprint. Note this
 *   remains a coarse, shared bucket by design — it is a bot-detection signal, not
 *   a per-user budget — so leave it off for endpoints real users hit in volume.
 *   Default: `false`.
 * @returns A Hono `MiddlewareHandler` that responds with `429 Too Many Requests`
 *   when the client's bucket is exhausted.
 *
 * @example
 * ```ts
 * // 100 requests per minute per client (per user; per IP when anonymous)
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

    // Per-tenant namespacing: each tenant gets independent rate limit buckets
    const tenantId = c.get('tenantId');
    const prefix = tenantId ? `t:${tenantId}:` : '';

    if (await adapter.trackAttempt(`${prefix}${rateLimitSubject(c)}`, opts)) {
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
