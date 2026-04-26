import { checkBreachedPassword } from '@auth/lib/breachedPassword';
import { setAuthCookie } from '@auth/lib/cookieOptions';
import { consumeVerificationToken } from '@auth/lib/emailVerification';
import { isProd } from '@auth/lib/env';
import { refreshCsrfToken } from '@auth/middleware/csrf';
import { TokenResponse, createRegisterSchema } from '@auth/schemas/auth';
import { ErrorResponse } from '@auth/schemas/error';
import * as AuthService from '@auth/services/auth';
import { emitLoginSuccess, runPreLoginHook } from '@auth/services/auth';
import type { Context } from 'hono';
import { z } from 'zod';
import { createRoute, errorResponse, getRequestTenantId } from '@lastshotlabs/slingshot-core';
import {
  COOKIE_REFRESH_TOKEN,
  COOKIE_TOKEN,
  HttpError,
  createRouter,
  getClientIp,
} from '@lastshotlabs/slingshot-core';
import type {
  AuthRateLimitConfig,
  ConcealRegistrationConfig,
  EmailVerificationConfig,
  HookContext,
  PrimaryField,
  RefreshTokenConfig,
} from '../config/authConfig';
import { publishAuthEvent } from '../eventGovernance';
import type { AuthRuntimeContext } from '../runtime';

export interface RegisterRouterOptions {
  primaryField: PrimaryField;
  emailVerification?: EmailVerificationConfig;
  rateLimit?: AuthRateLimitConfig;
  concealRegistration?: ConcealRegistrationConfig;
  refreshTokens?: RefreshTokenConfig;
}

/**
 * Creates the user registration router.
 *
 * Mounted routes (standard mode — `concealRegistration` not set):
 * - `POST /auth/register` — Create a new account and issue a session token (201).
 *                           When `emailVerification.required` is enabled for an email-primary
 *                           app, registration succeeds without issuing a live session until the
 *                           email proof is completed.
 *
 * Mounted routes (concealed-registration mode — `concealRegistration` set):
 * - `POST /auth/register`        — Create a new account and return a generic 200 message
 *                                  regardless of whether the identifier was already taken,
 *                                  preventing user enumeration via registration.
 * - `POST /auth/verify-and-login`— Consume a single-use email verification token, mark
 *                                  the account as verified, and issue a session. This is
 *                                  the login path for concealed-registration flows where
 *                                  the account is not active until the email is confirmed.
 *
 * @param options - Router configuration.
 * @param options.primaryField - The primary identifier field (`'email'`, `'username'`, or
 *   `'phone'`). Controls which body key is read as the registration identifier and which
 *   label appears in conflict messages.
 * @param options.emailVerification - Email verification config. When set, a verification
 *   token is sent after registration via the `auth:delivery.email_verification` event.
 * @param options.rateLimit - Per-endpoint rate-limit overrides (`register`,
 *   `verifyEmail` windows and max counts).
 * @param options.concealRegistration - When set, switches to concealed-registration mode
 *   (always-200, plus `verify-and-login` endpoint).
 * @param options.refreshTokens - Refresh-token config; controls whether a refresh-token
 *   cookie is issued alongside the access token.
 * @param runtime - The auth runtime context (adapter, event bus, repos, rate limiter,
 *   password hasher, etc.).
 * @returns A Hono router with registration routes mounted.
 *
 * @throws {HttpError} 400 — Validation error, or password appeared in a breach database.
 * @throws {HttpError} 409 — Identifier already registered (standard mode only).
 * @throws {HttpError} 429 — Too many registration attempts from this IP.
 *
 * @remarks
 * **Authentication requirements**: all routes in this router are publicly accessible —
 * no session or token is required. `POST /auth/verify-and-login` (concealed mode only)
 * is also unauthenticated; it accepts the single-use email verification token as a body
 * field and exchanges it for a session. The verification token is NOT a `sessionToken`
 * or `mfaToken` — it is sent by email and consumed here.
 *
 * **Token types**: standard `POST /auth/register` returns a `sessionToken` (JWT) and
 * sets the `slingshot_token` `HttpOnly` cookie directly unless required email verification
 * is enabled, in which case it returns an empty token and defers session issuance until
 * verification completes. In concealed-registration mode, `POST /auth/register` returns
 * no token; `POST /auth/verify-and-login` returns the `sessionToken` after the email is
 * verified. When MFA is enrolled at registration time, an `mfaToken` is returned instead,
 * requiring a follow-up `POST /auth/mfa/verify`. The concealed `verify-and-login` path
 * still runs the standard `preLogin` lifecycle hook before it issues a session, so
 * hook-based access policy applies consistently across all login entry points.
 *
 * In both modes, if `breachedPasswordCheck` is configured, the password is checked
 * against the HaveIBeenPwned API before account creation. Registration is rate-limited
 * by requesting IP. In concealed-registration mode, if the identifier already exists,
 * `concealRegistration.onExistingAccount` is called (fire-and-forget) and the same
 * generic message is returned — the caller cannot distinguish a new signup from a
 * duplicate.
 *
 * @example
 * // Standard mode
 * const router = createRegisterRouter(
 *   { primaryField: 'email' },
 *   runtime,
 * );
 *
 * // Concealed mode
 * const router = createRegisterRouter(
 *   { primaryField: 'email', concealRegistration: { onExistingAccount: sendDuplicateEmail } },
 *   runtime,
 * );
 * app.route('/', router);
 */
