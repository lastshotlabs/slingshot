import { hmacVerify } from '@lib/signing';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HEADER_SIGNATURE, HEADER_TIMESTAMP, HttpError } from '@lastshotlabs/slingshot-core';

export interface RequestSigningOptions {
  /** Allowed age of the timestamp in milliseconds. Default: 300_000 (5 min). */
  tolerance?: number;
  /** Header carrying the HMAC signature. Default: "x-signature". */
  header?: string;
  /** Header carrying the Unix timestamp (seconds or ms). Default: "x-timestamp". */
  timestampHeader?: string;
}

/**
 * Canonicalize the query string for signing.
 *
 * - Sort params by key, then by value for repeated keys
 * - Normalize percent-encoding: decode then re-encode via encodeURIComponent
 *   so that %20 and + both canonicalize to %20 (most common source of
 *   signature mismatches between clients)
 * - Returns "" when there are no query params (not omitted — omitting the
 *   query line would allow ?foo=1 and ?foo=2 to share a valid signature)
 */
function canonicalizeQuery(search: string): string {
  // Remove leading "?"
  const qs = search.startsWith('?') ? search.slice(1) : search;
  if (!qs) return '';

  const pairs: Array<[string, string]> = [];
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    const rawKey = eqIdx === -1 ? part : part.slice(0, eqIdx);
    const rawVal = eqIdx === -1 ? '' : part.slice(eqIdx + 1);
    // Normalize encoding: decode then re-encode
    const key = encodeURIComponent(decodeURIComponent(rawKey.replace(/\+/g, ' ')));
    const val = encodeURIComponent(decodeURIComponent(rawVal.replace(/\+/g, ' ')));
    pairs.push([key, val]);
  }

  // Sort by key, then by value for repeated keys
  pairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] < b[1] ? -1 : 1;
  });

  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Middleware that verifies the client has HMAC-signed the canonical request.
 *
 * Canonical string:
 *   METHOD\nPATH\nCANONICAL_QUERY\nTIMESTAMP\nBODY
 *
 * When `signing.requestSigning` is false (or not configured), the middleware
 * is a no-op pass-through.
 */
export const requireSignedRequest =
  (opts?: RequestSigningOptions): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const cfg = c.get('slingshotCtx').signing;

    // No-op when request signing is not enabled
    if (!cfg?.requestSigning) {
      await next();
      return;
    }

    const signingOpts = typeof cfg.requestSigning === 'object' ? cfg.requestSigning : {};

    const tolerance = opts?.tolerance ?? signingOpts.tolerance ?? 300_000;
    const sigHeader = opts?.header ?? signingOpts.header ?? HEADER_SIGNATURE;
    const tsHeader = opts?.timestampHeader ?? signingOpts.timestampHeader ?? HEADER_TIMESTAMP;

    // --- Timestamp validation (replay protection) ---
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

    // --- Signature header ---
    const sig = c.req.header(sigHeader);
    if (!sig) {
      throw new HttpError(401, 'Unauthorized', 'INVALID_SIGNATURE');
    }

    // --- Secret resolution ---
    const secret = cfg.secret ?? null;
    if (!secret) {
      throw new HttpError(500, 'Internal Server Error', 'SIGNING_SECRET_MISSING');
    }

    // --- Build canonical string ---
    const method = c.req.method.toUpperCase();
    const url = new URL(c.req.url);
    const path = url.pathname;
    const query = canonicalizeQuery(url.search);
    const body = await c.req.text();

    const canonical = `${method}\n${path}\n${query}\n${rawTs}\n${body}`;

    // --- HMAC verification ---
    let valid: boolean;
    try {
      valid = hmacVerify(canonical, sig, secret);
    } catch {
      valid = false;
    }

    if (!valid) {
      throw new HttpError(401, 'Unauthorized', 'INVALID_SIGNATURE');
    }

    await next();
  };
