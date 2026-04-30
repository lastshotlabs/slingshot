import { setAuthCookie } from '@auth/lib/cookieOptions';
import { isProd } from '@auth/lib/env';
import { consumeMagicLinkToken, createMagicLinkToken } from '@auth/lib/magicLink';
import { refreshCsrfToken } from '@auth/middleware/csrf';
import { TokenResponse } from '@auth/schemas/auth';
import { ErrorResponse } from '@auth/schemas/error';
import { emitLoginSuccess, runPreLoginHook } from '@auth/services/auth';
import type { Context } from 'hono';
import { z } from 'zod';
import { createRoute, errorResponse } from '@lastshotlabs/slingshot-core';
import {
  COOKIE_REFRESH_TOKEN,
  COOKIE_TOKEN,
  createRouter,
  getClientIp,
} from '@lastshotlabs/slingshot-core';
import type { HookContext, MagicLinkConfig, RefreshTokenConfig } from '../config/authConfig';
import { publishAuthEvent } from '../eventGovernance';
import type { AuthRuntimeContext } from '../runtime';

export interface MagicLinkRouterOptions {
  magicLink: MagicLinkConfig;
  refreshTokens?: RefreshTokenConfig;
}

function createMagicLinkUrl(
  linkBaseUrl: string | undefined,
  token: string,
  tokenLocation: MagicLinkConfig['tokenLocation'] = 'fragment',
): string {
  if (!linkBaseUrl) return token;

  const url = new URL(linkBaseUrl);
  if (tokenLocation === 'query') {
    url.searchParams.set('token', token);
    return url.toString();
  }

  const encodedToken = encodeURIComponent(token);
  const existingHash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  if (!existingHash) {
    url.hash = `token=${encodedToken}`;
  } else if (existingHash.includes('?') || existingHash.includes('&')) {
    url.hash = `${existingHash}&token=${encodedToken}`;
  } else if (existingHash.includes('=') && !existingHash.startsWith('/')) {
    const params = new URLSearchParams(existingHash);
    params.set('token', token);
    url.hash = params.toString();
  } else {
    url.hash = `${existingHash}?token=${encodedToken}`;
  }

  return url.toString();
}

/**
 * Creates the magic-link authentication router.
 *
 * Mounted routes:
 * - `POST /auth/magic-link/request` — Send a single-use sign-in link to the user's inbox.
 * - `POST /auth/magic-link/verify`  — Consume the token from the link and create a session.
 *
 * @param options - Router configuration.
 * @param options.magicLink - Magic-link config, including `linkBaseUrl` (optional base URL
 *   used to form the full click-to-login URL), token placement, and TTL settings.
 * @param options.refreshTokens - Refresh-token config; controls whether a refresh-token
 *   cookie is issued alongside the access token.
 * @param runtime - The auth runtime context (adapter, event bus, repos, rate limiter, etc.).
 * @returns A Hono router with magic-link routes mounted.
 *
 * @throws {HttpError} 400 — Token is invalid or has expired.
 * @throws {HttpError} 403 — Account is suspended.
 * @throws {HttpError} 429 — Too many requests from this IP or for this identifier.
 *
 * @remarks
 * `POST /auth/magic-link/request` is enumeration-safe: it always returns 200 with the
 * same message regardless of whether the identifier is registered. Requests are
 * rate-limited by both client IP and submitted identifier to reduce inbox-flooding abuse.
 * Token creation and email delivery are performed asynchronously (fire-and-forget) so the
 * response time does not reveal account existence. The token is delivered via the
 * `auth:delivery.magic_link` event on the event bus. When `magicLink.linkBaseUrl` is set
 * the event payload includes the full clickable URL; otherwise only the raw token is included.
 * By default the URL puts the token in the fragment (`#token=...`) so the browser does not
 * send it to the web server in the request URL. Set `tokenLocation: 'query'` only for legacy
 * clients that still read `?token=...`.
 *
 * `POST /auth/magic-link/verify` runs the same `preLogin` lifecycle hook as password,
 * OAuth, SAML, and passkey logins before creating a session. For email-primary apps it
 * also promotes the account to `emailVerified=true` when the adapter supports persisted
 * verification state, matching concealed `verify-and-login`. Hook-based allowlists or
 * blocklists therefore apply uniformly to magic-link sign-in.
 *
 * @example
 * const router = createMagicLinkRouter(
 *   { magicLink: { linkBaseUrl: 'https://app.example.com/auth/verify' } },
 *   runtime,
 * );
 * app.route('/', router);
 */
