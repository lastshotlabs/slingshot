import { checkBreachedPassword } from '@auth/lib/breachedPassword';
import { clearAuthCookie, readAuthCookie, setAuthCookie } from '@auth/lib/cookieOptions';
import { isProd } from '@auth/lib/env';
import { checkPasswordNotReused, recordPasswordChange } from '@auth/lib/passwordHistory';
import { getSuspended } from '@auth/lib/suspension';
import { clearCsrfToken } from '@auth/middleware/csrf';
import { userAuth } from '@auth/middleware/userAuth';
import { PasswordUpdateResponse, verificationSchema } from '@auth/schemas/auth';
import { ErrorResponse } from '@auth/schemas/error';
import { SuccessResponse } from '@auth/schemas/success';
import * as AuthService from '@auth/services/auth';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  createRoute,
  errorResponse,
  getRequestTenantId,
  withSecurity,
} from '@lastshotlabs/slingshot-core';
import {
  COOKIE_REFRESH_TOKEN,
  COOKIE_TOKEN,
  HEADER_USER_TOKEN,
  HttpError,
  createRouter,
  getActor,
  getActorId,
  getClientIp,
} from '@lastshotlabs/slingshot-core';
import type {
  AccountDeletionConfig,
  AuthRateLimitConfig,
  AuthSessionPolicyConfig,
  HookContext,
  PrimaryField,
  RefreshTokenConfig,
} from '../config/authConfig';
import { publishAuthEvent } from '../eventGovernance';
import type { AuthRuntimeContext } from '../runtime';

export interface AccountRouterOptions {
  primaryField: PrimaryField;
  rateLimit?: AuthRateLimitConfig;
  refreshTokens?: RefreshTokenConfig;
  sessionPolicy?: AuthSessionPolicyConfig;
  accountDeletion?: AccountDeletionConfig;
}

/**
 * Creates the account management router, mounting routes under `/auth/me` and
 * `/auth/set-password`.
 *
 * Mounted routes:
 * - `GET  /auth/me`            — Return the authenticated user's profile.
 * - `PATCH /auth/me`           — Update display name, first/last name, or user metadata.
 * - `DELETE /auth/me`          — Delete the account, with optional factor verification and
 *                                grace-period queued deletion support.
 * - `POST /auth/set-password`  — Set or change the account password (current password
 *                                required when one is already set).
 * - `POST /auth/logout`        — Invalidate the current session and clear cookies.
 *
 * @param options - Router configuration.
 * @param options.primaryField - The primary identifier field (`'email'`, `'username'`, or `'phone'`).
 * @param options.rateLimit - Per-endpoint rate-limit overrides (deleteAccount, setPassword windows).
 * @param options.refreshTokens - Refresh-token config; controls access-token cookie max-age.
 * @param options.sessionPolicy - Session lifecycle policy (e.g. `onPasswordChange` revocation strategy).
 * @param options.accountDeletion - Account deletion config (queued mode, grace period, hooks).
 * @param runtime - The auth runtime context (adapter, event bus, repos, rate limiter, etc.).
 * @returns A Hono router with all account management routes mounted.
 *
 * @throws {HttpError} 429 — Too many deletion or password-change attempts.
 * @throws {HttpError} 501 — Auth adapter does not support `deleteUser` or `setPassword`.
 * @throws {HttpError} 400 — Verification required but not provided; or password reuse violation.
 * @throws {HttpError} 401 — Invalid credentials or no active session.
 *
 * @remarks
 * **Authentication requirements**: all routes in this router require a valid session
 * via the `userAuth` middleware (reads the `slingshot_token` `HttpOnly` cookie or the
 * `x-user-token` header). The only partial exception is `POST /auth/logout`, which
 * attempts a graceful session deletion but returns 200 even when the session is already
 * expired or absent — it does not require a currently valid token.
 *
 * Session-bound mutation routes (`PATCH /auth/me`, `DELETE /auth/me`, and
 * `POST /auth/set-password`) fail closed with `403` when the account is suspended
 * or when required email verification is no longer satisfied. This keeps stale
 * sessions from mutating account state when identify-time suspension checks are
 * intentionally disabled.
 *
 * **Token types used**: all routes use the standard `sessionToken` (JWT in the
 * `slingshot_token` cookie or `x-user-token` header). No `mfaToken` is accepted by any
 * route in this router. Factor re-verification for account deletion (`DELETE /auth/me`)
 * uses a plaintext password or TOTP code submitted in the request body, not a separate
 * token exchange.
 *
 * All routes except `POST /auth/logout` require a valid session (cookie or
 * `x-user-token` header). `DELETE /auth/me` enforces factor verification for
 * accounts that have a password or MFA method enrolled. When `accountDeletion.queued`
 * is `true`, deletion is scheduled via BullMQ and a cancel-token is issued during the
 * grace period; BullMQ and Redis must be available or an error is thrown at request time.
 * Session revocation policy on password change is controlled by
 * `sessionPolicy.onPasswordChange` (`'revoke_others'` | `'revoke_all_and_reissue'` | `'none'`).
 *
 * @example
 * const router = createAccountRouter(
 *   { primaryField: 'email', sessionPolicy: { onPasswordChange: 'revoke_others' } },
 *   runtime,
 * );
 * app.route('/', router);
 */
