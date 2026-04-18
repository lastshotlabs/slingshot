// ---------------------------------------------------------------------------
// Default FingerprintBuilder — basic hash of stable headers.
// ---------------------------------------------------------------------------
import type { FingerprintBuilder } from '../rateLimit';

const encoder = new TextEncoder();

/**
 * Creates a default `FingerprintBuilder` that produces a 6-byte SHA-256 hash
 * of stable browser headers (`User-Agent`, `Accept-Language`, `Accept-Encoding`).
 *
 * Used as a lightweight bot/request fingerprint when no authenticated user is present.
 * The hash is a 12-character hex string derived from the first 6 bytes of the digest.
 *
 * @returns A `FingerprintBuilder` suitable for unauthenticated rate limiting and bot detection.
 *
 * @remarks
 * Headers can be spoofed — this fingerprint is a soft signal, not a security guarantee.
 * The auth plugin may replace this with a richer implementation (e.g., one that
 * incorporates IP, TLS fingerprint, or cookie entropy).
 *
 * @example
 * ```ts
 * import { createDefaultFingerprintBuilder } from '@lastshotlabs/slingshot-core';
 *
 * const builder = createDefaultFingerprintBuilder();
 * const fingerprint = await builder.buildFingerprint(request);
 * // → 'a1b2c3d4e5f6'
 * ```
 */
export function createDefaultFingerprintBuilder(): FingerprintBuilder {
  return {
    async buildFingerprint(req: Request): Promise<string> {
      const h = (name: string) => req.headers.get(name) ?? '';

      const raw = [h('user-agent'), h('accept-language'), h('accept-encoding')].join('|');

      const buf = await crypto.subtle.digest('SHA-256', encoder.encode(raw));
      const bytes = new Uint8Array(buf).slice(0, 6);
      return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    },
  };
}