export const createMagicLinkRouter = (
  { magicLink, refreshTokens }: MagicLinkRouterOptions,
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

  const magicLinkRequestOpts = { windowMs: 15 * 60 * 1000, max: 5 };
  const magicLinkVerifyOpts = { windowMs: 15 * 60 * 1000, max: 10 };

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/magic-link/request',
      summary: 'Request a magic link',
      description:
        "Sends a single-use magic link to the user's inbox. Always returns 200 regardless of whether the identifier is registered (enumeration-safe). Rate-limited by both IP and identifier.",
      tags,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                identifier: z
                  .string()
                  .describe(
                    'The primary identifier (email, username, or phone) to send the magic link to.',
                  ),
              }),
            },
          },
          description: 'Login identifier.',
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: z.object({ message: z.string() }) } },
          description: 'If an account exists, a sign-in link has been sent.',
        },
        429: {
          content: { 'application/json': { schema: ErrorResponse } },
          description:
            'Too many magic link requests from this IP or for this identifier. Try again later.',
        },
      },
    }),
    async c => {
      const ip = getClientIp(c);
      const { identifier } = c.req.valid('json');
      const ipLimited = await runtime.rateLimit.trackAttempt(
        `magic-link-request:ip:${ip}`,
        magicLinkRequestOpts,
      );
      const identifierLimited = await runtime.rateLimit.trackAttempt(
        `magic-link-request:identifier:${identifier.trim().toLowerCase()}`,
        magicLinkRequestOpts,
      );
      if (ipLimited || identifierLimited) {
        eventBus.emit('security.rate_limit.exceeded', { meta: { path: c.req.path } });
        return errorResponse(c, 'Too many requests. Try again later.', 429);
      }
      const msg = { message: 'If an account exists, a sign-in link has been sent.' };

      // Find user — enumeration-safe: same response regardless of existence
      const findFn = (id: string) =>
        adapter.findByIdentifier ? adapter.findByIdentifier(id) : adapter.findByEmail(id);
      const user = await findFn(identifier);

      if (user) {
        void (async () => {
          try {
            const ttl = getConfig().magicLink?.ttlSeconds ?? 900;
            const token = await createMagicLinkToken(runtime.repos.magicLink, user.id, ttl);
            const link = createMagicLinkUrl(magicLink.linkBaseUrl, token, magicLink.tokenLocation);
            publishAuthEvent(runtime.events, 'auth:delivery.magic_link', {
              identifier,
              token,
              link,
            });
          } catch (err) {
            console.error(
              '[magic-link] Failed to send magic link:',
              err instanceof Error ? err.message : String(err),
            );
          }
        })();
      }

      return c.json(msg, 200);
    },
  );

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/magic-link/verify',
      summary: 'Verify a magic link token',
      description:
        'Consumes a single-use magic link token and creates a session. Rate-limited by IP.',
      tags,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                token: z
                  .string()
                  .describe('Single-use magic link token received via the sign-in link.'),
              }),
            },
          },
          description: 'Magic link token.',
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: TokenResponse } },
          description: 'Authenticated. Returns a session token.',
        },
        400: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Invalid or expired magic link token.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Account suspended.',
        },
        429: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Too many attempts from this IP. Try again later.',
        },
      },
    }),
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`magic-link-verify:${ip}`, magicLinkVerifyOpts)) {
        eventBus.emit('security.rate_limit.exceeded', { meta: { path: c.req.path } });
        return errorResponse(c, 'Too many attempts. Try again later.', 429);
      }

      const { token } = c.req.valid('json');
      const userId = await consumeMagicLinkToken(runtime.repos.magicLink, token);
      if (!userId) {
        return errorResponse(c, 'Invalid or expired magic link token', 400);
      }

      // Check suspension before issuing session
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

      const fullUser = adapter.getUser ? await adapter.getUser(userId) : null;
      if (runtime.config.primaryField === 'email' && adapter.setEmailVerified) {
        await adapter.setEmailVerified(userId, true);
      }
      await runPreLoginHook(fullUser?.email ?? userId, runtime, hookCtx(c));

      const metadata = {
        ipAddress: ip !== 'unknown' ? ip : undefined,
        userAgent: c.req.header('user-agent') ?? undefined,
      };
      const { createSessionForUser } = await import('@auth/services/auth');
      const {
        token: sessionToken,
        refreshToken,
        sessionId,
      } = await createSessionForUser(userId, runtime, metadata, hookCtx(c));

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

      emitLoginSuccess(userId, sessionId, runtime);

      const emailVerified =
        runtime.config.primaryField === 'email' &&
        runtime.config.emailVerification &&
        adapter.getEmailVerified
          ? await adapter.getEmailVerified(userId)
          : undefined;
      const result = {
        token: sessionToken,
        userId,
        email: fullUser?.email,
        emailVerified,
        refreshToken,
      };
      return c.json(result, 200);
    },
  );

  return router;
};
