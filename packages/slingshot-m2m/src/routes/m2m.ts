import { z } from 'zod';
import { signToken } from '@lastshotlabs/slingshot-auth';
import type { AuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import { createRoute } from '@lastshotlabs/slingshot-core';
import { createRouter } from '@lastshotlabs/slingshot-core';
import { getClientIp } from '@lastshotlabs/slingshot-core';

const tags = ['M2M'];

/**
 * Rate-limit options for `POST /oauth/token`.
 * 30 requests per minute per client IP.
 */
const m2mTokenOpts = { windowMs: 60_000, max: 30 };
const m2mTokenClientOpts = { windowMs: 60_000, max: 10 };

/**
 * Validates the request body for `POST /oauth/token` (OAuth 2.0 client credentials grant).
 *
 * @remarks
 * Accepts both `application/json` and `application/x-www-form-urlencoded`
 * content types (RFC 6749 §4.4). `grant_type` must be `'client_credentials'`;
 * any other value is rejected with `unsupported_grant_type`. `scope` is a
 * space-delimited string of requested scopes — all requested scopes must be
 * present in the client's pre-approved `scopes` list or the request is
 * rejected with `invalid_scope`.
 */
const m2mTokenRequestSchema = z.object({
  grant_type: z.string().max(50),
  client_id: z.string().max(256),
  client_secret: z.string().max(512),
  scope: z.string().max(1024).optional(),
});

/**
 * Validates the JSON response body returned on a successful token issuance.
 *
 * @remarks
 * Follows RFC 6749 §5.1. `token_type` is always `'Bearer'`. `expires_in` is
 * the token lifetime in seconds (default 3600, configurable via
 * `config.m2m.tokenExpiry`). `scope` reflects the granted scopes as a
 * space-delimited string.
 */
const m2mTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int(),
  scope: z.string(),
});

/**
 * Validates the JSON error response body for RFC 6749 error responses.
 *
 * @remarks
 * Follows RFC 6749 §5.2. `error` is a machine-readable error code
 * (e.g. `'invalid_client'`, `'unsupported_grant_type'`, `'invalid_scope'`).
 * `error_description` is an optional human-readable explanation.
 */
const oauth2ErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

const m2mTokenRoute = createRoute({
  method: 'post',
  path: '/oauth/token',
  summary: 'OAuth 2.0 client_credentials grant',
  tags,
  request: {
    body: {
      content: {
        'application/json': { schema: m2mTokenRequestSchema },
        'application/x-www-form-urlencoded': { schema: m2mTokenRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: m2mTokenResponseSchema } },
      description: 'Token issued successfully.',
    },
    400: {
      content: { 'application/json': { schema: oauth2ErrorSchema } },
      description: 'Invalid request (RFC 6749 Section 5.2).',
    },
    401: {
      content: { 'application/json': { schema: oauth2ErrorSchema } },
      description: 'Invalid client credentials.',
    },
    429: {
      content: { 'application/json': { schema: oauth2ErrorSchema } },
      description: 'Rate limit exceeded.',
    },
  },
});

/**
 * Creates the Hono router that serves the M2M OAuth 2.0 token endpoint.
 *
 * Mounts a single route:
 * - `POST /oauth/token` — `client_credentials` grant; issues a signed JWT with
 *   the requested (or all allowed) scopes.
 *
 * Rate-limited to 30 requests per minute per IP. Both `application/json` and
 * `application/x-www-form-urlencoded` request bodies are accepted (RFC 6749).
 *
 * @param runtime - The `AuthRuntimeContext` obtained from `getAuthRuntimeContext`.
 *   Must have `runtime.config.m2m` set; throws during plugin setup otherwise.
 * @returns A Hono router to be mounted at the app root via `app.route('/', router)`.
 *
 * @remarks
 * This function is called internally by `createM2MPlugin`. You only need to
 * call it directly when building a custom plugin that composes the M2M router
 * manually.
 *
 * @example
 * ```ts
 * import { createM2MRouter } from '@lastshotlabs/slingshot-m2m';
 *
 * // Inside a custom plugin's setupRoutes:
 * const router = createM2MRouter(runtime);
 * app.route('/', router);
 * ```
 */
