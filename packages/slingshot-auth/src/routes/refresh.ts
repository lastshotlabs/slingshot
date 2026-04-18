import { readAuthCookie, setAuthCookie } from '@auth/lib/cookieOptions';
import { isProd } from '@auth/lib/env';
import { ErrorResponse } from '@auth/schemas/error';
import * as AuthService from '@auth/services/auth';
import { z } from 'zod';
import { createRoute, errorResponse } from '@lastshotlabs/slingshot-core';
import {
  COOKIE_REFRESH_TOKEN,
  COOKIE_TOKEN,
  HEADER_REFRESH_TOKEN,
  createRouter,
  getClientIp,
} from '@lastshotlabs/slingshot-core';
import type { RefreshTokenConfig } from '../config/authConfig';
import type { AuthRuntimeContext } from '../runtime';

export interface RefreshRouterOptions {
  refreshTokens: RefreshTokenConfig;
}

/**
 * Creates the token refresh router.
 *
 * Mounted routes:
 * - `POST /auth/refresh` — Exchange a valid refresh token for a new access token and a
 *                          rotated refresh token.
 *
 * @param options - Router configuration.
 * @param options.refreshTokens - Refresh-token config (TTLs, rotation settings).
 * @param runtime - The auth runtime context (repos, rate limiter, config, etc.).
 * @returns A Hono router with the refresh route mounted.
 *
 * @throws {HttpError} 401 — Refresh token is missing, invalid, expired, or the session has
 *   been invalidated by token-theft detection.
 * @throws {HttpError} 403 — The account is suspended or blocked by required email verification.
 * @throws {HttpError} 429 — Too many refresh attempts from this IP.
 *
 * @remarks
 * Token rotation semantics: each successful refresh issues a fresh access token and a new
 * refresh token. The previous refresh token remains valid for a short grace window
 * (configurable via `refreshTokens.graceWindowSeconds`, default ~30 s) to tolerate network
 * retries and concurrent requests. If a token that was already rotated is presented after
 * the grace window expires, the entire session is immediately invalidated as a
 * token-theft countermeasure.
 *
 * The refresh token may be supplied via three mechanisms (checked in order):
 * 1. JSON body field `refreshToken`.
 * 2. Cookie `refresh_token`.
 * 3. `x-refresh-token` request header.
 *
 * @example
 * const router = createRefreshRouter(
 *   { refreshTokens: { accessTokenExpiry: 900, refreshTokenExpiry: 2_592_000 } },
 *   runtime,
 * );
 * app.route('/', router);
 */
export const createRefreshRouter = (
  _options: RefreshRouterOptions,
  runtime: AuthRuntimeContext,
) => {
  const getConfig = () => runtime.config;
  const router = createRouter();
  const tags = ['Auth'];

  const RefreshResponse = z
    .object({
      token: z.string().describe('New short-lived JWT access token.'),
      userId: z.string().describe('Unique user ID.'),
    })
    .openapi('RefreshResponse');

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/refresh',
      summary: 'Refresh access token',
      description:
        'Exchanges a valid refresh token for a new access token and rotated refresh token. The old refresh token remains valid for a short grace window to handle network drops. If a previously rotated token is reused after the grace window, the entire session is invalidated (token theft detection).',
      tags,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                refreshToken: z
                  .string()
                  .optional()
                  .describe(
                    'Refresh token. Can also be sent via the refresh_token cookie or x-refresh-token header.',
                  ),
              }),
            },
          },
          description: 'Refresh token (optional if sent via cookie or header).',
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: RefreshResponse } },
          description: 'New access and refresh tokens.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description:
            'Invalid or expired refresh token, or session invalidated due to token theft detection.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description:
            'Refresh denied because the account is suspended or email verification is required.',
        },
        429: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Too many refresh attempts. Try again later.',
        },
      },
    }),
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`refresh:ip:${ip}`, { max: 30, windowMs: 60_000 })) {
        return errorResponse(c, 'Too many refresh attempts. Try again later.', 429);
      }
      const body = c.req.valid('json');
      const cfg = getConfig();
      const rt =
        body.refreshToken ??
        readAuthCookie(c, COOKIE_REFRESH_TOKEN, isProd(), cfg) ??
        c.req.header(HEADER_REFRESH_TOKEN) ??
        null;
      if (!rt) {
        return errorResponse(c, 'Refresh token is required', 401);
      }
      const result = await AuthService.refresh(rt, runtime, {
        ipAddress: ip,
        userAgent: c.req.header('user-agent') ?? undefined,
      });
      setAuthCookie(
        c,
        COOKIE_TOKEN,
        result.token,
        isProd(),
        cfg,
        cfg.refreshToken?.accessTokenExpiry ?? 900,
      );
      setAuthCookie(
        c,
        COOKIE_REFRESH_TOKEN,
        result.refreshToken,
        isProd(),
        cfg,
        cfg.refreshToken?.refreshTokenExpiry ?? 2_592_000,
      );
      return c.json(result, 200);
    },
  );

  return router;
};
