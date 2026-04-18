import { createHmac } from 'crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HttpError, timingSafeEqual } from '@lastshotlabs/slingshot-core';

export interface WebhookTimestampOptions {
  /** Header name containing the Unix timestamp (seconds or ms). */
  header: string;
  /**
   * Allowed age of the timestamp in milliseconds.
   * Values below 1e10 in the header are treated as Unix seconds and auto-converted.
   */
  tolerance: number;
}

export interface WebhookAuthOptions {
  /**
   * Shared HMAC secret. Pass a function for dynamic resolution
   * (e.g. per-tenant secret lookup). If the function throws, a 500 is returned.
   */
  secret: string | ((c: Context<AppEnv>) => string | Promise<string>);
  /** Header that carries the signature. Default: `"x-webhook-signature"`. */
  header?: string;
  /** HMAC algorithm. Default: `"sha256"`. */
  algorithm?: 'sha256' | 'sha512';
  /**
   * Strip this prefix from the signature header value before comparing.
   * e.g. `"sha256="` for GitHub-style `X-Hub-Signature-256: sha256=<hex>`.
   */
  prefix?: string;
  /** Optional replay-protection via a timestamp header. */
  timestamp?: WebhookTimestampOptions;
}

/**
 * Hono middleware that authenticates incoming webhook requests using HMAC
 * signature verification.
 *
 * Verification steps (in order):
 * 1. **Timestamp replay protection** (optional) — if `options.timestamp` is
 *    provided, the request timestamp header is validated against `tolerance`.
 *    Requests outside the tolerance window are rejected with `401`.
 * 2. **Signature header** — the signature header (default `x-webhook-signature`)
 *    must be present; missing signatures yield `401`.
 * 3. **Secret resolution** — the HMAC secret is resolved; dynamic functions
 *    (e.g. per-tenant secret lookups) are awaited.  Resolver errors yield `500`.
 * 4. **HMAC comparison** — the request body is HMAC-hashed and compared
 *    against the provided signature using timing-safe comparison.  Mismatches
 *    yield `401`.
 *
 * The request body is read via `c.req.text()` which Hono caches, so downstream
 * handlers can still call `c.req.json()` without issues.
 *
 * @param options - Webhook authentication configuration.
 * @param options.secret - Shared HMAC secret string, or a function
 *   `(c) => string | Promise<string>` for dynamic resolution (e.g. per-tenant).
 * @param options.header - Name of the request header carrying the signature.
 *   Default: `"x-webhook-signature"`.
 * @param options.algorithm - HMAC algorithm.  Default: `"sha256"`.
 * @param options.prefix - Prefix to strip from the signature header value
 *   before comparing (e.g. `"sha256="` for GitHub-style signatures).
 * @param options.timestamp - Optional replay-protection config.  Requires a
 *   `header` name and a `tolerance` in milliseconds.
 * @returns A Hono `MiddlewareHandler` that proceeds to `next()` only when the
 *   signature is valid.
 * @throws {HttpError} `401 INVALID_SIGNATURE` when the signature is absent or
 *   does not match.
 * @throws {HttpError} `401 EXPIRED_TIMESTAMP` when the timestamp is missing or
 *   outside the allowed `tolerance` window.
 * @throws {HttpError} `500 WEBHOOK_SECRET_ERROR` when the dynamic `secret`
 *   function throws.
 *
 * @example
 * ```ts
 * // GitHub-style webhook (sha256 prefix, 5-minute replay window)
 * router.post('/github', webhookAuth({
 *   secret: process.env.GITHUB_WEBHOOK_SECRET!,
 *   header: 'x-hub-signature-256',
 *   prefix: 'sha256=',
 *   timestamp: { header: 'x-github-delivery', tolerance: 5 * 60 * 1000 },
 * }), handler);
 * ```
 */
export const webhookAuth =
  (options: WebhookAuthOptions): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const algorithm = options.algorithm ?? 'sha256';
    const sigHeader = options.header ?? 'x-webhook-signature';

    // --- Optional timestamp replay protection ---
    if (options.timestamp) {
      const { header: tsHeader, tolerance } = options.timestamp;
      const rawTs = c.req.header(tsHeader);
      const tsNum = rawTs !== undefined ? parseInt(rawTs, 10) : NaN;

      if (isNaN(tsNum)) {
        throw new HttpError(401, 'Unauthorized', 'EXPIRED_TIMESTAMP');
      }

      // Auto-detect Unix seconds (< 1e10) vs milliseconds
      const tsMs = tsNum < 1e10 ? tsNum * 1000 : tsNum;

      if (Math.abs(Date.now() - tsMs) > tolerance) {
        throw new HttpError(401, 'Unauthorized', 'EXPIRED_TIMESTAMP');
      }
    }

    // --- Signature header ---
    const rawSig = c.req.header(sigHeader);
    if (!rawSig) {
      throw new HttpError(401, 'Unauthorized', 'INVALID_SIGNATURE');
    }

    const provided =
      options.prefix && rawSig.startsWith(options.prefix)
        ? rawSig.slice(options.prefix.length)
        : rawSig;

    // --- Secret resolution ---
    let secret: string;
    if (typeof options.secret === 'function') {
      try {
        secret = await options.secret(c);
      } catch {
        throw new HttpError(500, 'Internal Server Error', 'WEBHOOK_SECRET_ERROR');
      }
    } else {
      secret = options.secret;
    }

    // --- Body reading (Hono caches this — downstream c.req.json() still works) ---
    const body = await c.req.text();

    // --- HMAC computation & comparison ---
    const computed = createHmac(algorithm, secret).update(body).digest('hex');

    let valid: boolean;
    try {
      valid = timingSafeEqual(computed, provided);
    } catch {
      // timingSafeEqual can throw if buffer byte lengths differ (e.g. multi-byte Unicode in sig)
      valid = false;
    }

    if (!valid) {
      throw new HttpError(401, 'Unauthorized', 'INVALID_SIGNATURE');
    }

    await next();
  };
