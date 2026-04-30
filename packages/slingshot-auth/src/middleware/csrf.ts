import { getCsrfCookieOptions, readAuthCookie } from '@auth/lib/cookieOptions';
import { isProd } from '@auth/lib/env';
import { createHmac, randomBytes } from 'crypto';
import type { MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, SigningConfig } from '@lastshotlabs/slingshot-core';
import {
  COOKIE_CSRF_TOKEN,
  COOKIE_TOKEN,
  HEADER_CSRF_TOKEN,
  isPublicPath,
  timingSafeEqual,
} from '@lastshotlabs/slingshot-core';
import { DEFAULT_AUTH_CONFIG } from '../config/authConfig';
import { getSigningSecret } from '../infra/signing';
import { getAuthRuntimeFromRequest } from '../runtime';
import type { AuthRuntimeContext } from '../runtime';

const STATE_CHANGING_METHODS = Object.freeze(new Set(['POST', 'PUT', 'PATCH', 'DELETE']));

function getCsrfSecret(c?: { get?(key: string): unknown }, signing?: SigningConfig | null): string {
  const ctxSigning = c?.get?.('slingshotCtx') as { signing?: SigningConfig | null } | undefined;
  const raw = getSigningSecret(ctxSigning?.signing ?? signing);
  if (!raw)
    throw new Error(
      '[slingshot] CSRF middleware: no signing secret configured. Set JWT_SECRET or inject a signing config via createServer({ security: { signing: ... } }).',
    );
  return Array.isArray(raw) ? raw[0] : raw;
}

function generateCsrfToken(secret: string): string {
  const token = randomBytes(32).toString('hex');
  const sig = createHmac('sha256', secret).update(token).digest('hex');
  return `${token}.${sig}`;
}

function verifyCsrfSignature(cookieValue: string, secret: string): boolean {
  const dotIdx = cookieValue.indexOf('.');
  if (dotIdx === -1) return false;
  const token = cookieValue.substring(0, dotIdx);
  const sig = cookieValue.substring(dotIdx + 1);
  const expected = createHmac('sha256', secret).update(token).digest('hex');
  return timingSafeEqual(sig, expected);
}

export interface CsrfMiddlewareOptions {
  exemptPaths?: string[];
  protectedUnauthenticatedPaths?: string[];
  checkOrigin?: boolean;
  allowedOrigins?: string | string[];
  signing?: SigningConfig | null;
}

/**
 * Regenerates and sets a new CSRF token cookie on the response.
 *
 * Should be called after every login, registration, or session creation to rotate the
 * CSRF token and prevent session-fixation-adjacent attacks where an attacker who
 * pre-seeded a CSRF cookie could later use it once the victim authenticates.
 *
 * The new token is an HMAC-signed value derived from the configured signing secret.
 * It is stored in the `x-csrf-token` cookie (httpOnly: false) so the client JavaScript
 * can read it and send it in the `x-csrf-token` request header.
 *
 * @param c - The Hono context (used to set the cookie and resolve the signing secret).
 * @param signing - Optional signing config override. Defaults to the runtime config's signing secret.
 *
 * @remarks
 * **Call after every authentication boundary**: call this function after login,
 * registration, and session restoration (e.g., refresh-token exchange) to rotate the
 * CSRF token. Failing to rotate after login leaves the pre-login CSRF cookie in place,
 * which an attacker could have pre-seeded via a subdomain cookie injection, then used
 * after the victim authenticates.
 *
 * The `csrfProtection` middleware sets a token cookie automatically on the first
 * unauthenticated visit, but that token is not tied to a session. `refreshCsrfToken`
 * replaces it with a freshly generated value that is only valid for the new session's
 * lifetime.
 *
 * @example
 * import { refreshCsrfToken } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * // In a login route handler, after issuing the session cookie:
 * refreshCsrfToken(c, runtime.signing);
 */
