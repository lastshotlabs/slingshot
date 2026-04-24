import { setAuthCookie } from '@auth/lib/cookieOptions';
import { isProd } from '@auth/lib/env';
import { consumeMfaChallenge, replaceMfaChallengeOtp } from '@auth/lib/mfaChallenge';
import { getSuspended } from '@auth/lib/suspension';
import { refreshCsrfToken } from '@auth/middleware/csrf';
import { userAuth } from '@auth/middleware/userAuth';
import { ErrorResponse } from '@auth/schemas/error';
import { SuccessResponse } from '@auth/schemas/success';
import * as AuthService from '@auth/services/auth';
import { emitLoginSuccess } from '@auth/services/auth';
import * as MfaService from '@auth/services/mfa';
import type { Context } from 'hono';
import { z } from 'zod';
import { createRoute, errorResponse, withSecurity } from '@lastshotlabs/slingshot-core';
import {
  COOKIE_REFRESH_TOKEN,
  COOKIE_TOKEN,
  HttpError,
  createRouter,
  getActor,
  getActorId,
} from '@lastshotlabs/slingshot-core';
import { getClientIp } from '@lastshotlabs/slingshot-core';
import type { HookContext } from '../config/authConfig';
import type { AuthRateLimitConfig } from '../config/authConfig';
import { publishAuthEvent } from '../eventGovernance';
import type { AuthRuntimeContext } from '../runtime';

const hookCtx = (c: Context): HookContext => ({
  ip: getClientIp(c) !== 'unknown' ? getClientIp(c) : undefined,
  userAgent: c.req.header('user-agent') ?? undefined,
  requestId: c.get('requestId') as string | undefined,
});

const tags = ['MFA'];

const RecoveryCodesSuccessResponse = SuccessResponse.extend({
  recoveryCodes: z.array(z.string()).describe('One-time recovery codes. Store these securely.'),
});

const SetupTokenSuccessResponse = SuccessResponse.extend({
  setupToken: z.string().describe('Setup challenge token for the follow-up verification request.'),
});

const WebAuthnRegistrationSuccessResponse = SuccessResponse.extend({
  credentialId: z.string(),
  recoveryCodes: z
    .array(z.string())
    .nullable()
    .describe('Recovery codes returned when WebAuthn registration completes.'),
});

export interface MfaRouterOptions {
  rateLimit?: AuthRateLimitConfig;
}

/**
 * Creates the MFA management and verification router.
 *
 * Mounted routes:
 * - `POST /auth/mfa/setup`                   — Initiate TOTP setup; returns the secret and
 *                                              an `otpauth://` URI for QR-code scanning.
 * - `POST /auth/mfa/verify-setup`            — Confirm TOTP setup with a 6-digit code and
 *                                              receive one-time recovery codes.
 * - `POST /auth/mfa/verify`                  — Complete MFA login after password auth using
 *                                              a TOTP code, email OTP, recovery code, or
 *                                              WebAuthn assertion.
 * - `GET  /auth/mfa/methods`                 — List the MFA methods currently enabled for
 *                                              the authenticated user.
 * - `POST /auth/mfa/recovery-codes`          — Regenerate recovery codes (requires factor
 *                                              verification).
 * - `DELETE /auth/mfa`                       — Disable MFA entirely (requires factor
 *                                              verification).
 * - `POST /auth/mfa/email-otp/enable`        — Enable email OTP as an MFA method.
 * - `POST /auth/mfa/email-otp/verify-setup`  — Confirm email OTP setup with the code sent
 *                                              to the user's inbox.
 * - `POST /auth/mfa/email-otp`               — Initiate an email OTP challenge during the
 *                                              MFA-verify flow.
 * - `POST /auth/mfa/webauthn/register`       — Begin WebAuthn (FIDO2) credential registration.
 * - `POST /auth/mfa/webauthn/verify-register`— Complete WebAuthn credential registration.
 * - `DELETE /auth/mfa/webauthn/:credentialId`— Remove a specific WebAuthn credential.
 *
 * @param options - Router configuration.
 * @param options.rateLimit - Per-endpoint rate-limit overrides (`mfaVerify`, `mfaEmailOtpInitiate`,
 *   `mfaResend`, `mfaDisable` windows and max counts).
 * @param runtime - The auth runtime context (adapter, event bus, repos, rate limiter, etc.).
 * @returns A Hono router with all MFA routes mounted.
 *
 * @throws {HttpError} 400 — MFA setup not initiated, or invalid request body.
 * @throws {HttpError} 401 — Invalid code, invalid factor, or no active session.
 * @throws {HttpError} 429 — Rate limit exceeded on verify, resend, or disable endpoints.
 * @throws {HttpError} 501 — Auth adapter does not support MFA operations.
 *
 * @remarks
 * **Authentication requirements and token types**:
 *
 * Routes that require an active session (`sessionToken` via `userAuth` middleware):
 * - `POST /auth/mfa/setup` — begins TOTP setup for an already-logged-in user
 * - `POST /auth/mfa/verify-setup` — confirms TOTP setup
 * - `GET  /auth/mfa/methods` — lists enrolled methods
 * - `POST /auth/mfa/recovery-codes` — regenerates recovery codes
 * - `DELETE /auth/mfa` — disables MFA
 * - `POST /auth/mfa/email-otp/enable` — enables email OTP as a method
 * - `POST /auth/mfa/email-otp/verify-setup` — confirms email OTP setup
 * - `POST /auth/mfa/webauthn/register` — begins WebAuthn credential registration
 * - `POST /auth/mfa/webauthn/verify-register` — completes WebAuthn registration
 * - `DELETE /auth/mfa/webauthn/:credentialId` — removes a WebAuthn credential
 *
 * Routes that use the `mfaToken` (unauthenticated — mid-login challenge flow):
 * - `POST /auth/mfa/verify` — completes MFA login; accepts `mfaToken` (from login
 *   response body) plus the second-factor code. On success returns a full `sessionToken`
 *   and sets the `slingshot_token` cookie. The `mfaToken` is a one-time opaque token (not
 *   a JWT) that identifies the pending challenge — it cannot be used for authenticated
 *   API requests.
 * - `POST /auth/mfa/email-otp` — initiates (or resends) an email OTP during the MFA
 *   verify flow; accepts `mfaToken` in the request body.
 *
 * Session-bound MFA mutation routes that weaken or rotate the account's MFA posture
 * fail closed with `403` when the account is suspended or now requires email verification.
 *
 * @example
 * const router = createMfaRouter(
 *   { rateLimit: { mfaVerify: { max: 5, windowMs: 15 * 60 * 1000 } } },
 *   runtime,
 * );
 * app.route('/', router);
 */
