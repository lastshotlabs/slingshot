import type { MiddlewareHandler } from 'hono';
import { getAuthRuntimeFromRequestOrNull } from '@lastshotlabs/slingshot-auth';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HttpError, getActor } from '@lastshotlabs/slingshot-core';

/**
 * Hono middleware factory that enforces OAuth 2.0 scope requirements on a route.
 *
 * Only machine-to-machine access tokens are eligible: the actor must have
 * `kind: 'service-account'` as resolved by the `identify` middleware from
 * `slingshot-auth`. The middleware then reads the `scope` claim from
 * `tokenPayload`. All `requiredScopes` must be present in the space-delimited
 * scope string; if any is missing the request is rejected.
 *
 * @param requiredScopes - One or more scope strings that the token must contain.
 * @returns A Hono `MiddlewareHandler` that rejects requests missing any
 *   required scope.
 *
 * @throws {HttpError} 401 if the actor is anonymous (unauthenticated).
 * @throws {HttpError} 403 with code `M2M_REQUIRED` if the actor is not a
 *   service-account (i.e., not an M2M token).
 * @throws {HttpError} 403 with code `INSUFFICIENT_SCOPE` if the token is
 *   missing the `scope` claim or does not include all required scopes.
 *
 * @remarks
 * The `scope` claim is parsed as a space-delimited string per OAuth 2.0 RFC 6749 §3.3.
 * Each token in the space-separated list is treated as a distinct granted scope.
 * The token must contain **all** of the `requiredScopes` — partial matches are
 * rejected. For example, a token with `scope: "read:invoices write:invoices"` satisfies
 * `requireScope('read:invoices', 'write:invoices')` but not `requireScope('admin')`.
 *
 * @example
 * ```ts
 * import { requireScope } from '@lastshotlabs/slingshot-m2m';
 *
 * router.get('/reports', requireScope('read:reports'), handler);
 * router.post('/data', requireScope('write:data', 'admin'), handler);
 * ```
 */
export const requireScope =
  (...requiredScopes: string[]): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const actor = getActor(c);
    if (actor.kind === 'anonymous') {
      throw new HttpError(401, 'Authentication required');
    }
    if (actor.kind !== 'service-account') {
      throw new HttpError(403, 'M2M token required', 'M2M_REQUIRED');
    }
    // Read raw JWT payload for scope verification
    const payload = c.get('tokenPayload') as Record<string, unknown> | undefined;
    if (!payload) {
      throw new HttpError(403, 'Insufficient scope', 'INSUFFICIENT_SCOPE');
    }

    const rawScope = payload.scope;
    if (!rawScope || typeof rawScope !== 'string') {
      throw new HttpError(403, 'Insufficient scope', 'INSUFFICIENT_SCOPE');
    }

    const grantedScopes = rawScope.split(' ').filter(scope => scope.length > 0);
    for (const required of requiredScopes) {
      if (!grantedScopes.includes(required)) {
        throw new HttpError(403, 'Insufficient scope', 'INSUFFICIENT_SCOPE');
      }
    }

    const runtime = getAuthRuntimeFromRequestOrNull(c);
    const shouldRecheckClient = runtime?.config.m2m?.recheckClientOnUse !== false;
    if (shouldRecheckClient) {
      if (!runtime?.adapter.getM2MClient || !actor.id) {
        throw new HttpError(403, 'M2M client verification unavailable', 'M2M_CLIENT_UNVERIFIED');
      }
      const client = await runtime.adapter.getM2MClient(actor.id);
      if (!client?.active) {
        throw new HttpError(401, 'M2M client is disabled', 'M2M_CLIENT_INACTIVE');
      }
      const clientScopes = new Set(client.scopes);
      if (grantedScopes.some(scope => !clientScopes.has(scope))) {
        throw new HttpError(403, 'Insufficient scope', 'INSUFFICIENT_SCOPE');
      }
      const configuredScopes = runtime.config.m2m?.scopes;
      if (Array.isArray(configuredScopes) && configuredScopes.length > 0) {
        const serverScopes = new Set(configuredScopes);
        if (grantedScopes.some(scope => !serverScopes.has(scope))) {
          throw new HttpError(403, 'Insufficient scope', 'INSUFFICIENT_SCOPE');
        }
      }
    }

    await next();
  };