export function refreshCsrfToken(
  c: Parameters<typeof setCookie>[0],
  signing?: SigningConfig | null,
): void {
  const secret = getCsrfSecret(c as { get?(key: string): unknown }, signing);
  const token = generateCsrfToken(secret);
  const authRuntime = getAuthRuntimeFromRequest(c as { get(key: string): unknown });
  setCookie(c, COOKIE_CSRF_TOKEN, token, getCsrfCookieOptions(isProd(), authRuntime.config));
}

/**
 * Clears the CSRF token cookie from the response.
 *
 * @param c - The Hono context whose response will have the CSRF cookie cleared.
 * @returns `void` — operates as a side-effect on the response headers.
 *
 * @remarks
 * **Call at the end of all logout routes before sending the response.** Specifically,
 * call this on any route that:
 * - Performs a normal user logout (`POST /auth/logout`)
 * - Performs an admin-forced or server-side session invalidation
 * - Revokes all sessions for a user (e.g., password change with `revoke_all_and_reissue`)
 *
 * Leaving the CSRF cookie in place after logout is harmless in most cases because
 * `csrfProtection` skips validation when no auth session cookie is present. However,
 * clearing it provides defence-in-depth and satisfies strict security audits that
 * check for cookie hygiene on logout.
 *
 * The cookie is deleted with `path: '/'` to ensure the deletion matches the original
 * cookie scope regardless of the current request path.
 *
 * @example
 * import { clearCsrfToken } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * app.post('/auth/logout', userAuth, async (c) => {
 *   deleteCookie(c, COOKIE_TOKEN, { path: '/' });
 *   clearCsrfToken(c);
 *   return c.json({ success: true });
 * });
 */
export function clearCsrfToken(c: Parameters<typeof deleteCookie>[0]): void {
  deleteCookie(c, COOKIE_CSRF_TOKEN, { path: '/' });
}

