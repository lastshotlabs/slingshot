/**
 * Supported CAPTCHA verification providers.
 *
 * - `'recaptcha'`  — Google reCAPTCHA v2 or v3
 * - `'hcaptcha'`   — hCaptcha
 * - `'turnstile'`  — Cloudflare Turnstile
 */
export type CaptchaProvider = 'recaptcha' | 'hcaptcha' | 'turnstile';

/**
 * CAPTCHA middleware configuration for protecting public auth endpoints.
 *
 * When configured, the CAPTCHA middleware validates a client-submitted token before
 * allowing registration, login, or password-reset requests to proceed.
 *
 * @example
 * ```ts
 * const captcha: CaptchaConfig = {
 *   provider: 'turnstile',
 *   secretKey: process.env.TURNSTILE_SECRET_KEY!,
 *   tokenField: 'cf-turnstile-response',
 * };
 * ```
 */
export interface CaptchaConfig {
  /**
   * The CAPTCHA service to use for token verification.
   *
   * @remarks
   * Provider-specific behaviours:
   * - `'recaptcha'` — supports both v2 (checkbox) and v3 (score-based). Use `minScore`
   *   to set the acceptance threshold when using v3; `minScore` is ignored for v2.
   * - `'hcaptcha'` — validates tokens against `api.hcaptcha.com`. `minScore` is not
   *   applicable; hCaptcha uses a pass/fail model.
   * - `'turnstile'` — validates tokens against `challenges.cloudflare.com`. `minScore`
   *   is not applicable; Turnstile uses a pass/fail model.
   */
  provider: CaptchaProvider;
  /** Server-side secret key for verifying tokens (never sent to the client). */
  secretKey: string;
  /**
   * Minimum acceptable reCAPTCHA v3 score in the range `[0.0, 1.0]`. Lower scores
   * indicate more bot-like behaviour; higher scores indicate more human-like behaviour.
   *
   * @remarks
   * Typical thresholds:
   * - `0.9` — very strict; may block legitimate users on slow devices or unusual networks
   * - `0.5` — balanced default; rejects obvious bots while accepting most humans
   * - `0.3` — lenient; allows through most traffic while blocking only flagrant bots
   *
   * Default: `0.5`. Ignored for reCAPTCHA v2, hCaptcha, and Turnstile which use a
   * pass/fail model rather than a continuous score.
   */
  minScore?: number;
  /**
   * Name of the request body field (JSON or form-encoded) that contains the CAPTCHA token
   * submitted by the client.
   *
   * @remarks
   * The middleware reads this field from the parsed request body — not from query params
   * or headers. Default: `'captcha-token'`. Set to the field name your front-end widget
   * submits (e.g. `'cf-turnstile-response'` for Cloudflare Turnstile or `'h-captcha-response'`
   * for hCaptcha).
   */
  tokenField?: string;
  /**
   * When `true`, CAPTCHA is only required after the rate-limit threshold is crossed.
   * This provides a better UX for legitimate users while still protecting against bots.
   * Default: `false` (always require CAPTCHA).
   */
  adaptive?: boolean;
  /**
   * Rate limit window configuration that triggers CAPTCHA enforcement in adaptive mode.
   *
   * @remarks
   * Only meaningful when `adaptive: true`. Defines the rolling window (`windowMs`) and
   * request count (`max`) per IP or fingerprint that must be exceeded before the CAPTCHA
   * check is activated for subsequent requests from that source. For example,
   * `{ windowMs: 60_000, max: 5 }` means: require CAPTCHA once a source has made more
   * than 5 requests in a 60-second window.
   *
   * When `adaptive` is `false` (the default), this field is ignored.
   */
  adaptiveThreshold?: { windowMs: number; max: number };
}