export const createMfaRouter = (
  { rateLimit }: MfaRouterOptions = {},
  runtime: AuthRuntimeContext,
) => {
  const { adapter, eventBus } = runtime;
  const getConfig = () => runtime.config;
  const router = createRouter();

  // Resolve MFA rate limits with defaults
  const mfaVerifyOpts = {
    windowMs: rateLimit?.mfaVerify?.windowMs ?? 15 * 60 * 1000,
    max: rateLimit?.mfaVerify?.max ?? 10,
  };
  const mfaEmailOtpInitiateOpts = {
    windowMs: rateLimit?.mfaEmailOtpInitiate?.windowMs ?? 15 * 60 * 1000,
    max: rateLimit?.mfaEmailOtpInitiate?.max ?? 3,
  };
  const mfaResendOpts = {
    windowMs: rateLimit?.mfaResend?.windowMs ?? 60 * 1000,
    max: rateLimit?.mfaResend?.max ?? 5,
  };
  const mfaDisableOpts = {
    windowMs: rateLimit?.mfaDisable?.windowMs ?? 15 * 60 * 1000,
    max: rateLimit?.mfaDisable?.max ?? 5,
  };

  const assertSensitiveMfaMutationAllowed = async (c: Context, userId: string) => {
    const suspensionStatus = await getSuspended(adapter, userId);
    if (suspensionStatus.suspended) {
      eventBus.emit('security.auth.login.blocked', {
        userId,
        reason: 'suspended',
        meta: { reason: 'suspended' },
      });
      return errorResponse(c, 'Account suspended', 403);
    }
    try {
      await AuthService.assertLoginEmailVerified(userId, runtime);
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        return errorResponse(c, err.message, 403);
      }
      throw err;
    }
    return null;
  };

  // All MFA setup/management routes require auth
  router.use('/auth/mfa/setup', userAuth);
  router.use('/auth/mfa/verify-setup', userAuth);
  router.use('/auth/mfa', userAuth);
  router.use('/auth/mfa/recovery-codes', userAuth);
  router.use('/auth/mfa/email-otp/enable', userAuth);
  router.use('/auth/mfa/email-otp/verify-setup', userAuth);
  router.use('/auth/mfa/email-otp', userAuth);
  router.use('/auth/mfa/methods', userAuth);

  // ─── Setup ────────────────────────────────────────────────────────────────

  router.openapi(
    withSecurity(
      createRoute({
        method: 'post',
        path: '/auth/mfa/setup',
        summary: 'Initiate MFA setup',
        description:
          'Generates a TOTP secret and returns the otpauth URI for QR code scanning. The user must confirm setup by verifying a code via POST /auth/mfa/verify-setup.',
        tags,
        responses: {
          200: {
            content: {
              'application/json': {
                schema: z.object({
                  secret: z.string().describe('Base32-encoded TOTP secret.'),
                  uri: z.string().describe('otpauth:// URI for QR code generation.'),
                }),
              },
            },
            description: 'TOTP secret generated. Scan the QR code with an authenticator app.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'No valid session.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Account is suspended or must verify its email before MFA setup can begin.',
          },
          429: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Too many MFA setup attempts. Try again later.',
          },
          501: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Auth adapter does not support MFA.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const userId = getActorId(c);
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const blocked = await assertSensitiveMfaMutationAllowed(c, userId);
      if (blocked) return blocked;
      if (
        await runtime.rateLimit.trackAttempt(`mfa-setup:${userId}`, {
          windowMs: 15 * 60 * 1000,
          max: 5,
        })
      ) {
        return errorResponse(c, 'Too many MFA setup attempts. Try again later.', 429);
      }
      const result = await MfaService.setupMfa(userId, runtime);
      return c.json(result, 200);
    },
  );

  // ─── Verify Setup ─────────────────────────────────────────────────────────

  router.openapi(
    withSecurity(
      createRoute({
        method: 'post',
        path: '/auth/mfa/verify-setup',
        summary: 'Confirm MFA setup',
        description:
          'Verifies a TOTP code from the authenticator app and enables MFA. Returns one-time recovery codes that should be stored securely. If email OTP was previously enabled, recovery codes are regenerated.',
        tags,
        request: {
          body: {
            content: {
              'application/json': {
                schema: z.object({
                  code: z
                    .string()
                    .length(6)
                    .describe('6-digit TOTP code from the authenticator app.'),
                }),
              },
            },
          },
        },
        responses: {
          200: {
            content: {
              'application/json': {
                schema: RecoveryCodesSuccessResponse.extend({
                  recoveryCodes: z
                    .array(z.string())
                    .describe(
                      'One-time recovery codes. Store these securely — they cannot be shown again.',
                    ),
                }),
              },
            },
            description: 'MFA enabled successfully.',
          },
          400: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'MFA setup not initiated.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Invalid TOTP code or no valid session.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Account is suspended or must verify its email before MFA setup can be completed.',
          },
          501: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Auth adapter does not support MFA.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const userId = getActorId(c);
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const blocked = await assertSensitiveMfaMutationAllowed(c, userId);
      if (blocked) return blocked;
      const { code } = c.req.valid('json');
      const recoveryCodes = await MfaService.verifySetup(userId, code, runtime);
      eventBus.emit('security.auth.mfa.setup', { userId });
      publishAuthEvent(
        runtime.events,
        'auth:mfa.enabled',
        { userId, method: 'totp' },
        {
          userId,
          actorId: userId,
        },
      );
      return c.json({ ok: true as const, recoveryCodes }, 200);
    },
  );

  // ─── Verify (complete login after password) ───────────────────────────────

  const MfaLoginResponse = z
    .object({
      token: z.string().describe('JWT session token.'),
      userId: z.string().describe('Unique user ID.'),
      refreshToken: z.string().optional().describe('Refresh token (when configured).'),
    })
    .openapi('MfaLoginResponse');

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/mfa/verify',
      summary: 'Complete MFA login',
      description:
        "Completes login by verifying a TOTP code, email OTP code, recovery code, or WebAuthn assertion after password authentication. Requires the mfaToken returned from the login endpoint. Optionally specify 'method' to target a specific verification method.",
      tags,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                mfaToken: z.string().describe('MFA challenge token from the login response.'),
                code: z
                  .string()
                  .optional()
                  .describe(
                    '6-digit TOTP/email OTP code or 8-character recovery code. Required unless using WebAuthn.',
                  ),
                method: z
                  .enum(['totp', 'emailOtp', 'webauthn'])
                  .optional()
                  .describe(
                    'Specify which MFA method to verify. If omitted, methods are tried automatically.',
                  ),
                webauthnResponse: z
                  .record(z.string(), z.unknown())
                  .optional()
                  .describe(
                    'WebAuthn authentication response from navigator.credentials.get(). Pass the entire response object.',
                  ),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: MfaLoginResponse } },
          description: 'MFA verified. Session created.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description:
            'MFA verified but session issuance is blocked because the account is suspended or email verification is required.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Invalid or expired MFA token, or invalid code.',
        },
        429: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Too many MFA verification attempts. Try again later.',
        },
      },
    }),
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`mfa-verify:${ip}`, mfaVerifyOpts)) {
        return errorResponse(c, 'Too many MFA verification attempts. Try again later.', 429);
      }

      const { mfaToken, code, method, webauthnResponse } = c.req.valid('json');

      if (!code && !webauthnResponse) {
        return errorResponse(c, "Either 'code' or 'webauthnResponse' is required", 401);
      }

      const challenge = await consumeMfaChallenge(runtime.repos.mfaChallenge, mfaToken);
      if (!challenge) return errorResponse(c, 'Invalid or expired MFA token', 401);

      const { userId, emailOtpHash, webauthnChallenge } = challenge;
      let valid = false;

      if (method === 'webauthn' || (!method && webauthnResponse)) {
        // WebAuthn verification
        if (webauthnResponse && webauthnChallenge) {
          valid = await MfaService.verifyWebAuthn(
            userId,
            webauthnResponse as unknown as import('@simplewebauthn/server').AuthenticationResponseJSON,
            webauthnChallenge,
            runtime,
          );
        }
      } else if (method === 'totp') {
        // Only try TOTP
        if (code) valid = await MfaService.verifyTotp(userId, code, runtime);
      } else if (method === 'emailOtp') {
        // Only try email OTP
        if (code && emailOtpHash) valid = MfaService.verifyEmailOtp(emailOtpHash, code);
      } else if (code) {
        // Auto-detect: use emailOtpHash presence to pick order
        if (emailOtpHash) {
          // Email OTP first, then TOTP, then recovery
          valid = MfaService.verifyEmailOtp(emailOtpHash, code);
          if (!valid) valid = await MfaService.verifyTotp(userId, code, runtime);
        } else {
          // TOTP first
          valid = await MfaService.verifyTotp(userId, code, runtime);
        }
      }

      // Always try recovery code as fallback (code-based only)
      if (!valid && code) {
        valid = await MfaService.verifyRecoveryCode(userId, code, runtime);
      }

      if (!valid) {
        eventBus.emit('security.auth.mfa.verify.failure', {});
        return errorResponse(c, 'Invalid MFA code', 401);
      }

      const { getSuspended } = await import('@auth/lib/suspension');
      const suspensionStatus = await getSuspended(adapter, userId);
      if (suspensionStatus.suspended) {
        eventBus.emit('security.auth.login.blocked', {
          userId,
          reason: 'suspended',
          meta: { reason: 'suspended' },
        });
        return errorResponse(c, 'Account suspended', 403);
      }
      await AuthService.assertLoginEmailVerified(userId, runtime);

      // Create session — reuse the service helper for refresh token support
      const result = await AuthService.createSessionForUser(
        userId,
        runtime,
        {
          ipAddress: getClientIp(c),
          userAgent: c.req.header('user-agent') ?? undefined,
        },
        hookCtx(c),
      );

      // Mark MFA as verified on the new session so step-up is satisfied immediately.
      // If this fails, clean up the orphaned session so the client can retry cleanly.
      try {
        await runtime.repos.session.setMfaVerifiedAt(result.sessionId);
      } catch (err) {
        await runtime.repos.session.deleteSession(result.sessionId, runtime.config).catch(() => {}); // intentional: inline because we re-throw immediately
        throw err;
      }

      const rtConfig = getConfig().refreshToken;
      setAuthCookie(
        c,
        COOKIE_TOKEN,
        result.token,
        isProd(),
        runtime.config,
        rtConfig ? (rtConfig.accessTokenExpiry ?? 900) : undefined,
      );
      if (result.refreshToken) {
        setAuthCookie(
          c,
          COOKIE_REFRESH_TOKEN,
          result.refreshToken,
          isProd(),
          runtime.config,
          rtConfig?.refreshTokenExpiry ?? 2_592_000,
        );
      }
      if (getConfig().csrfEnabled) refreshCsrfToken(c);

      eventBus.emit('security.auth.mfa.verify.success', {});
      emitLoginSuccess(userId, result.sessionId, runtime);
      return c.json({ token: result.token, userId, refreshToken: result.refreshToken }, 200);
    },
  );

  // ─── Disable MFA ──────────────────────────────────────────────────────────

  const disableMfaSchema = z.object({
    method: z
      .enum(['totp', 'emailOtp', 'webauthn', 'password', 'recovery'])
      .optional()
      .describe(
        'Verification method. Inferred from provided credentials when omitted (code→totp, password→password).',
      ),
    code: z.string().optional().describe('TOTP code, email OTP code, or recovery code.'),
    password: z.string().optional().describe("Account password (for method: 'password')."),
    reauthToken: z
      .string()
      .optional()
      .describe('Reauth challenge token (for emailOtp and webauthn methods).'),
    webauthnResponse: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('WebAuthn authentication response.'),
  });

  router.openapi(
    withSecurity(
      createRoute({
        method: 'delete',
        path: '/auth/mfa',
        summary: 'Disable MFA',
        description:
          'Disables MFA for the authenticated user. Requires identity verification via TOTP, email OTP, WebAuthn, password, or recovery code.',
        tags,
        request: {
          body: {
            content: {
              'application/json': {
                schema: disableMfaSchema,
              },
            },
          },
        },
        responses: {
          200: {
            content: { 'application/json': { schema: SuccessResponse } },
            description: 'MFA disabled.',
          },
          400: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Missing required verification.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Invalid verification or no valid session.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Account is suspended or must verify its email before MFA can be disabled.',
          },
          429: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Too many MFA disable attempts. Try again later.',
          },
          501: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Auth adapter does not support MFA.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const userId = getActorId(c);
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const sessionId = getActor(c).sessionId;
      if (!sessionId) return errorResponse(c, 'Unauthorized', 401);
      const body = c.req.valid('json');

      if (await runtime.rateLimit.trackAttempt(`mfa-disable:${userId}`, mfaDisableOpts)) {
        eventBus.emit('security.rate_limit.exceeded', { meta: { path: c.req.path } });
        return errorResponse(c, 'Too many MFA disable attempts. Try again later.', 429);
      }
      const blocked = await assertSensitiveMfaMutationAllowed(c, userId);
      if (blocked) return blocked;

      // Infer method from provided credentials when not specified
      const method = body.method ?? (body.password ? 'password' : body.code ? 'totp' : undefined);
      if (!method) {
        throw new HttpError(
          400,
          'Verification is required to disable MFA. Provide method and credentials.',
        );
      }
      const valid = await MfaService.verifyAnyFactor(userId, sessionId, runtime, {
        method,
        code: body.code,
        password: body.password,
        reauthToken: body.reauthToken,
        webauthnResponse: body.webauthnResponse as object | undefined,
      });
      if (!valid) {
        throw new HttpError(401, 'Invalid verification');
      }

      if (!adapter.setMfaEnabled || !adapter.setMfaSecret || !adapter.setRecoveryCodes) {
        throw new HttpError(501, 'Auth adapter does not support MFA');
      }
      await adapter.setMfaEnabled(userId, false);
      await adapter.setMfaSecret(userId, null);
      await adapter.setRecoveryCodes(userId, []);
      if (adapter.setMfaMethods) {
        await adapter.setMfaMethods(userId, []);
      }
      publishAuthEvent(
        runtime.events,
        'auth:mfa.disabled',
        { userId },
        {
          userId,
          actorId: userId,
        },
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  // ─── Regenerate Recovery Codes ────────────────────────────────────────────

  router.openapi(
    withSecurity(
      createRoute({
        method: 'post',
        path: '/auth/mfa/recovery-codes',
        summary: 'Regenerate recovery codes',
        description:
          'Generates new recovery codes, invalidating all previous ones. Requires a valid TOTP code to confirm.',
        tags,
        request: {
          body: {
            content: {
              'application/json': {
                schema: z.object({
                  code: z.string().length(6).describe('6-digit TOTP code to confirm regeneration.'),
                }),
              },
            },
          },
        },
        responses: {
          200: {
            content: {
              'application/json': {
                schema: z.object({
                  recoveryCodes: z.array(z.string()).describe('New one-time recovery codes.'),
                }),
              },
            },
            description: 'New recovery codes generated.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Invalid TOTP code or no valid session.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Account is suspended or must verify its email before recovery codes can be rotated.',
          },
          501: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Auth adapter does not support MFA.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const userId = getActorId(c);
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const blocked = await assertSensitiveMfaMutationAllowed(c, userId);
      if (blocked) return blocked;
      const { code } = c.req.valid('json');
      const recoveryCodes = await MfaService.regenerateRecoveryCodes(userId, code, runtime);
      return c.json({ recoveryCodes }, 200);
    },
  );

  // ─── Email OTP: Enable (initiate) ────────────────────────────────────────

  router.openapi(
    withSecurity(
      createRoute({
        method: 'post',
        path: '/auth/mfa/email-otp/enable',
        summary: 'Initiate email OTP setup',
        description:
          "Sends a verification code to the user's email to confirm email OTP setup. Confirm via POST /auth/mfa/email-otp/verify-setup.",
        tags,
        responses: {
          200: {
            content: {
              'application/json': {
                schema: SetupTokenSuccessResponse,
              },
            },
            description: 'Verification code sent to email.',
          },
          400: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'No email address on account.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'No valid session.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Account is suspended or must verify its email before email OTP setup can begin.',
          },
          429: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Too many initiation attempts. Try again later.',
          },
          501: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Email OTP is not configured.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const userId = getActorId(c);
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const blocked = await assertSensitiveMfaMutationAllowed(c, userId);
      if (blocked) return blocked;
      if (
        await runtime.rateLimit.trackAttempt(
          `mfa-email-otp-initiate:${userId}`,
          mfaEmailOtpInitiateOpts,
        )
      ) {
        return errorResponse(c, 'Too many initiation attempts. Try again later.', 429);
      }
      const setupToken = await MfaService.initiateEmailOtp(userId, runtime);
      return c.json({ ok: true as const, setupToken }, 200);
    },
  );

  // ─── Email OTP: Verify Setup ─────────────────────────────────────────────

  router.openapi(
    withSecurity(
      createRoute({
        method: 'post',
        path: '/auth/mfa/email-otp/verify-setup',
        summary: 'Confirm email OTP setup',
        description:
          'Verifies the code sent during email OTP initiation and enables email OTP as an MFA method. Returns recovery codes (new or regenerated if another MFA method was already active).',
        tags,
        request: {
          body: {
            content: {
              'application/json': {
                schema: z.object({
                  setupToken: z
                    .string()
                    .describe('Setup challenge token from POST /auth/mfa/email-otp/enable.'),
                  code: z.string().describe('Verification code sent to email.'),
                }),
              },
            },
          },
        },
        responses: {
          200: {
            content: {
              'application/json': {
                schema: SuccessResponse.extend({
                  recoveryCodes: z
                    .array(z.string())
                    .optional()
                    .describe('Recovery codes (always returned when email OTP is enabled).'),
                }),
              },
            },
            description: 'Email OTP enabled.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Invalid setup token or code.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Account is suspended or must verify its email before email OTP setup can be completed.',
          },
          501: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Auth adapter does not support MFA.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const userId = getActorId(c);
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const blocked = await assertSensitiveMfaMutationAllowed(c, userId);
      if (blocked) return blocked;
      const { setupToken, code } = c.req.valid('json');
      const recoveryCodes = await MfaService.confirmEmailOtp(userId, setupToken, code, runtime);
      eventBus.emit('security.auth.mfa.setup', { userId });
      publishAuthEvent(
        runtime.events,
        'auth:mfa.enabled',
        { userId, method: 'email-otp' },
        {
          userId,
          actorId: userId,
        },
      );
      return c.json({ ok: true as const, recoveryCodes: recoveryCodes ?? undefined }, 200);
    },
  );

  // ─── Email OTP: Disable ──────────────────────────────────────────────────

  router.openapi(
    withSecurity(
      createRoute({
        method: 'delete',
        path: '/auth/mfa/email-otp',
        summary: 'Disable email OTP',
        description:
          'Disables email OTP for the authenticated user. Requires identity verification via TOTP, email OTP, WebAuthn, password, or recovery code.',
        tags,
        request: {
          body: {
            content: {
              'application/json': {
                schema: disableMfaSchema,
              },
            },
          },
        },
        responses: {
          200: {
            content: { 'application/json': { schema: SuccessResponse } },
            description: 'Email OTP disabled.',
          },
          400: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Missing required verification.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Invalid credentials or no valid session.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Account is suspended or must verify its email before email OTP can be disabled.',
          },
          501: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Auth adapter does not support MFA.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const userId = getActorId(c);
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const sessionId = getActor(c).sessionId;
      if (!sessionId) return errorResponse(c, 'Unauthorized', 401);
      const body = c.req.valid('json');
      const blocked = await assertSensitiveMfaMutationAllowed(c, userId);
      if (blocked) return blocked;

      const method = body.method ?? (body.password ? 'password' : body.code ? 'totp' : undefined);
      if (!method) {
        throw new HttpError(400, 'Verification is required. Provide method and credentials.');
      }
      const valid = await MfaService.verifyAnyFactor(userId, sessionId, runtime, {
        method,
        code: body.code,
        password: body.password,
        reauthToken: body.reauthToken,
        webauthnResponse: body.webauthnResponse as object | undefined,
      });
      if (!valid) {
        throw new HttpError(401, 'Invalid verification');
      }

      // Remove "emailOtp" from methods
      if (!adapter.setMfaEnabled) return errorResponse(c, 'Auth adapter does not support MFA', 501);
      const methods = adapter.getMfaMethods ? await adapter.getMfaMethods(userId) : [];
      if (adapter.setMfaMethods) {
        const updated = methods.filter(m => m !== 'emailOtp');
        await adapter.setMfaMethods(userId, updated);
        if (updated.length === 0) {
          await adapter.setMfaEnabled(userId, false);
          if (adapter.setRecoveryCodes) await adapter.setRecoveryCodes(userId, []);
        }
      }
      publishAuthEvent(
        runtime.events,
        'auth:mfa.disabled',
        { userId, method: 'email-otp' },
        {
          userId,
          actorId: userId,
        },
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  // ─── Resend Email OTP ────────────────────────────────────────────────────

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/mfa/resend',
      summary: 'Resend email OTP code',
      description:
        'Generates and sends a new email OTP code for the given MFA challenge. Rate-limited to 3 resends per challenge. Does not extend the challenge beyond 3x the original TTL.',
      tags,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                mfaToken: z.string().describe('MFA challenge token from the login response.'),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: SuccessResponse } },
          description: 'Code sent.',
        },
        400: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Email OTP not configured.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Invalid or expired MFA token.',
        },
        429: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Maximum resends reached.',
        },
      },
    }),
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`mfa-resend:${ip}`, mfaResendOpts)) {
        return errorResponse(c, 'Too many resend attempts. Try again later.', 429);
      }

      const { mfaToken } = c.req.valid('json');
      const emailOtpConfig = getConfig().mfa?.emailOtp ?? null;
      if (!emailOtpConfig) return errorResponse(c, 'Email OTP is not configured', 400);

      const { code, hash } = MfaService.generateEmailOtpCode(runtime);
      const result = await replaceMfaChallengeOtp(
        runtime.repos.mfaChallenge,
        mfaToken,
        hash,
        runtime.config,
      );
      if (!result)
        return errorResponse(c, 'Invalid/expired MFA token or maximum resends reached', 401);

      // Get user email and send
      const user = adapter.getUser ? await adapter.getUser(result.userId) : null;
      if (user?.email) {
        publishAuthEvent(runtime.events, 'auth:delivery.email_otp', { email: user.email, code });
      }

      return c.json({ ok: true as const }, 200);
    },
  );

  // ─── Get MFA Methods ────────────────────────────────────────────────────

  router.openapi(
    withSecurity(
      createRoute({
        method: 'get',
        path: '/auth/mfa/methods',
        summary: 'Get enabled MFA methods',
        description: 'Returns the MFA methods currently enabled for the authenticated user.',
        tags,
        responses: {
          200: {
            content: {
              'application/json': {
                schema: z.object({
                  methods: z
                    .array(z.string())
                    .describe("Enabled MFA methods (e.g., 'totp', 'emailOtp')."),
                }),
              },
            },
            description: 'Enabled MFA methods.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'No valid session.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const userId = getActorId(c);
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const methods = await MfaService.getMfaMethods(userId, runtime);
      return c.json({ methods }, 200);
    },
  );

  // ─── WebAuthn / Security Keys ─────────────────────────────────────────────

  if (getConfig().mfa?.webauthn) {
    // Eager dependency check — fail fast at server start
    MfaService.assertWebAuthnDependency().catch((err: unknown) => {
      throw err;
    });

    router.use('/auth/mfa/webauthn/*', userAuth);

    // Register options
    router.openapi(
      withSecurity(
        createRoute({
          method: 'post',
          path: '/auth/mfa/webauthn/register-options',
          summary: 'Generate WebAuthn registration options',
          description:
            'Generates registration options for the client to pass to navigator.credentials.create(). Returns a registrationToken to confirm registration.',
          tags,
          responses: {
            200: {
              content: {
                'application/json': {
                  schema: z.object({
                    options: z
                      .record(z.string(), z.unknown())
                      .describe(
                        'PublicKeyCredentialCreationOptions — pass directly to navigator.credentials.create().',
                      ),
                    registrationToken: z
                      .string()
                      .describe('Token to pass back when completing registration.'),
                  }),
                },
              },
              description: 'Registration options generated.',
            },
            401: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'No valid session.',
            },
            403: {
              content: { 'application/json': { schema: ErrorResponse } },
              description:
                'Account is suspended or must verify its email before WebAuthn registration can begin.',
            },
            501: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'WebAuthn not configured or adapter does not support it.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const userId = getActorId(c);
        if (!userId) return errorResponse(c, 'Unauthorized', 401);
        const blocked = await assertSensitiveMfaMutationAllowed(c, userId);
        if (blocked) return blocked;
        const result = await MfaService.initiateWebAuthnRegistration(userId, runtime);
        return c.json(result, 200);
      },
    );

    // Complete registration
    router.openapi(
      withSecurity(
        createRoute({
          method: 'post',
          path: '/auth/mfa/webauthn/register',
          summary: 'Complete WebAuthn registration',
          description:
            'Verifies the attestation response from navigator.credentials.create() and stores the credential. Returns recovery codes.',
          tags,
          request: {
            body: {
              content: {
                'application/json': {
                  schema: z.object({
                    registrationToken: z
                      .string()
                      .describe('Token from POST /auth/mfa/webauthn/register-options.'),
                    attestationResponse: z
                      .record(z.string(), z.unknown())
                      .describe('Full response from navigator.credentials.create().'),
                    name: z
                      .string()
                      .optional()
                      .describe("User-friendly name for the key (e.g. 'YubiKey 5')."),
                  }),
                },
              },
            },
          },
          responses: {
            200: {
              content: {
                'application/json': {
                  schema: WebAuthnRegistrationSuccessResponse,
                },
              },
              description: 'Security key registered.',
            },
            401: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'Invalid registration token or verification failed.',
            },
            403: {
              content: { 'application/json': { schema: ErrorResponse } },
              description:
                'Account is suspended or must verify its email before WebAuthn registration can be completed.',
            },
            409: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'Security key already registered to another account.',
            },
            501: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'WebAuthn not configured or adapter does not support it.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const userId = getActorId(c);
        if (!userId) return errorResponse(c, 'Unauthorized', 401);
        const blocked = await assertSensitiveMfaMutationAllowed(c, userId);
        if (blocked) return blocked;
        const { registrationToken, attestationResponse, name } = c.req.valid('json');
        const result = await MfaService.completeWebAuthnRegistration(
          userId,
          registrationToken,
          attestationResponse as unknown as import('@simplewebauthn/server').RegistrationResponseJSON,
          runtime,
          name,
        );
        eventBus.emit('security.auth.mfa.setup', { userId });
        publishAuthEvent(
          runtime.events,
          'auth:mfa.enabled',
          { userId, method: 'webauthn' },
          {
            userId,
            actorId: userId,
          },
        );
        return c.json({ ok: true as const, ...result }, 200);
      },
    );

    // List credentials
    router.openapi(
      withSecurity(
        createRoute({
          method: 'get',
          path: '/auth/mfa/webauthn/credentials',
          summary: 'List WebAuthn credentials',
          description:
            'Returns the security keys registered for the authenticated user. Does not include private key data.',
          tags,
          responses: {
            200: {
              content: {
                'application/json': {
                  schema: z.object({
                    credentials: z.array(
                      z.object({
                        credentialId: z.string(),
                        name: z.string().optional(),
                        createdAt: z.number(),
                        transports: z.array(z.string()).optional(),
                      }),
                    ),
                  }),
                },
              },
              description: 'List of registered security keys.',
            },
            401: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'No valid session.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const userId = getActorId(c);
        if (!userId) return errorResponse(c, 'Unauthorized', 401);
        const creds = adapter.getWebAuthnCredentials
          ? await adapter.getWebAuthnCredentials(userId)
          : [];
        return c.json(
          {
            credentials: creds.map(cr => ({
              credentialId: cr.credentialId,
              name: cr.name,
              createdAt: cr.createdAt,
              transports: cr.transports,
            })),
          },
          200,
        );
      },
    );

    // Remove a single credential
    router.openapi(
      withSecurity(
        createRoute({
          method: 'delete',
          path: '/auth/mfa/webauthn/credentials/{credentialId}',
          summary: 'Remove a WebAuthn credential',
          description:
            'Removes a single security key. Identity verification is only required when removing the last MFA credential.',
          tags,
          request: {
            params: z.object({ credentialId: z.string() }),
            body: {
              content: {
                'application/json': {
                  schema: z.object({
                    method: z
                      .enum(['totp', 'emailOtp', 'webauthn', 'password', 'recovery'])
                      .optional()
                      .describe(
                        'Verification method (required when removing the last MFA credential).',
                      ),
                    code: z
                      .string()
                      .optional()
                      .describe('TOTP code, email OTP code, or recovery code.'),
                    password: z
                      .string()
                      .optional()
                      .describe("Account password (for method: 'password')."),
                    reauthToken: z
                      .string()
                      .optional()
                      .describe('Reauth challenge token (for emailOtp and webauthn methods).'),
                    webauthnResponse: z
                      .record(z.string(), z.unknown())
                      .optional()
                      .describe('WebAuthn authentication response.'),
                  }),
                },
              },
            },
          },
          responses: {
            200: {
              content: { 'application/json': { schema: SuccessResponse } },
              description: 'Credential removed.',
            },
            400: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'Missing required verification.',
            },
            401: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'Invalid credentials or no valid session.',
            },
            403: {
              content: { 'application/json': { schema: ErrorResponse } },
              description:
                'Account is suspended or must verify its email before WebAuthn credentials can be removed.',
            },
            404: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'Credential not found.',
            },
            501: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'Adapter does not support WebAuthn.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const userId = getActorId(c);
        if (!userId) return errorResponse(c, 'Unauthorized', 401);
        const sessionId = getActor(c).sessionId;
        if (!sessionId) return errorResponse(c, 'Unauthorized', 401);
        const { credentialId } = c.req.valid('param');
        const { method, code, password, reauthToken, webauthnResponse } = c.req.valid('json');
        const blocked = await assertSensitiveMfaMutationAllowed(c, userId);
        if (blocked) return blocked;
        // If method is provided, pre-verify before delegating
        if (method) {
          const valid = await MfaService.verifyAnyFactor(userId, sessionId, runtime, {
            method,
            code,
            password,
            reauthToken,
            webauthnResponse: webauthnResponse as object | undefined,
          });
          if (!valid) return errorResponse(c, 'Invalid credentials', 401);
          // Delegate without re-verifying (pass empty params to skip internal verifyIdentity)
          if (!adapter.getWebAuthnCredentials || !adapter.removeWebAuthnCredential) {
            return errorResponse(c, 'Adapter does not support WebAuthn', 501);
          }
          const credentials = await adapter.getWebAuthnCredentials(userId);
          if (!credentials.some(cr => cr.credentialId === credentialId)) {
            return errorResponse(c, 'Credential not found', 404);
          }
          await adapter.removeWebAuthnCredential(userId, credentialId);
          const remaining = credentials.filter(cr => cr.credentialId !== credentialId);
          if (remaining.length === 0 && adapter.setMfaMethods) {
            const methods = adapter.getMfaMethods ? await adapter.getMfaMethods(userId) : [];
            const updated = methods.filter(m => m !== 'webauthn');
            await adapter.setMfaMethods(userId, updated);
            if (updated.length === 0 && adapter.setMfaEnabled) {
              await adapter.setMfaEnabled(userId, false);
              if (adapter.setRecoveryCodes) await adapter.setRecoveryCodes(userId, []);
            }
          }
        } else {
          // No verification needed (not removing last credential)
          await MfaService.removeWebAuthnCredential(
            userId,
            credentialId,
            { code, password },
            runtime,
          );
        }
        return c.json({ ok: true as const }, 200);
      },
    );

    // Disable WebAuthn entirely
    router.openapi(
      withSecurity(
        createRoute({
          method: 'delete',
          path: '/auth/mfa/webauthn',
          summary: 'Disable WebAuthn MFA',
          description:
            'Removes all WebAuthn credentials and disables WebAuthn as an MFA method. Requires identity verification via TOTP, email OTP, WebAuthn, password, or recovery code.',
          tags,
          request: {
            body: {
              content: {
                'application/json': {
                  schema: disableMfaSchema,
                },
              },
            },
          },
          responses: {
            200: {
              content: { 'application/json': { schema: SuccessResponse } },
              description: 'WebAuthn disabled.',
            },
            400: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'Missing required verification.',
            },
            401: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'Invalid credentials or no valid session.',
            },
            403: {
              content: { 'application/json': { schema: ErrorResponse } },
              description:
                'Account is suspended or must verify its email before WebAuthn can be disabled.',
            },
            501: {
              content: { 'application/json': { schema: ErrorResponse } },
              description: 'Adapter does not support WebAuthn.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const userId = getActorId(c);
        if (!userId) return errorResponse(c, 'Unauthorized', 401);
        const sessionId = getActor(c).sessionId;
        if (!sessionId) return errorResponse(c, 'Unauthorized', 401);
        const body = c.req.valid('json');
        const blocked = await assertSensitiveMfaMutationAllowed(c, userId);
        if (blocked) return blocked;

        const method = body.method ?? (body.password ? 'password' : body.code ? 'totp' : undefined);
        if (!method) {
          throw new HttpError(400, 'Verification is required. Provide method and credentials.');
        }
        const valid = await MfaService.verifyAnyFactor(userId, sessionId, runtime, {
          method,
          code: body.code,
          password: body.password,
          reauthToken: body.reauthToken,
          webauthnResponse: body.webauthnResponse as object | undefined,
        });
        if (!valid) {
          throw new HttpError(401, 'Invalid verification');
        }

        if (!adapter.getWebAuthnCredentials || !adapter.removeWebAuthnCredential) {
          throw new HttpError(501, 'Auth adapter does not support WebAuthn');
        }

        const credentials = await adapter.getWebAuthnCredentials(userId);
        for (const cred of credentials) {
          await adapter.removeWebAuthnCredential(userId, cred.credentialId);
        }

        // Remove "webauthn" from methods
        if (adapter.getMfaMethods && adapter.setMfaMethods) {
          const methods = await adapter.getMfaMethods(userId);
          const updated = methods.filter(m => m !== 'webauthn');
          await adapter.setMfaMethods(userId, updated);
          if (updated.length === 0 && adapter.setMfaEnabled) {
            await adapter.setMfaEnabled(userId, false);
            if (adapter.setRecoveryCodes) await adapter.setRecoveryCodes(userId, []);
          }
        }
        return c.json({ ok: true as const }, 200);
      },
    );
  }

  return router;
};