/**
 * Creates a CSRF protection middleware using HMAC-signed double-submit cookie semantics.
 *
 * On every response the middleware sets an `x-csrf-token` cookie (httpOnly: false) if one is
 * not already present. The value is a 32-byte random nonce with an HMAC-SHA256 signature
 * appended. Client code must read this cookie and echo it back in the `x-csrf-token` request
 * header on every state-changing request (POST, PUT, PATCH, DELETE).
 *
 * Validation pipeline for state-changing requests:
 * 1. **Auth cookie presence check** — CSRF is only exploitable when the user is authenticated;
 *    unauthenticated requests are passed through immediately.
 * 2. **Exempt path check** — paths listed in `exemptPaths` are skipped (supports `*` suffix
 *    for prefix matching, e.g. `'/webhooks/*'`).
 * 3. **Origin validation** (secondary, opt-in) — if `checkOrigin` is `true` and specific
 *    `allowedOrigins` are configured, the `Origin` header must match one of the allowed origins.
 *    When `allowedOrigins` is `'*'` or unset, origin validation is skipped with a startup warning.
 * 4. **HMAC signature verification** — the cookie value's signature is re-computed and compared
 *    to prevent an attacker from injecting a crafted cookie value.
 * 5. **Double-submit comparison** — the `x-csrf-token` header value must equal the cookie value
 *    (timing-safe comparison).
 *
 * Failed checks emit `security.csrf.failed` events on the event bus (when an auth runtime is
 * available) with the request path, method, and failure reason.
 *
 * @param options - Optional configuration for the CSRF middleware.
 * @param options.exemptPaths - Paths to skip CSRF validation. Supports exact match or `*`-suffix
 *   prefix match (e.g., `['/webhooks/*', '/health']`). Defaults to `[]`.
 * @param options.protectedUnauthenticatedPaths - Additional state-changing paths that must
 *   require the CSRF double-submit token even when there is no auth session cookie yet.
 *   Use for public auth endpoints that create or refresh a session (e.g. login, register,
 *   OAuth code exchange). Supports exact match or `*`-suffix prefix match. Defaults to `[]`.
 * @param options.checkOrigin - Whether to validate the `Origin` header against `allowedOrigins`.
 *   Only meaningful when `allowedOrigins` lists specific origins. Defaults to `true`.
 * @param options.allowedOrigins - Allowed origin(s) for the origin check. `'*'` (or unset)
 *   disables origin validation. Trailing slashes are stripped for comparison.
 * @param options.signing - Optional `SigningConfig` override. When absent the middleware resolves
 *   the secret from the injected `slingshotCtx` on the Hono context (standard bootstrap path).
 * @returns A Hono `MiddlewareHandler<AppEnv>` that enforces CSRF protection on every
 *   state-changing request where an auth session cookie is present.
 *
 * @throws `Error` (at request time) if no signing secret is configured and none can be
 *   resolved from context — message includes a remediation hint.
 *
 * @remarks
 * **Validation is skipped for** (in order):
 * 1. Non-mutating HTTP methods (`GET`, `HEAD`, `OPTIONS`, etc.) — only `POST`, `PUT`,
 *    `PATCH`, and `DELETE` are checked.
 * 2. Requests that have no auth session cookie (`slingshot_token` absent), unless the path
 *    is explicitly listed in `protectedUnauthenticatedPaths`.
 * 3. Paths listed in `exemptPaths` — supports exact match or `*`-suffix prefix match.
 *
 * The double-submit pattern provides CSRF protection without server-side session state:
 * the cookie acts as the ground truth and the header value must match. The HMAC signature
 * on the cookie prevents an attacker from crafting a valid cookie even if they can set
 * arbitrary cookies (subdomain takeover).
 *
 * For SPA deployments that control the full origin space, leave `checkOrigin: true` and
 * set `allowedOrigins` to your production domain(s). For server-rendered apps or third-party
 * integrations where origin is unreliable, rely solely on the HMAC double-submit check.
 *
 * @example
 * import { csrfProtection } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * app.use('*', csrfProtection({
 *   allowedOrigins: ['https://app.example.com'],
 *   exemptPaths: ['/webhooks/*', '/health'],
 * }));
 *
 * @example
 * // Standalone usage (outside auth plugin) with an explicit signing config
 * app.use('*', csrfProtection({
 *   signing: { secret: process.env.CSRF_SECRET },
 *   checkOrigin: false,
 * }));
 */
function matchesPath(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('*')) {
      if (path.startsWith(pattern.slice(0, -1))) return true;
    } else if (path === pattern) {
      return true;
    }
  }
  return false;
}

