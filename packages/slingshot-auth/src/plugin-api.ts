/**
 * @module @lastshotlabs/slingshot-auth/plugin
 *
 * Internal API surface for officially-supported slingshot plugin packages.  **Not intended for direct consumer use.**
 *
 * These are service-layer primitives that dependent plugins need to implement
 * their own route handlers while reusing the core auth session, CSRF, and
 * event-emission logic.
 *
 * Exported symbols:
 *
 * - {@link getAuthCookieOptions} — Cookie options for the HttpOnly session cookie.
 * - {@link setAuthCookie} / {@link clearAuthCookie} / {@link readAuthCookie} — Hardened auth-cookie helpers.
 * - {@link isProd} — Whether the process is running in production.
 * - {@link storeOAuthCode} / {@link consumeOAuthCode} — OAuth authorization code lifecycle.
 * - {@link storeReauthConfirmation} / {@link consumeReauthConfirmation} — OAuth re-auth confirmation lifecycle.
 * - {@link refreshCsrfToken} — Rotate the CSRF double-submit cookie after login.
 * - {@link createSessionForUser} — Issue a new authenticated session for a user.
 * - {@link emitLoginSuccess} — Emit standard login-success events on the event bus.
 * - {@link runPreLoginHook} — Invoke the `preLogin` lifecycle hook.
 * - {@link assertLoginEmailVerified} — Enforce the required email-verification login gate.
 * - {@link getSuspended} — Resolve the current suspension state for a user account.
 * - {@link verifyAnyFactor} — Unified second-factor verification for step-up auth.
 */
// @lastshotlabs/slingshot-auth/plugin

export {
  clearAuthCookie,
  getAuthCookieOptions,
  readAuthCookie,
  setAuthCookie,
} from './lib/cookieOptions';
export { isProd } from './lib/env';
export { consumeOAuthCode, storeOAuthCode } from './lib/oauthCode';
export { consumeReauthConfirmation, storeReauthConfirmation } from './lib/oauthReauth';
export { getSuspended } from './lib/suspension';
export { refreshCsrfToken } from './middleware/csrf';
export {
  assertLoginEmailVerified,
  createSessionForUser,
  emitLoginSuccess,
  runPreLoginHook,
} from './services/auth';
export { verifyAnyFactor } from './services/mfa';
