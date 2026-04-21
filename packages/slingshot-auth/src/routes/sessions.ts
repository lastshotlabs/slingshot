import { getSuspended } from '@auth/lib/suspension';
import { userAuth } from '@auth/middleware/userAuth';
import { SessionInfoSchema } from '@auth/schemas/auth';
import { ErrorResponse } from '@auth/schemas/error';
import { SuccessResponse } from '@auth/schemas/success';
import * as AuthService from '@auth/services/auth';
import type { Context } from 'hono';
import { z } from 'zod';
import { createRoute, errorResponse, withSecurity } from '@lastshotlabs/slingshot-core';
import { createRouter, getClientIp } from '@lastshotlabs/slingshot-core';
import type { AuthRateLimitConfig } from '../config/authConfig';
import { publishAuthEvent } from '../eventGovernance';
import type { AuthRuntimeContext } from '../runtime';

export interface SessionsRouterOptions {
  rateLimit?: AuthRateLimitConfig;
}

/**
 * Creates the session management and reauth router.
 *
 * Mounted routes:
 * - `GET    /auth/sessions`              — List all sessions for the authenticated user.
 * - `DELETE /auth/sessions/:sessionId`   — Revoke a specific session by ID (own sessions
 *                                          only; useful for "sign out of other devices").
 * - `POST   /auth/reauth/challenge`      — Issue a reauth challenge token for
 *                                          challenge-based MFA methods (email OTP,
 *                                          WebAuthn). Direct methods (TOTP, password,
 *                                          recovery) do not require a challenge first.
 *
 * @param options - Router configuration.
 * @param options.rateLimit - Per-endpoint rate-limit overrides. The `mfaVerify` window is
 *   reused for the reauth challenge endpoint.
 * @param runtime - The auth runtime context (adapter, event bus, repos, rate limiter, etc.).
 * @returns A Hono router with session and reauth routes mounted.
 *
 * @throws {HttpError} 401 — No valid session.
 * @throws {HttpError} 404 — Session not found or does not belong to the authenticated user.
 * @throws {HttpError} 429 — Too many reauth challenge attempts from this IP.
 *
 * @remarks
 * All routes require an active session via the `userAuth` middleware. Users can only
 * revoke their own sessions; the `DELETE /auth/sessions/:sessionId` handler verifies
 * ownership before deleting. The `POST /auth/reauth/challenge` endpoint generates an
 * email OTP or WebAuthn challenge (or both) when those methods are enrolled, and returns
 * a `reauthToken` that must be passed to step-up, account deletion, or MFA-disable
 * endpoints. TOTP, password, and recovery-code methods are direct and never require a
 * prior challenge. Session revocation and reauth-challenge issuance both fail closed with
 * `403` when the account is suspended or when required email verification is no longer
 * satisfied.
 *
 * @example
 * const router = createSessionsRouter(
 *   { rateLimit: { mfaVerify: { max: 10, windowMs: 15 * 60 * 1000 } } },
 *   runtime,
 * );
 * app.route('/', router);
 */
