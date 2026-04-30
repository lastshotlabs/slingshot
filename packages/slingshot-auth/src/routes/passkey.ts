import { setAuthCookie } from '@auth/lib/cookieOptions';
import { isProd } from '@auth/lib/env';
import { createPasskeyLoginChallenge } from '@auth/lib/mfaChallenge';
import { refreshCsrfToken } from '@auth/middleware/csrf';
import { ErrorResponse } from '@auth/schemas/error';
import * as AuthService from '@auth/services/auth';
import type { Context } from 'hono';
import { z } from 'zod';
import { createRoute, errorResponse } from '@lastshotlabs/slingshot-core';
import { createRouter } from '@lastshotlabs/slingshot-core';
import { getClientIp } from '@lastshotlabs/slingshot-core';
import { COOKIE_REFRESH_TOKEN, COOKIE_TOKEN } from '@lastshotlabs/slingshot-core';
import type { HookContext } from '../config/authConfig';
import type { AuthRuntimeContext } from '../runtime';

const tags = ['Passkey'];

const hookCtx = (c: Context): HookContext => ({
  ip: getClientIp(c) !== 'unknown' ? getClientIp(c) : undefined,
  userAgent: c.req.header('user-agent') ?? undefined,
  requestId: c.get('requestId') as string | undefined,
});

/**
 * Creates the passkey (WebAuthn passwordless login) router.
 *
 * Mounted routes:
 * - `POST /auth/passkey/login-options` — Generate WebAuthn authentication options and a
 *                                        short-lived challenge token. Pass the options to
 *                                        `@simplewebauthn/browser` `startAuthentication()`.
 * - `POST /auth/passkey/login`         — Verify the WebAuthn assertion and issue a session.
 *                                        Also satisfies MFA by default (no separate MFA
 *                                        prompt unless `passkeyMfaBypass` is disabled).
 *
 * @param runtime - The auth runtime context (adapter, event bus, config, repos, rate
 *   limiter, etc.). `runtime.config.mfa.webauthn` must be set for passkey login to work.
 * @returns A Hono router with passkey login routes mounted.
 *
 * @throws {HttpError} 401 — WebAuthn assertion verification failed.
 * @throws {HttpError} 429 — Rate limit exceeded on options or login endpoints.
 *
 * @remarks
 * `POST /auth/passkey/login-options` is enumeration-safe: it always returns valid-looking
 * authentication options regardless of whether the provided `identifier` maps to a real
 * account. It deliberately does not return account-specific `allowCredentials` hints,
 * because those hints reveal whether an identifier has registered credentials. The returned
 * `passkeyToken` is a single-use challenge token (120s TTL) that must be passed to
 * `POST /auth/passkey/login` along with the assertion response.
 * Passkey login still honors `emailVerification.required` for email-primary apps; a user
 * whose email address is not verified cannot bypass that policy by authenticating with
 * WebAuthn.
 *
 * @example
 * const router = createPasskeyRouter(runtime);
 * app.route('/', router);
 */
export const createPasskeyRouter = (runtime: AuthRuntimeContext) => {
  const getConfig = () => runtime.config;
  const router = createRouter();

  // ─── POST /auth/passkey/login-options ──────────────────────────────────────

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/passkey/login-options',
      summary: 'Get passkey login options',
      description:
        'Returns WebAuthn authentication options for passwordless login. Always returns valid-looking options regardless of whether the email exists (enumeration prevention).',
      tags,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                identifier: z
                  .string()
                  .optional()
                  .describe(
                    'Optional primary identifier hint accepted for client compatibility. The response never includes account-specific credential hints.',
                  ),
              }),
            },
          },
          required: false,
        },
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({
                options: z
                  .unknown()
                  .describe(
                    'PublicKeyCredentialRequestOptionsJSON — pass to @simplewebauthn/browser startAuthentication().',
                  ),
                passkeyToken: z
                  .string()
                  .describe(
                    'Short-lived single-use challenge token (120s). Pass to POST /auth/passkey/login.',
                  ),
              }),
            },
          },
          description: 'WebAuthn authentication options.',
        },
        429: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Rate limit exceeded.',
        },
      },
    }),
    async c => {
      const ip = getClientIp(c);
      if (
        await runtime.rateLimit.trackAttempt(`passkey-login-options:${ip}`, {
          windowMs: 60 * 1000,
          max: 5,
        })
      ) {
        return errorResponse(c, 'Too many requests. Try again later.', 429);
      }

      const mfaConfig = getConfig().mfa;
      if (!mfaConfig?.webauthn) throw new Error('WebAuthn is not configured');
      const webauthnConfig = mfaConfig.webauthn;

      const { generateAuthenticationOptions } = await import('@simplewebauthn/server');
      const options = await generateAuthenticationOptions({
        rpID: webauthnConfig.rpId,
        userVerification: webauthnConfig.userVerification ?? 'required',
        timeout: webauthnConfig.timeout ?? 60000,
      });

      const passkeyToken = await createPasskeyLoginChallenge(
        runtime.repos.mfaChallenge,
        options.challenge,
      );
      return c.json({ options: options as unknown, passkeyToken }, 200);
    },
  );

  // ─── POST /auth/passkey/login ──────────────────────────────────────────────

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/passkey/login',
      summary: 'Complete passkey login',
      description:
        'Verifies the WebAuthn assertion and returns a session token. Satisfies both factors by default — no MFA prompt unless passkeyMfaBypass is disabled. Still enforces required email verification when emailVerification.required is enabled.',
      tags,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                passkeyToken: z.string().describe('Token from POST /auth/passkey/login-options.'),
                assertionResponse: z
                  .record(z.string(), z.unknown())
                  .describe(
                    'AuthenticationResponseJSON from @simplewebauthn/browser startAuthentication().',
                  ),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({
                token: z.string(),
                userId: z.string(),
                email: z.string().optional(),
                refreshToken: z.string().optional(),
                mfaRequired: z.boolean().optional(),
                mfaToken: z.string().optional(),
                mfaMethods: z.array(z.string()).optional(),
              }),
            },
          },
          description: 'Session token returned. Also set as HttpOnly cookie.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Authentication failed.',
        },
        429: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Rate limit exceeded.',
        },
      },
    }),
    async c => {
      const ip = getClientIp(c);
      if (
        await runtime.rateLimit.trackAttempt(`passkey-login:${ip}`, {
          windowMs: 15 * 60 * 1000,
          max: 10,
        })
      ) {
        return errorResponse(c, 'Too many requests. Try again later.', 429);
      }

      const { passkeyToken, assertionResponse } = c.req.valid('json');

      const metadata = {
        ipAddress: ip,
        userAgent: c.req.header('user-agent') ?? undefined,
      };

      const result = await AuthService.passkeyLogin(
        passkeyToken,
        assertionResponse,
        runtime,
        metadata,
        hookCtx(c),
      );

      if (!result.mfaRequired) {
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
      }

      return c.json(
        {
          token: result.token,
          userId: result.userId,
          email: result.email,
          refreshToken: result.refreshToken,
          mfaRequired: result.mfaRequired,
          mfaToken: result.mfaToken,
          mfaMethods: result.mfaMethods,
        },
        200,
      );
    },
  );

  return router;
};
