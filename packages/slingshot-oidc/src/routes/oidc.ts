import { z } from 'zod';
import type { AuthResolvedConfig } from '@lastshotlabs/slingshot-auth';
import { createRoute } from '@lastshotlabs/slingshot-core';
import { HttpError, createRouter } from '@lastshotlabs/slingshot-core';
import { getJwks, isJwksLoaded } from '../lib/jwks';

const tags = ['OIDC'];

const ErrorResponse = z
  .object({ error: z.string().describe('Human-readable error message.') })
  .openapi('ErrorResponse');

function getReadyOidcConfig(config: AuthResolvedConfig) {
  if (!config.oidc) throw new HttpError(404, 'OIDC not configured');
  if (!isJwksLoaded(config)) {
    throw new HttpError(503, 'OIDC signing key is not loaded');
  }
  return config.oidc;
}

/**
 * Validates the response shape for `GET /.well-known/openid-configuration`.
 *
 * @remarks
 * Covers the minimum required fields of the OpenID Connect Discovery 1.0
 * specification (Section 3). `response_types_supported` is fixed to `['code']`
 * (authorization code flow only). `id_token_signing_alg_values_supported` is
 * fixed to `['RS256']`. `token_endpoint_auth_methods_supported` is fixed to
 * `['client_secret_post']`.
 */
const oidcDiscoveryResponseSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  response_types_supported: z.array(z.string()),
  subject_types_supported: z.array(z.string()),
  id_token_signing_alg_values_supported: z.array(z.string()),
  scopes_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()),
  claims_supported: z.array(z.string()),
});

/**
 * Validates the response shape for `GET /.well-known/jwks.json`.
 *
 * @remarks
 * Follows RFC 7517 (JSON Web Key). The array may contain multiple keys to
 * support key rotation. Each key object is expected to carry at minimum `kty`;
 * additional fields (`use`, `kid`, `alg`, `n`, `e`) are optional. `.passthrough()`
 * allows provider-specific fields (e.g. `x5c`, `x5t`) through without
 * validation errors.
 */
const jwksResponseSchema = z.object({
  keys: z.array(
    z.looseObject({
      kty: z.string(),
      use: z.string().optional(),
      kid: z.string().optional(),
      alg: z.string().optional(),
      n: z.string().optional(),
      e: z.string().optional(),
    }),
  ),
});

const oidcDiscoveryRoute = createRoute({
  method: 'get',
  path: '/.well-known/openid-configuration',
  summary: 'OpenID Connect discovery document',
  tags,
  responses: {
    200: {
      content: { 'application/json': { schema: oidcDiscoveryResponseSchema } },
      description: 'OIDC discovery document.',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'OIDC not configured.',
    },
    503: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'OIDC signing key is not loaded.',
    },
  },
});

const jwksRoute = createRoute({
  method: 'get',
  path: '/.well-known/jwks.json',
  summary: 'JSON Web Key Set',
  tags,
  responses: {
    200: {
      content: { 'application/json': { schema: jwksResponseSchema } },
      description: 'JWKS containing public signing keys.',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'OIDC not configured.',
    },
    503: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'OIDC signing key is not loaded.',
    },
  },
});

/**
 * Creates the Hono router that serves the OIDC discovery document and JWKS.
 *
 * Mounts:
 * - `GET /.well-known/openid-configuration` — standard OIDC discovery document
 *   containing issuer, endpoints, supported algorithms, and scopes.
 * - `GET /.well-known/jwks.json` — JSON Web Key Set with the RS256 public keys
 *   used to verify tokens issued by this server.
 *
 * @param config - The resolved auth configuration (`AuthResolvedConfig`). Must
 *   have `config.oidc` set and an OIDC signing key loaded. The handlers throw
 *   `HttpError(404)` when OIDC is absent and `HttpError(503)` when the signing
 *   key has not been loaded yet.
 * @returns A Hono router to be mounted at the app root.
 *
 * @remarks
 * This function is called internally by `createOidcPlugin`. Call it directly
 * only when composing a custom plugin.
 *
 * @example
 * ```ts
 * import { createOidcRouter } from '@lastshotlabs/slingshot-oidc';
 *
 * // Inside a custom plugin's setupRoutes:
 * const router = createOidcRouter(runtime.config);
 * app.route('/', router);
 * ```
 */
export function createOidcRouter(config: AuthResolvedConfig) {
  const router = createRouter();

  router.openapi(oidcDiscoveryRoute, c => {
    const oidc = getReadyOidcConfig(config);
    c.header('Cache-Control', 'public, max-age=86400');

    const issuer = oidc.issuer;
    const tokenEndpoint = oidc.tokenEndpoint ?? `${issuer}/oauth/token`;

    return c.json(
      {
        issuer,
        authorization_endpoint: oidc.authorizationEndpoint ?? `${issuer}/auth/oauth/authorize`,
        token_endpoint: tokenEndpoint,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: oidc.scopes ?? ['openid'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat'],
      },
      200,
    );
  });

  router.openapi(jwksRoute, c => {
    getReadyOidcConfig(config);
    c.header('Cache-Control', 'public, max-age=86400');
    return getJwks(config).then(jwks => c.json(jwks, 200));
  });

  return router;
}
