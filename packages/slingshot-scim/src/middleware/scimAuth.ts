import type { MiddlewareHandler } from 'hono';
import type { AuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HttpError, timingSafeEqual } from '@lastshotlabs/slingshot-core';

/**
 * Creates a Hono middleware that validates SCIM bearer tokens.
 *
 * Reads the `Authorization: Bearer <token>` header and checks it against the
 * list of tokens configured in `auth.scim.bearerTokens`. Comparison is performed
 * with `timingSafeEqual` to prevent timing-based side channels.
 *
 * @param runtime - The auth plugin's `AuthRuntimeContext`, used to read
 *   `config.scim.bearerTokens`.
 * @returns A Hono `MiddlewareHandler` that rejects unauthenticated requests.
 *
 * @throws {Error} At middleware mount time if `config.scim.bearerTokens` is empty or
 *   not configured — prevents silent deployment without authentication.
 * @throws {HttpError} 401 if the `Authorization` header is missing or does not start
 *   with `Bearer `.
 * @throws {HttpError} 401 if the provided token does not match any configured token.
 *
 * @example
 * ```ts
 * import { createScimAuth } from '@lastshotlabs/slingshot-scim/middleware';
 *
 * router.use('/scim/v2/*', createScimAuth(runtime));
 * ```
 */
export const createScimAuth =
  (runtime: AuthRuntimeContext): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const tokens = runtime.config.scim?.bearerTokens;
    const configuredTokens = (Array.isArray(tokens) ? tokens : tokens ? [tokens] : []).filter(
      token => token.length > 0,
    );
    if (configuredTokens.length === 0) {
      throw new Error(
        '[slingshot-scim] SCIM auth middleware mounted without configured bearer tokens',
      );
    }

    const authHeader = c.req.header('authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new HttpError(401, 'SCIM bearer token required');
    }

    const provided = authHeader.slice(7);
    const valid = configuredTokens.some(token => {
      try {
        return timingSafeEqual(provided, token);
      } catch {
        return false;
      }
    });

    if (!valid) {
      throw new HttpError(401, 'Invalid SCIM token');
    }

    await next();
  };
