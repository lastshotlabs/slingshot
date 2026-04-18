import { checkBreachedPassword } from '@auth/lib/breachedPassword';
import { checkPasswordNotReused, recordPasswordChange } from '@auth/lib/passwordHistory';
import { consumeResetToken, createResetToken } from '@auth/lib/resetPassword';
import { createPasswordSchema } from '@auth/schemas/auth';
import { ErrorResponse } from '@auth/schemas/error';
import { SuccessResponse } from '@auth/schemas/success';
import type { Context } from 'hono';
import { z } from 'zod';
import { createRoute, errorResponse } from '@lastshotlabs/slingshot-core';
import { HttpError, createRouter, getClientIp } from '@lastshotlabs/slingshot-core';
import type { AuthRateLimitConfig, HookContext } from '../config/authConfig';
import type { AuthRuntimeContext } from '../runtime';

export interface PasswordResetRouterOptions {
  rateLimit?: AuthRateLimitConfig;
}

/**
 * Creates the password reset router.
 *
 * Mounted routes:
 * - `POST /auth/forgot-password` — Request a password reset email for a given address.
 * - `POST /auth/reset-password`  — Consume the single-use reset token and set a new password.
 *
 * @param options - Router configuration.
 * @param options.rateLimit - Per-endpoint rate-limit overrides (`forgotPassword`,
 *   `resetPassword` windows and max counts).
 * @param runtime - The auth runtime context (adapter, event bus, repos, rate limiter,
 *   password hasher, etc.).
 * @returns A Hono router with the password reset routes mounted.
 *
 * @throws {HttpError} 400 — Invalid or expired reset token, or the new password
 *   has appeared in a data breach (when breached-password checking is configured),
 *   or the new password was recently used (preventReuse policy).
 * @throws {HttpError} 429 — Too many attempts from this IP or for this email address.
 * @throws {HttpError} 501 — Auth adapter does not support `setPassword`.
 *
 * @remarks
 * `POST /auth/forgot-password` is enumeration-safe: it always returns 200 regardless of
 * whether the email is registered. Token creation and email delivery are performed
 * asynchronously (fire-and-forget) to eliminate obvious timing differences. Rate limiting
 * is applied to both the requesting IP and the email address independently, preventing
 * distributed email-bombing attacks. The reset token is delivered via the
 * `auth:delivery.password_reset` event on the event bus.
 *
 * `POST /auth/reset-password` atomically consumes the token (preventing concurrent replay),
 * optionally checks the new password against breach databases, validates the
 * `preventReuse` policy, and revokes all active sessions after the password is updated so
 * stolen JWTs cannot remain valid.
 *
 * @example
 * const router = createPasswordResetRouter(
 *   { rateLimit: { forgotPassword: { max: 5, windowMs: 15 * 60 * 1000 } } },
 *   runtime,
 * );
 * app.route('/', router);
 */