export const createRegisterRouter = (
  { primaryField, rateLimit, concealRegistration, refreshTokens }: RegisterRouterOptions,
  runtime: AuthRuntimeContext,
) => {
  const { adapter, eventBus } = runtime;
  const getConfig = () => runtime.config;
  const router = createRouter();
  const RegisterSchema = createRegisterSchema(primaryField, runtime.config.passwordPolicy);
  const fieldLabel = primaryField.charAt(0).toUpperCase() + primaryField.slice(1);
  const alreadyRegisteredMsg = `${fieldLabel} already registered`;
  const tags = ['Auth'];

  const hookCtx = (c: Context): HookContext => ({
    ip: getClientIp(c) !== 'unknown' ? getClientIp(c) : undefined,
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.get('requestId') as string | undefined,
  });

  const registerOpts = {
    windowMs: rateLimit?.register?.windowMs ?? 60 * 60 * 1000,
    max: rateLimit?.register?.max ?? 5,
  };
  const verifyOpts = {
    windowMs: rateLimit?.verifyEmail?.windowMs ?? 15 * 60 * 1000,
    max: rateLimit?.verifyEmail?.max ?? 10,
  };

  const CONCEALED_REGISTER_MESSAGE =
    "If this email isn't registered yet, check your inbox to complete sign-up.";

  if (concealRegistration) {
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/register',
        summary: 'Register a new account',
        description:
          'Creates a new user account. When concealRegistration is enabled, always returns 200 with a generic message regardless of whether the email is already registered. Rate-limited by IP.',
        tags,
        request: {
          body: {
            content: { 'application/json': { schema: RegisterSchema } },
            description: 'Registration credentials.',
          },
        },
        responses: {
          200: {
            content: { 'application/json': { schema: z.object({ message: z.string() }) } },
            description: 'Request received. Check your inbox to complete sign-up.',
          },
          400: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Validation error (e.g. missing field, password too short).',
          },
          429: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Too many registration attempts from this IP. Try again later.',
          },
        },
      }),
      async c => {
        const ip = getClientIp(c);
        if (await runtime.rateLimit.trackAttempt(`register:${ip}`, registerOpts)) {
          eventBus.emit('security.rate_limit.exceeded', { meta: { path: c.req.path } });
          return errorResponse(c, 'Too many registration attempts. Try again later.', 429);
        }
        const body = c.req.valid('json');
        const identifier = body[primaryField];

        const findFn = (id: string) =>
          adapter.findByIdentifier ? adapter.findByIdentifier(id) : adapter.findByEmail(id);
        const existing = await findFn(identifier);
        if (existing) {
          eventBus.emit('security.auth.register.concealed', { meta: { identifier } });
          if (concealRegistration.onExistingAccount) {
            void concealRegistration.onExistingAccount(identifier).catch((err: unknown) => {
              console.error(
                '[concealRegistration] onExistingAccount error:',
                err instanceof Error ? err.message : String(err),
              );
            });
          }
          return c.json({ message: CONCEALED_REGISTER_MESSAGE }, 200);
        }
        const breachConfig = getConfig().breachedPassword;
        if (breachConfig) {
          const { breached } = await checkBreachedPassword(
            body.password,
            breachConfig,
            undefined,
            runtime.eventBus,
          );
          if (breached && breachConfig.block !== false) {
            throw new HttpError(
              400,
              'This password has appeared in a data breach. Please choose a different password.',
              'BREACHED_PASSWORD',
            );
          }
        }
        const metadata = {
          ipAddress: ip !== 'unknown' ? ip : undefined,
          userAgent: c.req.header('user-agent') ?? undefined,
        };
        await AuthService.register(identifier, body.password, runtime, {
          metadata,
          skipSession: true,
          hookContext: hookCtx(c),
        });
        return c.json({ message: CONCEALED_REGISTER_MESSAGE }, 200);
      },
    );
  } else {
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/register',
        summary: 'Register a new account',
        description:
          'Creates a new user account and returns a JWT session token. The token is also set as an HttpOnly session cookie unless required email verification defers session issuance. Rate-limited by IP.',
        tags,
        request: {
          body: {
            content: { 'application/json': { schema: RegisterSchema } },
            description: 'Registration credentials.',
          },
        },
        responses: {
          201: {
            content: { 'application/json': { schema: TokenResponse } },
            description:
              'Account created. Returns a session token unless required email verification defers login until verification completes.',
          },
          400: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Validation error (e.g. missing field, password too short).',
          },
          409: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: alreadyRegisteredMsg,
          },
          429: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Too many registration attempts from this IP. Try again later.',
          },
        },
      }),
      async c => {
        const ip = getClientIp(c);
        if (await runtime.rateLimit.trackAttempt(`register:${ip}`, registerOpts)) {
          eventBus.emit('security.rate_limit.exceeded', { meta: { path: c.req.path } });
          return errorResponse(c, 'Too many registration attempts. Try again later.', 429);
        }
        const body = c.req.valid('json');
        const identifier = body[primaryField];

        const breachConfig = getConfig().breachedPassword;
        if (breachConfig) {
          const { breached } = await checkBreachedPassword(
            body.password,
            breachConfig,
            undefined,
            runtime.eventBus,
          );
          if (breached && breachConfig.block !== false) {
            throw new HttpError(
              400,
              'This password has appeared in a data breach. Please choose a different password.',
              'BREACHED_PASSWORD',
            );
          }
        }
        const metadata = {
          ipAddress: ip !== 'unknown' ? ip : undefined,
          userAgent: c.req.header('user-agent') ?? undefined,
        };
        const result = await AuthService.register(identifier, body.password, runtime, {
          metadata,
          hookContext: hookCtx(c),
        });
        if (result.token) {
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
        return c.json(result, 201);
      },
    );
  }

  // verify-and-login — only mounted when concealRegistration is configured
  // Consumes an email verification token and creates a session (login) in one step.
  if (concealRegistration) {
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/verify-and-login',
        summary: 'Verify email and create session',
        description:
          'Consumes a single-use email verification token, marks the account as verified, and issues a session token. Only available when concealRegistration is configured. Rate-limited by IP.',
        tags,
        request: {
          body: {
            content: {
              'application/json': {
                schema: z.object({
                  token: z.string().describe('Single-use verification token received via email.'),
                }),
              },
            },
            description: 'Verification token.',
          },
        },
        responses: {
          200: {
            content: { 'application/json': { schema: TokenResponse } },
            description: 'Email verified and session created. Returns a session token.',
          },
          400: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Invalid or expired verification token.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Account suspended.',
          },
          429: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Too many verification attempts from this IP. Try again later.',
          },
        },
      }),
      async c => {
        const ip = getClientIp(c);
        if (await runtime.rateLimit.trackAttempt(`verify:${ip}`, verifyOpts)) {
          return errorResponse(c, 'Too many verification attempts. Try again later.', 429);
        }
        const { token } = c.req.valid('json');
        const entry = await consumeVerificationToken(runtime.repos.verificationToken, token);
        if (!entry) return errorResponse(c, 'Invalid or expired verification token', 400);
        if (adapter.setEmailVerified) await adapter.setEmailVerified(entry.userId, true);
        publishAuthEvent(
          runtime.events,
          'auth:email.verified',
          { userId: entry.userId, email: entry.email },
          { userId: entry.userId, actorId: entry.userId, requestTenantId: getRequestTenantId(c) },
        );
        const { getSuspended } = await import('@auth/lib/suspension');
        const suspensionStatus = await getSuspended(adapter, entry.userId);
        if (suspensionStatus.suspended) {
          eventBus.emit('security.auth.login.blocked', {
            userId: entry.userId,
            reason: 'suspended',
            meta: { reason: 'suspended' },
          });
          return errorResponse(c, 'Account suspended', 403);
        }
        await runPreLoginHook(entry.email, runtime, hookCtx(c));
        const metadata = {
          ipAddress: ip !== 'unknown' ? ip : undefined,
          userAgent: c.req.header('user-agent') ?? undefined,
        };
        const { createSessionForUser } = await import('@auth/services/auth');
        const {
          token: sessionToken,
          refreshToken,
          sessionId,
        } = await createSessionForUser(entry.userId, runtime, metadata, hookCtx(c));
        setAuthCookie(
          c,
          COOKIE_TOKEN,
          sessionToken,
          isProd(),
          runtime.config,
          refreshTokens ? (getConfig().refreshToken?.accessTokenExpiry ?? 900) : undefined,
        );
        if (refreshToken) {
          setAuthCookie(
            c,
            COOKIE_REFRESH_TOKEN,
            refreshToken,
            isProd(),
            runtime.config,
            getConfig().refreshToken?.refreshTokenExpiry ?? 2_592_000,
          );
        }
        if (getConfig().csrfEnabled) refreshCsrfToken(c);

        emitLoginSuccess(entry.userId, sessionId, runtime);

        const result = {
          token: sessionToken,
          userId: entry.userId,
          email: entry.email,
          emailVerified: true,
          refreshToken,
        };
        return c.json(result, 200);
      },
    );
  }

  return router;
};
