import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AuthResolvedConfig } from '../config/authConfig';

const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Returns the effective cookie name, applying the `__Host-` prefix when the cookie
 * meets all requirements for the prefix: `Secure` is true, `Path` is `/`, and no
 * custom `Domain` is set.
 *
 * The `__Host-` prefix is a defense-in-depth measure that instructs the browser to
 * enforce: the cookie must have `Secure`, must have `Path=/`, and must NOT have a
 * `Domain` attribute. This prevents cookie injection and subdomain override attacks.
 *
 * @param baseName - The base cookie name (e.g. `'token'`, `'refresh_token'`).
 * @param isProduction - Whether the app is running in production (determines `Secure` default).
 * @param config - Resolved auth config to check for custom domain settings.
 * @returns The cookie name, prefixed with `__Host-` when conditions are met.
 *
 * @example
 * const name = getSecureCookieName('token', true, config);
 * // → '__Host-token' in production with no custom domain
 * // → 'token' in development or when a custom domain is configured
 */
export function getSecureCookieName(
  baseName: string,
  isProduction: boolean,
  config: AuthResolvedConfig,
): string {
  const c = config.authCookie;
  const secure = c.secure ?? isProduction;
  const path = c.path ?? '/';
  const domain = c.domain;
  if (secure && path === '/' && !domain) {
    return `__Host-${baseName}`;
  }
  return baseName;
}

/**
 * Reads an auth cookie, preferring the hardened `__Host-` name when applicable and
 * falling back to the plain name for backward-compatible cleanup and migration.
 *
 * @param c - Hono context or compatible cookie source.
 * @param baseName - The base cookie name (e.g. `'token'`, `'refresh_token'`).
 * @param isProduction - Whether the app is running in production.
 * @param config - Resolved auth config to derive the effective cookie name.
 * @returns The cookie value when present, otherwise `null`.
 */
export function readAuthCookie(
  c: Parameters<typeof getCookie>[0],
  baseName: string,
  isProduction: boolean,
  config: AuthResolvedConfig,
): string | null {
  const secureName = getSecureCookieName(baseName, isProduction, config);
  return getCookie(c, secureName) ?? getCookie(c, baseName) ?? null;
}

/**
 * Returns cookie options for the HttpOnly session/auth cookie.
 *
 * `httpOnly` is always `true` — it is not configurable because the session cookie
 * must never be accessible to JavaScript. All other attributes (`secure`, `sameSite`,
 * `path`, `domain`, `maxAge`) derive from `config.authCookie` with safe defaults.
 *
 * @param isProduction - When `true`, `secure` defaults to `true` (HTTPS-only cookie).
 * @param config - Resolved auth config supplying `authCookie` overrides.
 * @param maxAge - Optional override for the cookie max-age in seconds.
 *   Falls back to `config.authCookie.maxAge` then to 7 days.
 * @returns A cookie options object compatible with Hono's `setCookie`.
 *
 * @example
 * import { getAuthCookieOptions } from '@lastshotlabs/slingshot-auth/plugin';
 * import { setCookie } from 'hono/cookie';
 *
 * const opts = getAuthCookieOptions(isProd(), runtime.config);
 * setCookie(c, COOKIE_TOKEN, jwtToken, opts);
 */
export function getAuthCookieOptions(
  isProduction: boolean,
  config: AuthResolvedConfig,
  maxAge?: number,
) {
  const c = config.authCookie;
  return {
    httpOnly: true as const, // always true for auth cookies
    secure: c.secure ?? isProduction,
    sameSite: c.sameSite ?? 'Lax',
    path: c.path ?? '/',
    domain: c.domain,
    maxAge:
      maxAge ?? c.maxAge ?? config.sessionPolicy.absoluteTimeout ?? DEFAULT_SESSION_TTL_SECONDS,
  };
}