export function createM2MRouter(runtime: AuthRuntimeContext) {
  const { adapter, config } = runtime;
  const router = createRouter();

  router.openapi(
    m2mTokenRoute,
    async c => {
      const ip = getClientIp(c);
      if (await runtime.rateLimit.trackAttempt(`m2m-token:${ip}`, m2mTokenOpts)) {
        return c.json(
          {
            error: 'rate_limit_exceeded',
            error_description: 'Too many token requests. Try again later.',
          },
          429,
        );
      }

      // Handle both JSON and form-urlencoded bodies
      let body: Record<string, unknown>;
      const contentType = c.req.header('content-type') ?? '';
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const text = await c.req.text();
        const params = new URLSearchParams(text);
        body = {
          grant_type: params.get('grant_type') ?? undefined,
          client_id: params.get('client_id') ?? undefined,
          client_secret: params.get('client_secret') ?? undefined,
          scope: params.get('scope') ?? undefined,
        };
      } else {
        try {
          body = await c.req.json();
        } catch {
          // Request body is not valid JSON
          return c.json(
            { error: 'invalid_request', error_description: 'Invalid request body' },
            400,
          );
        }
      }

      const validated = m2mTokenRequestSchema.safeParse(body);
      if (!validated.success) {
        const detail = validated.error.issues
          .map(i => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        return c.json({ error: 'invalid_request', error_description: detail }, 400);
      }
      const {
        grant_type: grantType,
        client_id: clientId,
        client_secret: clientSecret,
        scope,
      } = validated.data;

      if (await runtime.rateLimit.trackAttempt(`m2m-token:${ip}:${clientId}`, m2mTokenClientOpts)) {
        return c.json(
          {
            error: 'rate_limit_exceeded',
            error_description: 'Too many token requests. Try again later.',
          },
          429,
        );
      }

      if (grantType !== 'client_credentials') {
        return c.json(
          { error: 'unsupported_grant_type', error_description: 'Unsupported grant type' },
          400,
        );
      }

      if (!adapter.getM2MClient) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'M2M client credentials not supported by auth adapter',
          },
          400,
        );
      }

      const client = await adapter.getM2MClient(clientId);
      const hashToVerify = client?.clientSecretHash ?? (await runtime.getDummyHash());
      const secretValid = await runtime.password.verify(clientSecret, hashToVerify);
      if (!client || !secretValid || !client.active) {
        return c.json(
          { error: 'invalid_client', error_description: 'Invalid client credentials' },
          401,
        );
      }

      const configuredScopes = config.m2m?.scopes;
      const enforceConfiguredScopes =
        Array.isArray(configuredScopes) && configuredScopes.length > 0;
      const clientScopes = Array.from(
        new Set(client.scopes.filter(scopeName => scopeName.length > 0)),
      );

      if (enforceConfiguredScopes) {
        const disallowedClientScopes = clientScopes.filter(
          scopeName => !configuredScopes.includes(scopeName),
        );
        if (disallowedClientScopes.length > 0) {
          return c.json(
            {
              error: 'invalid_scope',
              error_description:
                'Client is configured with scopes not allowed by server configuration',
            },
            400,
          );
        }
      }

      // Validate requested scopes against client and server allowlists
      let grantedScopes = clientScopes;
      if (scope) {
        const requested = Array.from(
          new Set(scope.split(' ').filter(scopeName => scopeName.length > 0)),
        );
        const invalid = requested.filter(scopeName => !clientScopes.includes(scopeName));
        if (invalid.length > 0) {
          return c.json(
            {
              error: 'invalid_scope',
              error_description: `Scope not allowed: ${invalid.join(', ')}`,
            },
            400,
          );
        }
        if (enforceConfiguredScopes) {
          const disallowedByServer = requested.filter(
            scopeName => !configuredScopes.includes(scopeName),
          );
          if (disallowedByServer.length > 0) {
            return c.json(
              {
                error: 'invalid_scope',
                error_description: `Scope not allowed by server configuration: ${disallowedByServer.join(', ')}`,
              },
              400,
            );
          }
        }
        grantedScopes = requested;
      }

      const expiry = config.m2m?.tokenExpiry ?? 3600;
      const token = await signToken(
        { sub: clientId, scope: grantedScopes.join(' ') },
        expiry,
        config,
        runtime.signing,
      );

      return c.json(
        {
          access_token: token,
          token_type: 'Bearer' as const,
          expires_in: expiry,
          scope: grantedScopes.join(' '),
        },
        200,
      );
    },
    (result, c) => {
      // Per-route validation hook: return RFC 6749 errors instead of standard Slingshot shape
      if (!result.success) {
        const detail = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        return c.json({ error: 'invalid_request', error_description: detail }, 400);
      }
    },
  );

  return router;
}
