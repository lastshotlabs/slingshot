import { setAuthCookie } from '@auth/lib/cookieOptions';
import { isProd } from '@auth/lib/env';
import { refreshCsrfToken } from '@auth/middleware/csrf';
import { TokenResponse, createLoginSchema } from '@auth/schemas/auth';
import { ErrorResponse } from '@auth/schemas/error';
import * as AuthService from '@auth/services/auth';
import type { Context } from 'hono';
import { createRoute, errorResponse } from '@lastshotlabs/slingshot-core';
import {
  COOKIE_REFRESH_TOKEN,
  COOKIE_TOKEN,
  HttpError,
  createRouter,
  getClientIp,
} from '@lastshotlabs/slingshot-core';
import type {
  AuthRateLimitConfig,
  HookContext,
  PrimaryField,
  RefreshTokenConfig,
} from '../config/authConfig';
import type { AuthRuntimeContext } from '../runtime';

export interface LoginRouterOptions {
  primaryField: PrimaryField;
  rateLimit?: AuthRateLimitConfig;
  refreshTokens?: RefreshTokenConfig;
}

/**
 * Creates the login router.
 *
 * Mounted routes:
 * - `POST /auth/login` — Authenticate with primary-field credentials (password) and
 *                        receive a JWT session token. Returns an MFA challenge token when
 *                        the account has MFA enrolled, requiring a follow-up call to
 *                        `POST /auth/mfa/verify`.
 *
 * @param options - Router configuration.
 * @param options.primaryField - The primary identifier field (`'email'`, `'username'`, or
 *   `'phone'`). Controls which body key is read as the login identifier.
 * @param options.rateLimit - Per-endpoint rate-limit overrides (`login` window and max).
 * @param options.refreshTokens - Refresh-token config; controls whether a refresh-token
 *   cookie is issued and the access-token cookie max-age.
 * @param runtime - The auth runtime context (adapter, event bus, repos, rate limiter,
 *   security gate, etc.).
 * @returns A Hono router with the login route mounted.
 *
 * @throws {HttpError} 401 — Invalid credentials.
 * @throws {HttpError} 403 — Email not verified (when email verification is required).
 * @throws {HttpError} 423 — Account is locked due to excessive failed attempts.
 * @throws {HttpError} 429 — Too many failed login attempts; rate-limited by identifier
 *   and credential-stuffing detection.
 *
 * @remarks
 * **Authentication requirements**: `POST /auth/login` is publicly accessible — no
 * session or token is required. All routes in this router are unauthenticated by design.
 *
 * **Token types**: on success the response includes a `sessionToken` (JWT) in both the
 * JSON body and the `slingshot_token` `HttpOnly` cookie. When MFA is enrolled, the response
 * instead includes an `mfaToken` (a short-lived opaque token, not a JWT). The `mfaToken`
 * must be passed to `POST /auth/mfa/verify` as the `mfaToken` body field — it cannot be
 * used to authenticate API requests.
 *
 * On success the session token is set as an `HttpOnly` cookie (`slingshot_token`) in
 * addition to being returned in the JSON body. When refresh tokens are configured, a
 * short-lived access token and a long-lived refresh token are issued simultaneously.
 * Failed 401 attempts increment the credential-stuffing counter; if the threshold is
 * crossed the `security.credential_stuffing.detected` event is emitted and subsequent
 * requests from that IP are blocked immediately.
 *
 * @example
 * const router = createLoginRouter(
 *   { primaryField: 'email', rateLimit: { login: { max: 10, windowMs: 15 * 60 * 1000 } } },
 *   runtime,
 * );
 * app.route('/', router);
 */
export const createLoginRouter = (
  { primaryField, refreshTokens }: LoginRouterOptions,
  runtime: AuthRuntimeContext,
) => {
  const { eventBus } = runtime;
  const getConfig = () => runtime.config;
  const router = createRouter();
  const LoginSchema = createLoginSchema(primaryField);
  const tags = ['Auth'];

  const hookCtx = (c: Context): HookContext => ({
    ip: getClientIp(c) !== 'unknown' ? getClientIp(c) : undefined,
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.get('requestId') as string | undefined,
  });

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/login',
      summary: 'Log in',
      description:
        'Authenticates with credentials and returns a JWT session token. The token is also set as an HttpOnly session cookie. Failed attempts are rate-limited per identifier.',
      tags,
      request: {
        body: {
          content: { 'application/json': { schema: LoginSchema } },
          description: 'Login credentials.',
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: TokenResponse } },
          description: 'Authenticated. Returns a session token.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Invalid credentials.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Email not verified. Verification is required before login.',
        },
        423: {
          content: { 'application/json': { schema: ErrorResponse } },
          description:
            'Account is locked due to too many failed login attempts. Wait for the lockout to expire or contact support.',
        },
        429: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Too many failed login attempts for this identifier. Try again later.',
        },
      },
    }),
    async c => {
      const body: Record<string, string> = c.req.valid('json');
      const identifier = body[primaryField];
      const clientIp = getClientIp(c);
      const preDecision = await runtime.securityGate.preAuthCheck(clientIp, identifier);
      if (!preDecision.allowed) {
        if (preDecision.reason === 'credential_stuffing') {
          eventBus.emit('security.credential_stuffing.detected', {
            ip: clientIp,
            meta: { identifier },
          });
          throw new HttpError(
            429,
            'Too many login attempts from this source',
            'CREDENTIAL_STUFFING_BLOCKED',
          );
        }
        eventBus.emit('security.rate_limit.exceeded', { meta: { path: c.req.path } });
        return errorResponse(c, 'Too many failed login attempts. Try again later.', 429);
      }
      const metadata = {
        ipAddress: clientIp !== 'unknown' ? clientIp : undefined,
        userAgent: c.req.header('user-agent') ?? undefined,
      };
      try {
        const result = await AuthService.login(
          identifier,
          body.password,
          runtime,
          metadata,
          hookCtx(c),
        );
        await runtime.securityGate.recordLoginSuccess(identifier);
        if (!result.mfaRequired) {
          setAuthCookie(
            c,
            COOKIE_TOKEN,
            result.token,
            isProd(),
            runtime.config,
            refreshTokens ? (getConfig().refreshToken?.accessTokenExpiry ?? 900) : undefined,
          );
          if (result.refreshToken) {
            setAuthCookie(
              c,
              COOKIE_REFRESH_TOKEN,
              result.refreshToken,
              isProd(),
              runtime.config,
              getConfig().refreshToken?.refreshTokenExpiry ?? 2_592_000,
            );
          }
          if (getConfig().csrfEnabled) refreshCsrfToken(c);
        }
        return c.json(result, 200);
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) {
          const { stuffingNowBlocked } = await runtime.securityGate.recordLoginFailure(
            clientIp,
            identifier,
          );
          if (stuffingNowBlocked) {
            eventBus.emit('security.credential_stuffing.detected', {
              ip: clientIp,
              meta: { identifier },
            });
          }
        }
        throw err;
      }
    },
  );

  return router;
};