/**
 * Sets an auth cookie using the effective hardened cookie name for the current config.
 *
 * @param c - Hono context or compatible cookie target.
 * @param baseName - The base cookie name (e.g. `'token'`, `'refresh_token'`).
 * @param value - Cookie value to store.
 * @param isProduction - Whether the app is running in production.
 * @param config - Resolved auth config to derive name and attributes.
 * @param maxAge - Optional cookie max-age override in seconds.
 */
export function setAuthCookie(
  c: Parameters<typeof setCookie>[0],
  baseName: string,
  value: string,
  isProduction: boolean,
  config: AuthResolvedConfig,
  maxAge?: number,
): void {
  const name = getSecureCookieName(baseName, isProduction, config);
  setCookie(c, name, value, getAuthCookieOptions(isProduction, config, maxAge));
}

/**
 * Clears an auth cookie under both the current hardened name and the legacy plain name.
 *
 * This intentionally deletes both names so that production deployments can clean up
 * cookies issued before a hardening change or from mixed environments.
 *
 * @param c - Hono context or compatible cookie target.
 * @param baseName - The base cookie name (e.g. `'token'`, `'refresh_token'`).
 * @param isProduction - Whether the app is running in production.
 * @param config - Resolved auth config to derive the hardened cookie name and scope.
 */
export function clearAuthCookie(
  c: Parameters<typeof deleteCookie>[0],
  baseName: string,
  isProduction: boolean,
  config: AuthResolvedConfig,
): void {
  const secureName = getSecureCookieName(baseName, isProduction, config);
  const path = config.authCookie.path ?? '/';
  const domain = config.authCookie.domain;
  const secure = config.authCookie.secure ?? isProduction;
  deleteCookie(c, secureName, { path, domain, secure });
  if (secureName !== baseName) {
    deleteCookie(c, baseName, { path, domain, secure });
  }
}

/**
 * Returns cookie options for the CSRF double-submit cookie.
 *
 * `httpOnly` is **always `false`** and is not configurable. The double-submit pattern
 * requires client JavaScript to read the cookie value and echo it in the `x-csrf-token`
 * request header — an httpOnly cookie cannot be read by JS, which would break CSRF
 * protection entirely.
 *
 * All other attributes (`secure`, `sameSite`, `path`, `domain`, `maxAge`) derive from
 * `config.csrfCookie` with the following safe defaults:
 * - `secure`: `isProduction` (HTTPS-only in production)
 * - `sameSite`: `'Lax'`
 * - `path`: `'/'`
 * - `maxAge`: 1 year (`60 * 60 * 24 * 365`) — the CSRF cookie is tied to the browser,
 *   not to the session, so it should outlive any individual session.
 *
 * @param isProduction - When `true`, `secure` defaults to `true` (HTTPS-only).
 * @param config - Resolved auth config supplying `csrfCookie` overrides.
 * @returns A cookie options object compatible with Hono's `setCookie`.
 *
 * @remarks
 * The CSRF cookie intentionally persists beyond session expiry. The csrfProtection
 * middleware re-uses the existing cookie across sessions rather than issuing a new one
 * on every login. Rotation happens explicitly via `refreshCsrfToken` after successful
 * authentication to prevent session-fixation-adjacent attacks.
 *
 * @example
 * import { getCsrfCookieOptions } from '@lastshotlabs/slingshot-auth/plugin';
 * import { setCookie } from 'hono/cookie';
 *
 * const opts = getCsrfCookieOptions(isProd(), runtime.config);
 * setCookie(c, COOKIE_CSRF_TOKEN, csrfToken, opts);
 */
export function getCsrfCookieOptions(isProduction: boolean, config: AuthResolvedConfig) {
  const c = config.csrfCookie;
  return {
    httpOnly: false as const, // always false — JS must read it
    secure: c.secure ?? isProduction,
    sameSite: c.sameSite ?? 'Lax',
    path: c.path ?? '/',
    domain: c.domain,
    maxAge: c.maxAge ?? 60 * 60 * 24 * 365, // 1 year — tied to browser, not session
  };
}