export const createSessionsRouter = (
  { rateLimit }: SessionsRouterOptions,
  runtime: AuthRuntimeContext,
) => {
  const { eventBus } = runtime;
  const router = createRouter();
  const tags = ['Auth'];

  const reauthChallengeOpts = {
    windowMs: rateLimit?.mfaVerify?.windowMs ?? 15 * 60 * 1000,
    max: rateLimit?.mfaVerify?.max ?? 10,
  };

  const assertSensitiveSessionMutationAllowed = async (c: Context, userId: string) => {
    const suspensionStatus = await getSuspended(runtime.adapter, userId);
    if (suspensionStatus.suspended) {
      eventBus.emit('security.auth.login.blocked', {
        userId,
        reason: 'suspended',
        meta: { reason: 'suspended' },
      });
      return errorResponse(c, 'Account suspended', 403);
    }

    await AuthService.assertLoginEmailVerified(userId, runtime);
    return null;
  };

  router.use('/auth/sessions', userAuth);
  router.use('/auth/sessions/*', userAuth);

  router.openapi(
    withSecurity(
      createRoute({
        method: 'get',
        path: '/auth/sessions',
        summary: 'List sessions',
        description:
          'Returns all sessions for the authenticated user. Includes inactive sessions when `sessionPolicy.includeInactiveSessions` is enabled. Requires a valid session.',
        tags,
        responses: {
          200: {
            content: {
              'application/json': { schema: z.object({ sessions: z.array(SessionInfoSchema) }) },
            },
            description: 'Sessions belonging to the authenticated user.',
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
      const userId = c.get('authUserId');
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const sessions = await runtime.repos.session.getUserSessions(userId, runtime.config);
      return c.json({ sessions }, 200);
    },
  );

  router.openapi(
    withSecurity(
      createRoute({
        method: 'delete',
        path: '/auth/sessions/{sessionId}',
        summary: 'Revoke a session',
        description:
          "Revokes a specific session by ID. Users can only revoke their own sessions. Useful for 'sign out of other devices' flows. Requires a valid session.",
        tags,
        request: {
          params: z.object({ sessionId: z.string().describe('UUID of the session to revoke.') }),
        },
        responses: {
          200: {
            content: { 'application/json': { schema: SuccessResponse } },
            description: 'Session revoked successfully.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'No valid session.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Account is suspended or must verify its email before session revocation is allowed.',
          },
          404: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Session not found or does not belong to the authenticated user.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const userId = c.get('authUserId');
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const blocked = await assertSensitiveSessionMutationAllowed(c, userId);
      if (blocked) return blocked;
      const { sessionId } = c.req.valid('param');
      const sessions = await runtime.repos.session.getUserSessions(userId, runtime.config);
      const session = sessions.find(s => s.sessionId === sessionId);
      if (!session) return errorResponse(c, 'Session not found', 404);
      await runtime.repos.session.deleteSession(sessionId, runtime.config);
      eventBus.emit('security.auth.session.revoked', { userId, sessionId });
      return c.json({ ok: true as const }, 200);
    },
  );

  router.use('/auth/reauth/challenge', userAuth);

  router.openapi(
    withSecurity(
      createRoute({
        method: 'post',
        path: '/auth/reauth/challenge',
        summary: 'Request a reauth challenge',
        description:
          'Issues a reauth challenge token for challenge-based MFA methods (email OTP, WebAuthn). The returned reauthToken must be passed to step-up, account deletion, or MFA disable endpoints. Direct methods (TOTP, password, recovery) do not require a challenge.',
        tags,
        responses: {
          200: {
            content: {
              'application/json': {
                schema: z.object({
                  availableMethods: z
                    .array(z.string())
                    .describe(
                      'All MFA methods available for this user (including direct methods like totp and password).',
                    ),
                  reauthToken: z
                    .string()
                    .optional()
                    .describe(
                      'Challenge token for emailOtp or webauthn methods. Required when using those methods.',
                    ),
                  webauthnOptions: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe(
                      'WebAuthn authentication options (present when WebAuthn is available).',
                    ),
                }),
              },
            },
            description: 'Reauth challenge issued.',
          },
          400: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'No challenge-based MFA methods configured for this user.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'No valid session.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Account is suspended or must verify its email before reauth can proceed.',
          },
          429: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Too many reauth attempts. Try again later.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`reauth-challenge:${ip}`, reauthChallengeOpts)) {
        return errorResponse(c, 'Too many reauth attempts. Try again later.', 429);
      }

      const userId = c.get('authUserId');
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const sessionId = c.get('sessionId');
      if (!sessionId) return errorResponse(c, 'Unauthorized', 401);
      const suspensionStatus = await getSuspended(runtime.adapter, userId);
      if (suspensionStatus.suspended) {
        eventBus.emit('security.auth.login.blocked', {
          userId,
          reason: 'suspended',
          meta: { reason: 'suspended' },
        });
        return errorResponse(c, 'Account suspended', 403);
      }
      await AuthService.assertLoginEmailVerified(userId, runtime);
      const getConfig = () => runtime.config;
      const { adapter } = runtime;
      const mfaMethods =
        getConfig().mfa && adapter.getMfaMethods ? await adapter.getMfaMethods(userId) : [];
      const hasPassword = adapter.hasPassword ? await adapter.hasPassword(userId) : false;

      // Build availableMethods — all methods the user could potentially use
      const availableMethods: string[] = [];
      if (mfaMethods.includes('totp')) availableMethods.push('totp');
      if (mfaMethods.includes('emailOtp')) availableMethods.push('emailOtp');
      if (mfaMethods.includes('webauthn')) availableMethods.push('webauthn');
      if (hasPassword) availableMethods.push('password');
      if (mfaMethods.length > 0) availableMethods.push('recovery');

      // Generate challenge for challenge-based methods
      const hasEmailOtp = mfaMethods.includes('emailOtp');
      const hasWebAuthn = mfaMethods.includes('webauthn');

      if (!hasEmailOtp && !hasWebAuthn) {
        return c.json({ availableMethods }, 200);
      }

      let emailOtpHash: string | undefined;
      let webauthnChallenge: string | undefined;
      let webauthnOptions: Record<string, unknown> | undefined;

      if (hasEmailOtp) {
        const emailOtpConfig = getConfig().mfa?.emailOtp ?? null;
        if (emailOtpConfig) {
          const { generateEmailOtpCode } = await import('@auth/services/mfa');
          const { code, hash } = generateEmailOtpCode(runtime);
          emailOtpHash = hash;
          const user = adapter.getUser ? await adapter.getUser(userId) : null;
          if (user?.email) {
            publishAuthEvent(runtime.events, 'auth:delivery.email_otp', { email: user.email, code });
          }
        }
      }

      if (hasWebAuthn) {
        const { generateWebAuthnAuthenticationOptions } = await import('@auth/services/mfa');
        const result = await generateWebAuthnAuthenticationOptions(userId, runtime);
        if (result) {
          webauthnChallenge = result.challenge;
          webauthnOptions = result.options;
        }
      }

      const { createReauthChallenge } = await import('@auth/lib/mfaChallenge');
      const reauthToken = await createReauthChallenge(
        runtime.repos.mfaChallenge,
        userId,
        sessionId,
        { emailOtpHash, webauthnChallenge },
        runtime.config,
      );

      return c.json({ availableMethods, reauthToken, webauthnOptions }, 200);
    },
  );

  return router;
};
