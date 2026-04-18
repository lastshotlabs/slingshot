/**
 * Signing and crypto configuration for the Slingshot framework.
 *
 * Controls HMAC signing for cookies, cursors, presigned URLs, request signing,
 * idempotency keys, and session-binding security features.
 *
 * @remarks
 * All features are opt-in and default to `false`. Enable each feature when your
 * threat model calls for it. `requestSigning` and `sessionBinding` are
 * strongly recommended for production APIs that accept third-party callers.
 *
 * @example
 * ```ts
 * const signing: SigningConfig = {
 *   secret: process.env.SIGNING_SECRET,
 *   cookies: true,
 *   cursors: true,
 *   requestSigning: { tolerance: 300, header: 'x-signature', timestampHeader: 'x-timestamp' },
 * };
 * ```
 */
export interface SigningConfig {
  /**
   * HMAC secret used for all signing operations. Defaults to the `JWT_SECRET` env var if omitted.
   *
   * Pass a `string[]` to support zero-downtime key rotation:
   * - The **first** element is the active signing key — all new signatures are produced with it.
   * - **All** elements are tried during verification, in order, until one succeeds.
   * - To rotate: prepend the new key, deploy, then remove the old key in a subsequent deploy
   *   once all tokens signed with it have expired.
   */
  secret?: string | string[];
  /** Sign/verify cookie values set via exported helpers. Default: false. */
  cookies?: boolean;
  /** Sign pagination cursor tokens to prevent client tampering. Default: false. */
  cursors?: boolean;
  /** HMAC-based stateless presigned URLs (no DB lookup). Default: false. */
  presignedUrls?: boolean | { defaultExpiry?: number };
  /** Require clients to HMAC-sign requests (method+path+timestamp+body). Default: false. */
  requestSigning?:
    | boolean
    | {
        /**
         * Maximum allowed clock skew between the client's timestamp and the server's clock.
         * Units: **seconds**. Requests with a timestamp older or newer than `tolerance` seconds
         * are rejected with 401 to prevent replay attacks. Defaults to `300` (5 minutes).
         */
        tolerance?: number;
        header?: string;
        timestampHeader?: string;
      };
  /** Hash idempotency keys before storage. Default: false. */
  idempotencyKeys?: boolean;
  /**
   * Bind sessions to a client fingerprint so a stolen JWT+session pair cannot
   * be replayed from a different browser or IP.
   *
   * - `true` — bind to IP + User-Agent (strictest; may false-positive on mobile
   *   users or deployments that terminate TLS at a CDN/proxy that rewrites IPs).
   * - `{ fields: ['ua'], onMismatch: 'log-only' }` — UA-only binding in
   *   observation mode; safe starting point for mobile or CDN-heavy deployments.
   * - `{ fields: ['ip', 'ua'], onMismatch: 'reject' }` — hard reject on mismatch
   *   (most aggressive; returns 401 instead of silently unauthenticating).
   *
   * **Not enabled by default.** Production deployments are warned at startup when
   * this is absent. Explicitly set to `false` to silence the warning.
   *
   * @remarks
   * Setting `sessionBinding: false` is an **explicit opt-out** — the startup warning
   * is suppressed and no fingerprint binding is performed. Omitting the field entirely
   * is treated as "not yet configured" and triggers the startup warning. Use `false`
   * only after consciously deciding that session binding is not appropriate for your
   * deployment (e.g. a fully internal service with no user-facing sessions).
   *
   * `onMismatch` controls what happens when a request arrives with a valid session
   * token but a fingerprint that does not match the one recorded at session creation:
   * - `'unauthenticate'` — clear the session cookie and return a 200/redirect as if
   *   the user is logged out (default; non-disruptive for legitimate mobile users)
   * - `'reject'` — immediately return a 401 Unauthorized response; most secure but
   *   will break legitimate users on mobile networks or behind aggressive proxies
   * - `'log-only'` — allow the request through but emit a warning log entry;
   *   use during rollout to measure false-positive rate before enforcing
   */
  sessionBinding?:
    | boolean
    | {
        fields?: Array<'ip' | 'ua' | 'accept-language'>;
        onMismatch?: 'unauthenticate' | 'reject' | 'log-only';
      };
}
