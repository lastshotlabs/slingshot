/**
 * CSRF protection configuration for the auth plugin.
 *
 * When enabled, the CSRF middleware verifies that the x-csrf-token header
 * value matches the csrf_token cookie on state-changing requests (POST, PUT, PATCH, DELETE).
 *
 * @remarks
 * CSRF protection is only meaningful for cookie-authenticated requests. Bearer token
 * and M2M requests are inherently CSRF-safe and bypass the check. OAuth callback paths
 * are always exempt to prevent breaking the redirect flow.
 *
 * @example
 * ```ts
 * const csrf: CsrfConfig = {
 *   enabled: true,
 *   exemptPaths: ['/webhooks/*'],
 *   checkOrigin: true,
 * };
 * ```
 */
export interface CsrfConfig {
  /** Enable CSRF double-submit cookie protection for cookie-authenticated requests. */
  enabled: boolean;
  /**
   * Paths exempt from CSRF checks in addition to the built-in OAuth callback exemptions.
   * Supports prefix matching when the path ends with '*' (e.g. '/webhooks/*').
   */
  exemptPaths?: string[];
  /**
   * Also validate the `Origin` header against the configured CORS `security.cors` origins.
   * Provides defence-in-depth alongside the double-submit cookie check. Default: `true`.
   *
   * @remarks
   * When `true`, the CSRF middleware rejects any state-changing request whose `Origin`
   * header is present but does not match one of the allowed origins from
   * `config.security.cors`. Requests with no `Origin` header (e.g. server-to-server calls,
   * curl) are not blocked by this check — they are expected to be protected by bearer token
   * auth or other mechanisms instead.
   *
   * Set to `false` only if your deployment uses a strict same-origin policy enforced by a
   * reverse proxy, or if origin validation is causing issues with cross-subdomain same-site
   * requests that you explicitly want to allow.
   */
  checkOrigin?: boolean;
}
