import { consumeVerificationToken, createVerificationToken } from '@auth/lib/emailVerification';
import { refreshCsrfToken } from '@auth/middleware/csrf';
import { createLoginSchema } from '@auth/schemas/auth';
import { ErrorResponse } from '@auth/schemas/error';
import { SuccessResponse } from '@auth/schemas/success';
import { z } from 'zod';
import { createRoute, errorResponse } from '@lastshotlabs/slingshot-core';
import { createRouter, getClientIp, getRequestTenantId } from '@lastshotlabs/slingshot-core';
import type {
  AuthRateLimitConfig,
  EmailVerificationConfig,
  PrimaryField,
} from '../config/authConfig';
import { publishAuthEvent } from '../eventGovernance';
import type { AuthRuntimeContext } from '../runtime';

export interface EmailVerificationRouterOptions {
  primaryField: PrimaryField;
  emailVerification: EmailVerificationConfig;
  rateLimit?: AuthRateLimitConfig;
}

/**
 * Creates the email verification router.
 *
 * Mounted routes:
 * - `POST /auth/verify-email`        — Consume a single-use token and mark the account
 *                                      as email-verified.
 * - `POST /auth/resend-verification` — Authenticate with credentials and re-send a
 *                                      verification email.
 *
 * @param options - Router configuration.
 * @param options.primaryField - The primary identifier field used to look up accounts
 *   (`'email'`, `'username'`, or `'phone'`).
 * @param options.emailVerification - Email verification config (required by the parent
 *   router factory; unused at the route level but signals the feature is active).
 * @param options.rateLimit - Per-endpoint rate-limit overrides (`verifyEmail`,
 *   `resendVerification` windows).
 * @param runtime - The auth runtime context (adapter, event bus, repos, rate limiter, etc.).
 * @returns A Hono router with email verification routes mounted.
 *
 * @throws {HttpError} 400 — The verification token is invalid or has expired.
 * @throws {HttpError} 401 — Invalid credentials provided to resend-verification.
 * @throws {HttpError} 429 — Too many attempts from this IP or for this identifier.
 * @throws {HttpError} 501 — Auth adapter does not support email verification.
 *
 * @remarks
 * `POST /auth/resend-verification` is enumeration-safe: it always returns 200 for
 * valid credentials regardless of whether the account is already verified. A constant-time
 * dummy hash comparison is performed even when the user is not found to prevent
 * timing-based user enumeration. The verification token is delivered via the
 * `auth:delivery.email_verification` event on the event bus.
 *
 * @example
 * const router = createEmailVerificationRouter(
 *   { primaryField: 'email', emailVerification: { required: true }, rateLimit: {} },
 *   runtime,
 * );
 * app.route('/', router);
 */
export const createEmailVerificationRouter = (
  { primaryField, rateLimit }: EmailVerificationRouterOptions,
  runtime: AuthRuntimeContext,
) => {
  const { adapter, eventBus } = runtime;
  const getConfig = () => runtime.config;
  const router = createRouter();
  const LoginSchema = createLoginSchema(primaryField);
  const tags = ['Auth'];

  const verifyOpts = {
    windowMs: rateLimit?.verifyEmail?.windowMs ?? 15 * 60 * 1000,
    max: rateLimit?.verifyEmail?.max ?? 10,
  };
  const resendOpts = {
    windowMs: rateLimit?.resendVerification?.windowMs ?? 60 * 60 * 1000,
    max: rateLimit?.resendVerification?.max ?? 3,
  };

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/verify-email',
      summary: 'Verify email address',
      description:
        'Consumes a single-use email verification token and marks the account as verified. The token is delivered via the auth:delivery.email_verification bus event. Rate-limited by IP.',
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
          content: { 'application/json': { schema: SuccessResponse } },
          description: 'Email verified successfully.',
        },
        400: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Invalid or expired verification token.',
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
      if (getConfig().csrfEnabled) refreshCsrfToken(c);
      return c.json({ ok: true as const }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/resend-verification',
      summary: 'Resend verification email',
      description:
        'Authenticates with credentials and sends a new verification email. Always returns 200 for valid credentials regardless of verification status, to prevent user enumeration. Rate-limited per identifier. Does not require a session.',
      tags,
      request: {
        body: {
          content: { 'application/json': { schema: LoginSchema } },
          description: 'Login credentials to identify the account.',
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: z.object({ message: z.string() }) } },
          description:
            'Verification email sent, or account is already verified (indistinguishable by design).',
        },
        400: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'No email address on file for this account.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Invalid credentials.',
        },
        429: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Too many resend attempts for this identifier. Try again later.',
        },
        501: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'The configured auth adapter does not support email verification.',
        },
      },
    }),
    async c => {
      if (!adapter.getEmailVerified || !adapter.getUser) {
        return errorResponse(c, 'Auth adapter does not support email verification', 501);
      }
      const body: Record<string, string> = c.req.valid('json');
      const identifier = body[primaryField];
      if (await runtime.rateLimit.trackAttempt(`resend:${identifier}`, resendOpts)) {
        return errorResponse(c, 'Too many resend attempts. Try again later.', 429);
      }
      const findFn = (id: string) =>
        adapter.findByIdentifier ? adapter.findByIdentifier(id) : adapter.findByEmail(id);
      const user = await findFn(identifier);
      // Always call runtime.password.verify to prevent timing-based user enumeration.
      // When user is not found or has no passwordHash (OAuth-only account), verify
      // against a dummy hash so response time is constant regardless of user existence.
      const RESEND_DUMMY_HASH = await runtime.getDummyHash();
      const hashToVerify = user?.passwordHash ?? RESEND_DUMMY_HASH;
      const passwordValid = await runtime.password.verify(body.password, hashToVerify);
      if (!user || !passwordValid) {
        return errorResponse(c, 'Invalid credentials', 401);
      }
      const alreadyVerified = await adapter.getEmailVerified(user.id);
      // Return 200 (not 400) to avoid revealing whether the account is verified —
      // distinguishing verified vs unverified would let attackers confirm valid credentials.
      if (alreadyVerified)
        return c.json({ message: 'Verification email sent if not already verified' }, 200);
      const fullUser = await adapter.getUser(user.id);
      if (!fullUser?.email) return errorResponse(c, 'No email address on file', 400);
      const verificationToken = await createVerificationToken(
        runtime.repos.verificationToken,
        user.id,
        fullUser.email,
        runtime.config,
      );
      publishAuthEvent(runtime.events, 'auth:delivery.email_verification', {
        email: fullUser.email,
        token: verificationToken,
        userId: user.id,
      });
      return c.json({ message: 'Verification email sent' }, 200);
    },
  );

  return router;
};
