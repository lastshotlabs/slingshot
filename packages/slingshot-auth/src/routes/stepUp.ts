import { getSuspended } from '@auth/lib/suspension';
import { userAuth } from '@auth/middleware/userAuth';
import { ErrorResponse } from '@auth/schemas/error';
import * as AuthService from '@auth/services/auth';
import { z } from 'zod';
import { createRoute, errorResponse, withSecurity } from '@lastshotlabs/slingshot-core';
import { createRouter, getClientIp } from '@lastshotlabs/slingshot-core';
import type { AuthRateLimitConfig, StepUpConfig } from '../config/authConfig';
import type { AuthRuntimeContext } from '../runtime';

export interface StepUpRouterOptions {
  stepUp: StepUpConfig;
  rateLimit?: AuthRateLimitConfig;
}

/**
 * Creates the step-up (re-authentication) router.
 *
 * Mounted routes:
 * - `POST /auth/step-up` — Re-authenticate the current session using a second factor
 *                          (TOTP, email OTP, WebAuthn, recovery code, or password) to
 *                          satisfy step-up requirements for sensitive operations.
 *
 * @param options - Router configuration.
 * @param options.stepUp - Step-up config (e.g. TTL for the `mfaVerifiedAt` window).
 * @param options.rateLimit - Per-endpoint rate-limit overrides. The `mfaVerify` window is
 *   reused for the step-up endpoint.
 * @param runtime - The auth runtime context (adapter, event bus, repos, rate limiter, etc.).
 * @returns A Hono router with the step-up route mounted.
 *
 * @throws {HttpError} 400 — No verification parameter provided (neither `code`,
 *   `password`, `reauthToken`, nor `webauthnResponse`).
 * @throws {HttpError} 401 — Invalid credentials or no active session.
 * @throws {HttpError} 429 — Too many step-up attempts from this IP.
 *
 * @remarks
 * Requires an active session via the `userAuth` middleware. On success, `mfaVerifiedAt`
 * is stamped on the session record so that `requireStepUp` middleware (which checks the
 * age of that timestamp against the configured TTL) will pass for subsequent requests.
 * Challenge-based methods (email OTP, WebAuthn) require a `reauthToken` obtained from
 * `POST /auth/reauth/challenge` first; direct methods (TOTP, password, recovery codes)
 * can be submitted without a prior challenge. Emits `security.auth.step_up.success` or
 * `security.auth.step_up.failure` on the event bus. Suspended accounts and accounts that
 * now require email verification are rejected with `403` before the session's
 * `mfaVerifiedAt` state is strengthened.
 *
 * @example
 * const router = createStepUpRouter(
 *   { stepUp: { ttlSeconds: 300 }, rateLimit: { mfaVerify: { max: 10, windowMs: 900_000 } } },
 *   runtime,
 * );
 * app.route('/', router);
 */
export const createStepUpRouter = (
  { rateLimit }: StepUpRouterOptions,
  runtime: AuthRuntimeContext,
) => {
  const { eventBus } = runtime;
  const router = createRouter();
  const tags = ['Auth'];

  const stepUpOpts = {
    windowMs: rateLimit?.mfaVerify?.windowMs ?? 15 * 60 * 1000,
    max: rateLimit?.mfaVerify?.max ?? 10,
  };

  const stepUpSchema = z.object({
    method: z
      .enum(['totp', 'emailOtp', 'webauthn', 'password', 'recovery'])
      .describe('Verification method to use.'),
    code: z.string().optional().describe('TOTP code, email OTP code, or recovery code.'),
    password: z.string().optional().describe('Account password.'),
    reauthToken: z
      .string()
      .optional()
      .describe('Reauth challenge token (required for emailOtp and webauthn methods).'),
    webauthnResponse: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('WebAuthn assertion response (required for webauthn method).'),
  });

  router.use('/auth/step-up', userAuth);

  router.openapi(
    withSecurity(
      createRoute({
        method: 'post',
        path: '/auth/step-up',
        summary: 'Step-up MFA re-authentication',
        description:
          'Re-authenticates the current session via TOTP, email OTP, WebAuthn, recovery code, or password to satisfy step-up requirements for sensitive operations. On success, sets mfaVerifiedAt in the session.',
        tags,
        request: {
          body: {
            content: {
              'application/json': {
                schema: stepUpSchema,
              },
            },
            description: 'Verification credentials for re-authentication.',
          },
        },
        responses: {
          200: {
            content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
            description: 'Step-up authentication successful.',
          },
          400: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'No verification parameter provided.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Invalid credentials or no valid session.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Account is suspended or must verify its email before step-up can succeed.',
          },
          429: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Too many step-up attempts. Try again later.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`step-up:${ip}`, stepUpOpts)) {
        return errorResponse(c, 'Too many step-up attempts. Try again later.', 429);
      }
      const userId = c.get('authUserId');
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const sessionId = c.get('sessionId');
      if (!sessionId) return errorResponse(c, 'Unauthorized', 401);
      const body = c.req.valid('json');

      const { verifyAnyFactor } = await import('@auth/services/mfa');
      const valid = await verifyAnyFactor(userId, sessionId, runtime, {
        method: body.method,
        code: body.code,
        password: body.password,
        reauthToken: body.reauthToken,
        webauthnResponse: body.webauthnResponse as object | undefined,
      });

      if (!valid) {
        eventBus.emit('security.auth.step_up.failure', { userId });
        return errorResponse(c, 'Invalid credentials', 401);
      }

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

      await runtime.repos.session.setMfaVerifiedAt(sessionId);
      eventBus.emit('security.auth.step_up.success', { userId });
      return c.json({ ok: true as const }, 200);
    },
  );

  return router;
};