export const createPasswordResetRouter = (
  { rateLimit }: PasswordResetRouterOptions,
  runtime: AuthRuntimeContext,
) => {
  const { adapter, eventBus } = runtime;
  const getConfig = () => runtime.config;
  const router = createRouter();
  const tags = ['Auth'];

  const hookCtx = (c: Context): HookContext => ({
    ip: getClientIp(c) !== 'unknown' ? getClientIp(c) : undefined,
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.get('requestId') as string | undefined,
  });

  const forgotOpts = {
    windowMs: rateLimit?.forgotPassword?.windowMs ?? 15 * 60 * 1000,
    max: rateLimit?.forgotPassword?.max ?? 5,
  };
  const resetOpts = {
    windowMs: rateLimit?.resetPassword?.windowMs ?? 15 * 60 * 1000,
    max: rateLimit?.resetPassword?.max ?? 10,
  };

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/forgot-password',
      summary: 'Request password reset',
      description:
        'Sends a password reset email if the address is registered. Always returns 200 regardless of whether the address exists, to prevent email enumeration. Rate-limited by both IP and email address.',
      tags,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                email: z.email().describe('Email address to send the reset link to.'),
              }),
            },
          },
          description: 'Email address for the account to reset.',
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: z.object({ message: z.string() }) } },
          description: 'Request received. A reset email will be sent if the address is registered.',
        },
        400: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Validation error (e.g. not a valid email address).',
        },
        429: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Too many attempts from this IP or for this email address. Try again later.',
        },
      },
    }),
    async c => {
      const ip = getClientIp(c);
      const { email } = c.req.valid('json');
      // Rate-limit by both IP and email to prevent distributed email-bombing
      const ipLimited = await runtime.rateLimit.trackAttempt(`forgot:ip:${ip}`, forgotOpts);
      const emailLimited = await runtime.rateLimit.trackAttempt(
        `forgot:email:${email}`,
        forgotOpts,
      );
      if (ipLimited || emailLimited) {
        return errorResponse(c, 'Too many attempts. Try again later.', 429);
      }
      // Constant-time response: always wait a minimum duration so an attacker cannot
      // distinguish "email found" from "email not found" via response timing.
      const floor = new Promise<void>(r => setTimeout(r, 150));
      const user = await adapter.findByEmail(email);
      // Fire-and-forget: the response does not wait for token creation or email sending.
      const msg = {
        message: 'If that email is registered, a password reset link has been sent.',
      };
      if (user) {
        void (async () => {
          try {
            const token = await createResetToken(
              runtime.repos.resetToken,
              user.id,
              email,
              runtime.config,
            );
            eventBus.emit('auth:delivery.password_reset', { email, token });
            eventBus.emit('auth:password.reset.requested', { userId: user.id, email });
          } catch (err) {
            console.error(
              'Failed to send password reset email:',
              err instanceof Error ? err.message : String(err),
            );
          }
        })();
      }
      await floor;
      return c.json(msg, 200);
    },
  );

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/reset-password',
      summary: 'Reset password',
      description:
        'Consumes a single-use reset token and sets a new password. All active sessions are revoked after a successful reset to invalidate any stolen JWTs. Rate-limited by IP.',
      tags,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                token: z.string().describe('Single-use reset token received via email.'),
                password: createPasswordSchema(runtime.config.passwordPolicy).describe(
                  'New password.',
                ),
              }),
            },
          },
          description: 'Reset token and new password.',
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: SuccessResponse } },
          description: 'Password reset. All sessions have been revoked.',
        },
        400: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Validation error, or the reset token is invalid or expired.',
        },
        429: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Too many reset attempts from this IP. Try again later.',
        },
        501: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'The configured auth adapter does not support setPassword.',
        },
      },
    }),
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`reset:${ip}`, resetOpts)) {
        return errorResponse(c, 'Too many attempts. Try again later.', 429);
      }
      const { token, password } = c.req.valid('json');
      const breachConfig = getConfig().breachedPassword;
      if (breachConfig) {
        const { breached } = await checkBreachedPassword(
          password,
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
      // consumeResetToken atomically gets and deletes — prevents concurrent replay
      const entry = await consumeResetToken(runtime.repos.resetToken, token);
      if (!entry) return errorResponse(c, 'Invalid or expired reset token', 400);
      if (!adapter.setPassword) {
        return errorResponse(c, 'Auth adapter does not support setPassword', 501);
      }
      const passwordHash = await runtime.password.hash(password);

      // Password reuse check
      const preventReuseReset = getConfig().passwordPolicy.preventReuse ?? 0;
      if (preventReuseReset > 0) {
        const isNew = await checkPasswordNotReused(
          adapter,
          entry.userId,
          password,
          preventReuseReset,
        );
        if (!isNew) {
          return c.json(
            { error: 'You cannot reuse a recent password.', code: 'PASSWORD_PREVIOUSLY_USED' },
            400,
          );
        }
      }

      const hooks = getConfig().hooks;
      const ctx = hookCtx(c);
      if (hooks.prePasswordChange) await hooks.prePasswordChange({ userId: entry.userId, ...ctx });

      await adapter.setPassword(entry.userId, passwordHash);
      if (preventReuseReset > 0)
        await recordPasswordChange(adapter, entry.userId, passwordHash, preventReuseReset);
      // Revoke all sessions so stolen JWTs can't stay valid after a reset
      {
        const sr = runtime.repos.session;
        const ss = await sr.getUserSessions(entry.userId, runtime.config);
        await Promise.all(ss.map(s => sr.deleteSession(s.sessionId, runtime.config)));
      }
      eventBus.emit('security.auth.password.reset', {});

      if (hooks.postPasswordChange) {
        const postPwHook = hooks.postPasswordChange;
        Promise.resolve()
          .then(() => postPwHook({ userId: entry.userId, ...ctx }))
          .catch((e: unknown) =>
            console.error(
              '[lifecycle] postPasswordChange hook error:',
              e instanceof Error ? e.message : String(e),
            ),
          );
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  return router;
};