export const createAccountRouter = (
  { rateLimit, refreshTokens, sessionPolicy, accountDeletion }: AccountRouterOptions,
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

  const assertSensitiveAccountMutationAllowed = async (c: Context, userId: string) => {
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

  const deleteAccountOpts = {
    windowMs: rateLimit?.deleteAccount?.windowMs ?? 60 * 60 * 1000,
    max: rateLimit?.deleteAccount?.max ?? 3,
  };
  const setPasswordOpts = {
    windowMs: rateLimit?.setPassword?.windowMs ?? 15 * 60 * 1000,
    max: rateLimit?.setPassword?.max ?? 5,
  };

  router.use('/auth/me', userAuth);

  router.openapi(
    withSecurity(
      createRoute({
        method: 'get',
        path: '/auth/me',
        summary: 'Get current user',
        description:
          "Returns the authenticated user's profile. Requires a valid session via cookie or x-user-token header.",
        tags,
        responses: {
          200: {
            content: {
              'application/json': {
                schema: z.object({
                  id: z.string().describe('Canonical user ID alias for frontend runtimes.'),
                  userId: z.string().describe('Unique user ID.'),
                  email: z.string().optional().describe("User's email address."),
                  emailVerified: z
                    .boolean()
                    .optional()
                    .describe('Whether the email address has been verified.'),
                  googleLinked: z
                    .boolean()
                    .optional()
                    .describe('Whether a Google OAuth account is linked.'),
                  userMetadata: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe('User-editable metadata blob.'),
                }),
              },
            },
            description: "Authenticated user's profile.",
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
      const user = adapter.getUser ? await adapter.getUser(userId) : null;
      const googleLinked = user?.providerIds?.some(id => id.startsWith('google:')) ?? false;
      return c.json(
        {
          id: userId,
          userId: userId,
          email: user?.email,
          emailVerified: user?.emailVerified,
          googleLinked,
          userMetadata: user?.userMetadata ?? {},
        },
        200,
      );
    },
  );

  router.openapi(
    withSecurity(
      createRoute({
        method: 'patch',
        path: '/auth/me',
        summary: 'Update current user profile',
        description:
          "Updates the authenticated user's profile fields and/or user-editable metadata. Requires a valid session.",
        tags,
        request: {
          body: {
            content: {
              'application/json': {
                schema: z.object({
                  displayName: z.string().optional().describe("User's display name."),
                  firstName: z.string().optional().describe("User's first name."),
                  lastName: z.string().optional().describe("User's last name."),
                  userMetadata: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe('User-editable metadata blob (replaces existing).'),
                }),
              },
            },
            description: 'Fields to update.',
          },
        },
        responses: {
          200: {
            content: { 'application/json': { schema: SuccessResponse } },
            description: 'Profile updated.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Account is suspended or must verify its email before profile mutations are allowed.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'No valid session.',
          },
          501: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Auth adapter does not support profile updates.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const userId = getActorId(c);
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const blocked = await assertSensitiveAccountMutationAllowed(c, userId);
      if (blocked) return blocked;
      const body = c.req.valid('json') as {
        displayName?: string;
        firstName?: string;
        lastName?: string;
        userMetadata?: Record<string, unknown>;
      };

      if (body.userMetadata !== undefined && adapter.setUserMetadata) {
        await adapter.setUserMetadata(userId, body.userMetadata);
      }

      const profileFields: Record<string, unknown> = {};
      if ('displayName' in body) profileFields.displayName = body.displayName;
      if ('firstName' in body) profileFields.firstName = body.firstName;
      if ('lastName' in body) profileFields.lastName = body.lastName;

      if (Object.keys(profileFields).length > 0) {
        if (!adapter.updateProfile) {
          return errorResponse(c, 'Auth adapter does not support profile updates', 501);
        }
        await adapter.updateProfile(
          userId,
          profileFields as Parameters<NonNullable<typeof adapter.updateProfile>>[1],
        );
      }

      return c.json({ ok: true as const }, 200);
    },
  );

  router.openapi(
    withSecurity(
      createRoute({
        method: 'delete',
        path: '/auth/me',
        summary: 'Delete account',
        description:
          "Permanently deletes the authenticated user's account. Requires factor verification for accounts that have a password or MFA. OAuth-only accounts may be deleted freely unless requireVerification is set. Revokes all active sessions.",
        tags,
        request: {
          body: {
            content: {
              'application/json': {
                schema: verificationSchema,
              },
            },
            description: 'Factor verification.',
          },
        },
        responses: {
          200: {
            content: { 'application/json': { schema: SuccessResponse } },
            description: 'Account deleted.',
          },
          202: {
            content: { 'application/json': { schema: SuccessResponse } },
            description: 'Account deletion has been scheduled.',
          },
          400: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Verification is required but not provided.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Invalid verification or no valid session.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Account is suspended or must verify its email before account deletion is allowed.',
          },
          429: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Too many deletion attempts. Try again later.',
          },
          501: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'The configured auth adapter does not support deleteUser.',
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
      if (await runtime.rateLimit.trackAttempt(`deleteaccount:${userId}`, deleteAccountOpts)) {
        return errorResponse(c, 'Too many deletion attempts. Try again later.', 429);
      }

      const blocked = await assertSensitiveAccountMutationAllowed(c, userId);
      if (blocked) return blocked;

      if (!adapter.deleteUser) {
        return errorResponse(c, 'Auth adapter does not support deleteUser', 501);
      }

      const body = c.req.valid('json');
      const hasPassword = adapter.hasPassword ? await adapter.hasPassword(userId) : false;
      const mfaMethods =
        getConfig().mfa && adapter.getMfaMethods ? await adapter.getMfaMethods(userId) : [];
      const hasVerifiableFactor = hasPassword || mfaMethods.length > 0;

      if (hasVerifiableFactor) {
        // Infer method from provided credentials when not specified
        const method = body.method ?? (body.password ? 'password' : body.code ? 'totp' : undefined);
        if (!method) {
          return c.json(
            {
              error:
                'Verification is required to delete this account. Provide method and credentials.',
            },
            400,
          );
        }
        const { verifyAnyFactor } = await import('@auth/services/mfa');
        const valid = await verifyAnyFactor(userId, sessionId, runtime, {
          method,
          code: body.code,
          password: body.password,
          reauthToken: body.reauthToken,
          webauthnResponse: body.webauthnResponse as object | undefined,
        });
        if (!valid) {
          return errorResponse(c, 'Invalid verification', 401);
        }
      } else {
        // OAuth-only account — no verifiable factor
        if (accountDeletion?.requireVerification) {
          return c.json(
            {
              error:
                'Account deletion requires a verifiable factor. Please set a password or enable MFA first.',
            },
            400,
          );
        }
        // else: allow deletion without verification
      }

      const hooks = getConfig().hooks;
      if (hooks.preDeleteAccount) {
        await hooks.preDeleteAccount({ userId: userId, ...hookCtx(c) });
      }

      // Queued deletion via BullMQ
      if (accountDeletion?.queued) {
        if (!runtime.queueFactory)
          throw new Error('[slingshot-auth] accountDeletion.queued requires Redis and BullMQ');
        const appName = runtime.config.appName;
        const queue = runtime.queueFactory.createQueue<{ userId: string }>(
          `${appName}:account-deletions`,
        );
        const delayMs = (accountDeletion.gracePeriod ?? 0) * 1000;
        const job = await queue.add(
          'delete-account',
          { userId: userId },
          {
            delay: delayMs,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
            removeOnFail: 100,
          },
        );
        await queue.close();

        // Revoke sessions immediately so the user is logged out
        {
          const sr = runtime.repos.session;
          const ss = await sr.getUserSessions(userId, runtime.config);
          await Promise.all(ss.map(s => sr.deleteSession(s.sessionId, runtime.config)));
        }

        if (accountDeletion.gracePeriod) {
          const { createDeletionCancelToken } = await import('@auth/lib/deletionCancelToken');
          const jobId = job.id;
          if (!jobId) throw new Error('[slingshot-auth] job.id is unexpectedly undefined');
          const cancelToken = await createDeletionCancelToken(
            runtime.repos.deletionCancelToken,
            userId,
            jobId,
            accountDeletion.gracePeriod,
          );
          publishAuthEvent(
            runtime.events,
            'auth:account.deletion.scheduled',
            {
              userId: userId,
              cancelToken,
              gracePeriodSeconds: accountDeletion.gracePeriod ?? 0,
            },
            { userId: userId, actorId: userId, requestTenantId: getRequestTenantId(c) },
          );
          const user = adapter.getUser ? await adapter.getUser(userId) : null;
          const email = user?.email ?? '';
          if (email) {
            publishAuthEvent(runtime.events, 'auth:delivery.account_deletion', {
              userId: userId,
              email,
              cancelToken,
              gracePeriodSeconds: accountDeletion.gracePeriod ?? 0,
            });
          }
        } else {
          // No grace period — deletion is immediate via the queue (delay=0).
          // Emit the same events as the synchronous path so listeners are notified.
          eventBus.emit('security.auth.account.deleted', { userId: userId });
          publishAuthEvent(
            runtime.events,
            'auth:user.deleted',
            { userId: userId },
            {
              userId: userId,
              actorId: userId,
              requestTenantId: getRequestTenantId(c),
            },
          );
        }

        clearAuthCookie(c, COOKIE_TOKEN, isProd(), runtime.config);
        clearAuthCookie(c, COOKIE_REFRESH_TOKEN, isProd(), runtime.config);
        return c.json({ ok: true as const }, 202);
      }

      // Synchronous deletion (default)
      if (accountDeletion?.onBeforeDelete) {
        await accountDeletion.onBeforeDelete(userId);
      }

      {
        const sr = runtime.repos.session;
        const ss = await sr.getUserSessions(userId, runtime.config);
        await Promise.all(ss.map(s => sr.deleteSession(s.sessionId, runtime.config)));
      }
      await adapter.deleteUser(userId);

      eventBus.emit('security.auth.account.deleted', { userId: userId });
      publishAuthEvent(
        runtime.events,
        'auth:user.deleted',
        { userId: userId },
        {
          userId: userId,
          actorId: userId,
        },
      );

      if (accountDeletion?.onAfterDelete) {
        await accountDeletion.onAfterDelete(userId);
      }
      if (hooks.postDeleteAccount) {
        const postDeleteHook = hooks.postDeleteAccount;
        Promise.resolve()
          .then(() => postDeleteHook({ userId: userId, ...hookCtx(c) }))
          .catch((e: unknown) =>
            console.error(
              '[lifecycle] postDeleteAccount hook error:',
              e instanceof Error ? e.message : String(e),
            ),
          );
      }

      clearAuthCookie(c, COOKIE_TOKEN, isProd(), runtime.config);
      clearAuthCookie(c, COOKIE_REFRESH_TOKEN, isProd(), runtime.config);
      return c.json({ ok: true as const }, 200);
    },
  );

  router.use('/auth/set-password', userAuth);

  router.openapi(
    withSecurity(
      createRoute({
        method: 'post',
        path: '/auth/set-password',
        summary: 'Set or update password',
        description:
          'Sets or updates the password for the authenticated user. Useful for OAuth-only users who want to add a password. If the account already has a password set, `currentPassword` is required. Requires a valid session.',
        tags,
        request: {
          body: {
            content: {
              'application/json': {
                schema: z.object({
                  password: z.string().min(8).describe('New password.'),
                  currentPassword: z
                    .string()
                    .optional()
                    .describe(
                      'Current password. Required if the account already has a password set.',
                    ),
                }),
              },
            },
            description: 'New password.',
          },
        },
        responses: {
          200: {
            content: { 'application/json': { schema: PasswordUpdateResponse } },
            description: 'Password updated successfully.',
          },
          403: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Password changes fail closed when the account is suspended or email verification is required, including reissue flows that would otherwise mint a fresh session.',
          },
          400: {
            content: { 'application/json': { schema: ErrorResponse } },
            description:
              'Validation error, or current password is required when one is already set.',
          },
          401: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'No valid session, or current password is incorrect.',
          },
          429: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'Too many password change attempts. Try again later.',
          },
          501: {
            content: { 'application/json': { schema: ErrorResponse } },
            description: 'The configured auth adapter does not support setPassword.',
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      if (!adapter.setPassword) {
        return errorResponse(c, 'Auth adapter does not support setPassword', 501);
      }
      const { password, currentPassword } = c.req.valid('json');
      const userId = getActorId(c);
      if (!userId) return errorResponse(c, 'Unauthorized', 401);
      const currentSessionId = getActor(c).sessionId;
      if (!currentSessionId) return errorResponse(c, 'Unauthorized', 401);

      const blocked = await assertSensitiveAccountMutationAllowed(c, userId);
      if (blocked) return blocked;

      if (await runtime.rateLimit.trackAttempt(`setpassword:${userId}`, setPasswordOpts)) {
        eventBus.emit('security.rate_limit.exceeded', { meta: { path: c.req.path } });
        return errorResponse(c, 'Too many password change attempts. Try again later.', 429);
      }

      // If the user already has a password, require currentPassword to change it
      const hasExistingPassword = adapter.hasPassword ? await adapter.hasPassword(userId) : false;
      if (hasExistingPassword) {
        if (!currentPassword) {
          return c.json(
            { error: 'Current password is required to change an existing password.' },
            400,
          );
        }
        if (!(await adapter.verifyPassword(userId, currentPassword))) {
          return errorResponse(c, 'Current password is incorrect.', 401);
        }
      }

      // Breached password check
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

      const hooks = getConfig().hooks;
      if (hooks.prePasswordChange) await hooks.prePasswordChange({ userId: userId });

      const passwordHash = await runtime.password.hash(password);

      // Password reuse check
      const preventReuse = getConfig().passwordPolicy.preventReuse ?? 0;
      if (preventReuse > 0) {
        const isNew = await checkPasswordNotReused(
          adapter,
          userId,
          password,
          preventReuse,
          runtime.password,
        );
        if (!isNew) {
          return c.json(
            { error: 'You cannot reuse a recent password.', code: 'PASSWORD_PREVIOUSLY_USED' },
            400,
          );
        }
      }

      await adapter.setPassword(userId, passwordHash);
      if (preventReuse > 0) await recordPasswordChange(adapter, userId, passwordHash, preventReuse);
      eventBus.emit('security.auth.password.change', { userId: userId });
      if (hooks.postPasswordChange) {
        const postPwHook = hooks.postPasswordChange;
        Promise.resolve()
          .then(() => postPwHook({ userId: userId }))
          .catch((e: unknown) =>
            console.error(
              '[lifecycle] postPasswordChange hook error:',
              e instanceof Error ? e.message : String(e),
            ),
          );
      }

      // Session revocation policy on password change
      const pwChangePolicy = sessionPolicy?.onPasswordChange ?? 'revoke_others';
      if (pwChangePolicy === 'revoke_all_and_reissue') {
        // Revoke all sessions including current, create a new session
        {
          const sr = runtime.repos.session;
          const ss = await sr.getUserSessions(userId, runtime.config);
          await Promise.all(ss.map(s => sr.deleteSession(s.sessionId, runtime.config)));
        }
        const { getSuspended } = await import('@auth/lib/suspension');
        const suspensionStatus = await getSuspended(adapter, userId);
        if (suspensionStatus.suspended) {
          eventBus.emit('security.auth.login.blocked', {
            userId: userId,
            reason: 'suspended',
            meta: { reason: 'suspended' },
          });
          return errorResponse(c, 'Account suspended', 403);
        }
        await AuthService.assertLoginEmailVerified(userId, runtime);
        const { createSessionForUser } = await import('@auth/services/auth');
        const metadata = {
          ipAddress: getClientIp(c) !== 'unknown' ? getClientIp(c) : undefined,
          userAgent: c.req.header('user-agent') ?? undefined,
        };
        const newSession = await createSessionForUser(userId, runtime, metadata, hookCtx(c));
        setAuthCookie(
          c,
          COOKIE_TOKEN,
          newSession.token,
          isProd(),
          runtime.config,
          refreshTokens ? (getConfig().refreshToken?.accessTokenExpiry ?? 900) : undefined,
        );
        if (newSession.refreshToken) {
          setAuthCookie(
            c,
            COOKIE_REFRESH_TOKEN,
            newSession.refreshToken,
            isProd(),
            runtime.config,
            getConfig().refreshToken?.refreshTokenExpiry ?? 2_592_000,
          );
        }
        return c.json({ ok: true as const, token: newSession.token }, 200);
      } else if (pwChangePolicy === 'revoke_others') {
        {
          const sr = runtime.repos.session;
          const ss = await sr.getUserSessions(userId, runtime.config);
          const others = ss.filter(s => s.sessionId !== currentSessionId);
          await Promise.all(others.map(s => sr.deleteSession(s.sessionId, runtime.config)));
        }
      }
      // "none" or unrecognized: no session action
      return c.json({ ok: true as const }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/logout',
      summary: 'Log out',
      description:
        'Invalidates the current session and clears the session cookie. Safe to call even without an active session.',
      tags,
      responses: {
        200: {
          content: { 'application/json': { schema: SuccessResponse } },
          description: 'Logged out. Session is invalidated and cookie is cleared.',
        },
      },
    }),
    async c => {
      const token =
        readAuthCookie(c, COOKIE_TOKEN, isProd(), runtime.config) ??
        c.req.header(HEADER_USER_TOKEN) ??
        null;
      await AuthService.logout(token, runtime);
      clearAuthCookie(c, COOKIE_TOKEN, isProd(), runtime.config);
      clearAuthCookie(c, COOKIE_REFRESH_TOKEN, isProd(), runtime.config);
      if (getConfig().csrfEnabled) clearCsrfToken(c);
      return c.json({ ok: true as const }, 200);
    },
  );

  return router;
};
