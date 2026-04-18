import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from '@lastshotlabs/slingshot-core';
import type { BearerAuthClient, BearerAuthConfig } from '../config/authConfig';

/**
 * Builds a bearer-token authentication middleware from the provided config.
 *
 * Supports three forms of bearer auth:
 * - **Static secret** (`string`): a single shared token. All callers must present this exact
 *   token. No `clientId` is set on the context.
 * - **Rotating secrets** (`string[]`): multiple valid tokens, any of which grants access
 *   (useful for secret rotation — deploy new + old simultaneously). No `clientId` is set.
 * - **Named clients** (`BearerAuthClient[]`): each entry has a `clientId`, `token`, and
 *   optional `revoked` flag. On match, `bearerClientId` is set on the Hono context so
 *   downstream handlers can identify the caller. Revoked entries are skipped entirely.
 *
 * All token comparisons use `timingSafeEqual` to prevent timing-oracle attacks.
 * Config is required — there is no `process.env` or fallback resolution.
 *
 * @param config - Bearer auth configuration: a single token string, an array of token strings,
 *   or an array of `BearerAuthClient` objects with per-client revocation support.
 * @returns A Hono `MiddlewareHandler` that returns `401 Unauthorized` when the
 *   `Authorization: Bearer <token>` header is absent, malformed, or unrecognized, and
 *   calls `next()` on success.
 *
 * @throws Never throws — unrecognized tokens produce a `401` JSON response, not an exception.
 *
 * @example
 * // Static secret
 * app.use('/api/*', createBearerAuth('super-secret-key'));
 *
 * @example
 * // Rotating secrets — both old and new token are valid during the rotation window
 * app.use('/api/*', createBearerAuth(['new-secret', 'old-secret']));
 *
 * @example
 * // Named clients — downstream handlers can read c.get('bearerClientId')
 * app.use('/api/*', createBearerAuth([
 *   { clientId: 'service-a', token: 'token-a' },
 *   { clientId: 'service-b', token: 'token-b', revoked: false },
 *   { clientId: 'legacy',    token: 'old-token', revoked: true }, // blocked
 * ]));
 */
export function createBearerAuth(config: BearerAuthConfig): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (typeof config === 'string') {
      // Single string — direct comparison
      if (!timingSafeEqual(token, config)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
      return;
    }

    if (config.length === 0) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Determine if this is string[] or BearerAuthClient[]
    if (typeof config[0] === 'string') {
      // string[] — check all tokens
      const tokens = config as string[];
      const matched = tokens.some(t => timingSafeEqual(token, t));
      if (!matched) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
      return;
    }

    // BearerAuthClient[] — check non-revoked clients
    const clients = config as BearerAuthClient[];
    let matchedClient: BearerAuthClient | null = null;

    for (const client of clients) {
      if (client.revoked) continue;
      if (timingSafeEqual(token, client.token)) {
        matchedClient = client;
        break;
      }
    }

    if (!matchedClient) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('bearerClientId', matchedClient.clientId);
    await next();
  };
}