function originFromReferer(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export const csrfProtection = (options: CsrfMiddlewareOptions = {}): MiddlewareHandler<AppEnv> => {
  const {
    exemptPaths = [],
    protectedUnauthenticatedPaths = [],
    checkOrigin = true,
    allowedOrigins,
    signing,
  } = options;

  // Normalize allowed origins for origin validation
  const originSet = new Set<string>();
  if (allowedOrigins) {
    const origins = Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins];
    for (const o of origins) {
      // "*" is intentionally excluded: validating against a wildcard would accept any origin,
      // defeating the check. When CORS is open, origin validation is meaningless.
      if (o !== '*') originSet.add(o.replace(/\/$/, ''));
    }
  }

  if (checkOrigin && originSet.size === 0) {
    // Warn in all environments — this is a one-time startup message, not per-request noise,
    // and a misconfigured production deployment should surface it.
    console.warn(
      '[slingshot] csrfProtection: checkOrigin is enabled but no specific allowed origins are ' +
        'configured (CORS is "*" or allowedOrigins is unset). Origin validation is disabled — ' +
        'only the HMAC double-submit cookie check is active. Set security.cors to specific ' +
        'origins to enable origin validation.',
    );
  }

  return async (c, next) => {
    const slingshotCtx =
      typeof (c as { get?: unknown }).get === 'function'
        ? ((c as { get(name: string): unknown }).get('slingshotCtx') as
            | { publicPaths?: Iterable<string> }
            | undefined)
        : undefined;

    const path = c.req.path;
    const protectAnonymous = matchesPath(path, protectedUnauthenticatedPaths);

    if (isPublicPath(path, slingshotCtx?.publicPaths) && !protectAnonymous) {
      return next();
    }

    const secret = getCsrfSecret(c, signing);

    // Resolve auth runtime if available — may be absent in standalone usage
    let authRuntime: AuthRuntimeContext | null = null;
    try {
      authRuntime = getAuthRuntimeFromRequest(c);
    } catch {
      // standalone usage: csrfProtection used without auth plugin
    }

    // Set CSRF cookie on every response if not already present
    const existingCsrf = getCookie(c, COOKIE_CSRF_TOKEN);
    if (!existingCsrf) {
      const token = generateCsrfToken(secret);
      setCookie(
        c,
        COOKIE_CSRF_TOKEN,
        token,
        getCsrfCookieOptions(isProd(), authRuntime?.config ?? DEFAULT_AUTH_CONFIG),
      );
    }

    // Only validate state-changing methods
    if (!STATE_CHANGING_METHODS.has(c.req.method)) {
      return next();
    }

    // Skip exempt paths
    if (matchesPath(path, exemptPaths)) {
      return next();
    }

    // Skip if no auth cookie present and the route is not an explicitly protected
    // anonymous auth boundary (e.g. login/register/session exchange).
    const authCookie = readAuthCookie(
      c,
      COOKIE_TOKEN,
      isProd(),
      authRuntime?.config ?? DEFAULT_AUTH_CONFIG,
    );
    if (!authCookie && !protectAnonymous) {
      return next();
    }

    // Origin validation (secondary layer)
    if (checkOrigin && originSet.size > 0) {
      const origin = c.req.header('origin') ?? originFromReferer(c.req.header('referer'));
      if (!origin) {
        authRuntime?.eventBus.emit('security.csrf.failed', {
          path: c.req.path,
          meta: { method: c.req.method, reason: 'origin_missing' },
        });
        return c.json({ error: 'CSRF origin missing' }, 403);
      }
      const normalized = origin.replace(/\/$/, '');
      if (!originSet.has(normalized)) {
        authRuntime?.eventBus.emit('security.csrf.failed', {
          path: c.req.path,
          meta: { method: c.req.method, reason: 'origin_mismatch' },
        });
        return c.json({ error: 'CSRF origin mismatch' }, 403);
      }
    }

    // Double submit cookie validation
    const csrfCookie = getCookie(c, COOKIE_CSRF_TOKEN);
    const csrfHeader = c.req.header(HEADER_CSRF_TOKEN);

    if (!csrfCookie || !csrfHeader) {
      authRuntime?.eventBus.emit('security.csrf.failed', {
        path: c.req.path,
        meta: { method: c.req.method, reason: 'token_missing' },
      });
      return c.json({ error: 'CSRF token missing' }, 403);
    }

    // Verify the cookie's HMAC signature (prevents cookie injection)
    if (!verifyCsrfSignature(csrfCookie, secret)) {
      authRuntime?.eventBus.emit('security.csrf.failed', {
        path: c.req.path,
        meta: { method: c.req.method, reason: 'token_invalid' },
      });
      return c.json({ error: 'CSRF token invalid' }, 403);
    }

    // Compare header value to cookie value
    if (!timingSafeEqual(csrfHeader, csrfCookie)) {
      authRuntime?.eventBus.emit('security.csrf.failed', {
        path: c.req.path,
        meta: { method: c.req.method, reason: 'token_mismatch' },
      });
      return c.json({ error: 'CSRF token mismatch' }, 403);
    }

    return next();
  };
};
