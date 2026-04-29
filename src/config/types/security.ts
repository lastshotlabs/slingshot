import type { CaptchaConfig } from '@framework/lib/captcha';
import type { SigningConfig } from '@lib/signingConfig';
import type { CsrfConfig } from '@lastshotlabs/slingshot-core';

export interface BotProtectionConfig {
  /**
   * List of IPv4 CIDRs (e.g. "198.51.100.0/24"), IPv4 addresses, or IPv6 addresses to block outright.
   * Matched requests receive a 403 before any other processing.
   * Example: ["198.51.100.0/24", "203.0.113.42"]
   */
  blockList?: string[];
  /**
   * Also rate-limit by HTTP fingerprint (User-Agent, Accept-*, Connection, browser header presence)
   * in addition to IP. Bots that rotate IPs but use the same HTTP client share a bucket.
   * Uses the same store as auth rate limiting (Redis or memory).
   * Default: false
   */
  fingerprintRateLimit?: boolean;
}

export interface SecurityConfig {
  /** CORS policy. Shorthand string/array forms are treated as origin allowlists. */
  cors?:
    | string
    | string[]
    | {
        origin: string | string[];
        credentials?: boolean;
        allowHeaders?: string[];
        exposeHeaders?: string[];
        maxAge?: number;
      };
  /** Additional security headers to set via Hono's secureHeaders middleware.
   *  Pass a Content-Security-Policy, Permissions-Policy, etc. */
  headers?: {
    contentSecurityPolicy?: string;
    permissionsPolicy?: string;
  };
  /** Global rate limit. Defaults to 100 req / 60s */
  rateLimit?: {
    windowMs: number;
    max: number;
    store?: 'memory' | 'redis';
    fingerprintLimit?: boolean;
  };
  /**
   * Bot protection: CIDR blocklist and fingerprint-based rate limiting.
   * Runs before IP rate limiting so blocked IPs are rejected immediately.
   */
  botProtection?: BotProtectionConfig;
  /**
   * Trusted proxy configuration for IP extraction.
   * - `false` (default): use socket-level IP only, ignore X-Forwarded-For entirely.
   * - A number N: trust N proxy hops — take the Nth-from-right IP in the X-Forwarded-For chain.
   */
  trustProxy?: false | number;
  /**
   * Unified HMAC signing for cookies, cursors, presigned URLs, request signing,
   * idempotency key hashing, and session binding. All features are opt-in.
   */
  signing?: SigningConfig;
  /**
   * Global CAPTCHA configuration. When set, use requireCaptcha() middleware on specific routes,
   * or enable adaptive mode to auto-require CAPTCHA after rate limit thresholds.
   */
  captcha?: CaptchaConfig;
  /** CSRF protection configuration for cookie-authenticated auth routes. */
  csrf?: CsrfConfig;
}
