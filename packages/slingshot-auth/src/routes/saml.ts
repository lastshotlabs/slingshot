import { setAuthCookie } from '@auth/lib/cookieOptions';
import { isProd } from '@auth/lib/env';
import { consumeSamlRequestId, storeSamlRequestId } from '@auth/lib/samlRequestId';
import { ErrorResponse } from '@auth/schemas/error';
import {
  assertLoginEmailVerified,
  createSessionForUser,
  emitLoginSuccess,
  runPreLoginHook,
} from '@auth/services/auth';
import type { Context } from 'hono';
import { z } from 'zod';
import { createRoute } from '@lastshotlabs/slingshot-core';
import { HttpError, bestEffort, createRouter } from '@lastshotlabs/slingshot-core';
import { COOKIE_TOKEN } from '@lastshotlabs/slingshot-core';
import { getClientIp } from '@lastshotlabs/slingshot-core';
import type { HookContext } from '../config/authConfig';
import type { AuthRuntimeContext } from '../runtime';

const tags = ['SAML'];

const samlLoginOpts = { windowMs: 15 * 60 * 1000, max: 20 }; // 20/15min for login initiation
const samlAcsOpts = { windowMs: 15 * 60 * 1000, max: 20 }; // 20/15min for ACS

/** Validate redirect URL is safe (relative path only, no open redirect) */
function isSafeRedirect(url: string): boolean {
  if (!url.startsWith('/')) return false;
  if (url.startsWith('//')) return false;
  if (url.includes('://')) return false;
  return true;
}

const hookCtx = (c: Context): HookContext => ({
  ip: getClientIp(c) !== 'unknown' ? getClientIp(c) : undefined,
  userAgent: c.req.header('user-agent') ?? undefined,
  requestId: c.get('requestId') as string | undefined,
});

const samlLoginRoute = createRoute({
  method: 'post',
  path: '/auth/saml/login',
  summary: 'Initiate SAML SSO login',
  description: 'Redirects to the SAML Identity Provider for authentication.',
  tags,
  request: {
    query: z.object({
      redirect: z.string().optional(),
    }),
  },
  responses: {
    302: { description: 'Redirect to SAML Identity Provider' },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'SAML not configured.',
    },
    429: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Rate limit exceeded.',
    },
  },
});

const samlAcsRoute = createRoute({
  method: 'post',
  path: '/auth/saml/acs',
  summary: 'SAML Assertion Consumer Service',
  description:
    'Receives SAML assertion from the IdP, enforces the same login policy boundary as other auth methods, creates a session, and redirects to the app.',
  tags,
  request: {
    body: {
      content: {
        'application/x-www-form-urlencoded': {
          schema: z.object({
            SAMLResponse: z.string(),
            RelayState: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    302: { description: 'Redirect to app after successful authentication' },
    400: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Invalid SAML response.',
    },
    401: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'SAML assertion validation failed.',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'SAML not configured.',
    },
    429: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Rate limit exceeded.',
    },
  },
});

const samlMetadataRoute = createRoute({
  method: 'get',
  path: '/auth/saml/metadata',
  summary: 'SAML SP metadata',
  description: 'Returns SAML Service Provider metadata XML for IdP configuration.',
  tags,
  responses: {
    200: {
      content: { 'application/xml': { schema: z.string() } },
      description: 'SAML SP metadata XML.',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'SAML not configured.',
    },
  },
});

/**
 * Creates the SAML 2.0 SSO router.
 *
 * Mounted routes:
 * - `POST /auth/saml/login`    - Initiate SAML SSO; redirects the browser to the configured
 *                                Identity Provider (IdP) with a signed `AuthnRequest`.
 * - `POST /auth/saml/acs`      - Assertion Consumer Service; receives the SAML assertion
 *                                posted back by the IdP, validates it, creates a session,
 *                                and redirects to the app.
 * - `GET  /auth/saml/metadata` - Serve the Service Provider (SP) metadata XML for IdP
 *                                configuration.
 *
 * @param runtime - The auth runtime context. `runtime.config.saml` must be set with a
 *   valid SAML configuration (IdP entry-point URL, issuer, certificate, etc.).
 * @param samlImpl - Optional pre-imported SAML implementation module. When omitted,
 *   `@auth/lib/saml` is dynamically imported at request time (lazy load). Providing
 *   the module explicitly is useful in tests to inject a mock.
 * @returns A Hono router with SAML routes mounted.
 *
 * @throws {HttpError} 404 - SAML is not configured (`runtime.config.saml` is null).
 * @throws {HttpError} 400 - Missing or unparseable `SAMLResponse` in the ACS POST body.
 * @throws {HttpError} 401 - SAML assertion validation failed, or the `InResponseTo` ID
 *   does not match a stored request (anti-replay).
 * @throws {HttpError} 429 - Rate limit exceeded on login initiation or ACS.
 *
 * @remarks
 * **HTTPS required in production.** SAML IdPs typically require the ACS URL to be served
 * over HTTPS. Running over plain HTTP will cause signature validation failures with most
 * IdPs in non-development environments.
 *
 * The relay state is stored in the OAuth state store (reusing the `codeVerifier` slot to
 * carry the post-login redirect URL). A successful ACS assertion creates a standard
 * authenticated session, but it does not automatically satisfy local step-up/MFA freshness
 * requirements because the assertion alone does not guarantee Slingshot's required auth context.
 *
 * The `redirect` query parameter on the login route is validated to be a relative path
 * only (no `//` or `://`) to prevent open-redirect attacks. SAML login initiation uses
 * `POST` so the standard CSRF middleware can protect anonymous browser login boundaries;
 * the legacy `GET /auth/saml/login` initiator is not mounted.
 *
 * @example
 * const router = createSamlRouter(runtime);
 * app.route('/', router);
 */
export function createSamlRouter(
  runtime: AuthRuntimeContext,
  samlImpl?: typeof import('@auth/lib/saml'),
) {
  const { adapter } = runtime;
  const getConfig = () => runtime.config;
  const storeOAuthState = (state: string, codeVerifier?: string, linkUserId?: string) =>
    runtime.oauth.stateStore.store(state, codeVerifier, linkUserId);
  const consumeOAuthState = (state: string) => runtime.oauth.stateStore.consume(state);
  const loadSaml = samlImpl ? () => Promise.resolve(samlImpl) : () => import('@auth/lib/saml');
  const router = createRouter();

  // POST /auth/saml/login - initiate SAML login, redirect to IdP
  router.openapi(samlLoginRoute, async c => {
    const ip = getClientIp(c);
    if (await runtime.rateLimit.trackAttempt(`saml-login:${ip}`, samlLoginOpts)) {
      throw new HttpError(429, 'Too many SAML login attempts. Try again later.');
    }

    const config = getConfig().saml;
    if (!config) throw new HttpError(404, 'SAML not configured');

    const { initSaml, createAuthnRequest } = await loadSaml();
    const { sp, idp } = await initSaml(config);

    // Store relay state - use codeVerifier slot to carry redirectUrl.
    const relayState = crypto.randomUUID();
    const rawRedirect = c.req.valid('query').redirect ?? config.postLoginRedirect ?? '/';
    const redirectAfter = isSafeRedirect(rawRedirect) ? rawRedirect : '/';
    await storeOAuthState(relayState, redirectAfter);

    const { redirectUrl, id: requestId } = createAuthnRequest(sp, idp);
    if (!runtime.repos.samlRequestId)
      throw new HttpError(500, 'SAML request ID store not configured');
    await storeSamlRequestId(runtime.repos.samlRequestId, requestId);
    return c.redirect(`${redirectUrl}&RelayState=${encodeURIComponent(relayState)}`);
  });

  // POST /auth/saml/acs - handle SAML assertion from IdP
  // Note: We keep manual formData() parsing here because @hono/zod-openapi's
  // form-urlencoded validation consumes the body before the handler can access it
  // reliably with SAML IdP payloads. The route definition documents the schema for OpenAPI.
  router.openapi(samlAcsRoute, async c => {
    const ip = getClientIp(c);
    if (await runtime.rateLimit.trackAttempt(`saml-acs:${ip}`, samlAcsOpts)) {
      throw new HttpError(429, 'Too many SAML assertions. Try again later.');
    }

    const config = getConfig().saml;
    if (!config) throw new HttpError(404, 'SAML not configured');

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      throw new HttpError(400, 'Invalid SAML response');
    }

    const samlResponse = formData.get('SAMLResponse') as string | null;
    const relayState = formData.get('RelayState') as string | null;

    if (!samlResponse) throw new HttpError(400, 'Missing SAMLResponse');

    const { initSaml, validateSamlResponse, samlProfileToIdentityProfile } = await loadSaml();
    const { sp, idp } = await initSaml(config);

    // Extract InResponseTo from the SAML response - required for anti-replay validation.
    let inResponseTo: string;
    try {
      const xml = Buffer.from(samlResponse, 'base64').toString('utf-8');
      const match = xml.match(/InResponseTo="([^"]+)"/);
      if (!match?.[1]) throw new Error('Missing InResponseTo');
      inResponseTo = match[1];
    } catch {
      throw new HttpError(400, 'SAML response missing required InResponseTo attribute');
    }

    if (!runtime.repos.samlRequestId)
      throw new HttpError(500, 'SAML request ID store not configured');

    let samlProfile;
    try {
      samlProfile = await validateSamlResponse(sp, idp, samlResponse, config, inResponseTo);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(401, 'Invalid SAML assertion');
    }

    // Consume the request ID only after assertion validation. Invalid forged
    // callbacks must not burn a legitimate pending login attempt.
    const valid = await consumeSamlRequestId(runtime.repos.samlRequestId, inResponseTo);
    if (!valid) throw new HttpError(401, 'Invalid or replayed SAML response');

    const loginContext = hookCtx(c);
    await runPreLoginHook(samlProfile.email ?? samlProfile.nameId, runtime, loginContext);

    let userId: string;
    if (config.onLogin) {
      const result = await config.onLogin(samlProfile);
      userId = result.userId;
    } else {
      if (!adapter.findOrCreateByProvider) {
        throw new HttpError(500, 'Auth adapter missing findOrCreateByProvider');
      }

      const profile = samlProfileToIdentityProfile(samlProfile);
      const result = await adapter.findOrCreateByProvider('saml', samlProfile.nameId, profile);
      userId = result.id;

      // Update profile fields from SAML attributes.
      if (adapter.updateProfile && (profile.firstName || profile.lastName || profile.displayName)) {
        bestEffort(adapter.updateProfile(userId, profile), '[saml-profile-update]');
      }
    }

    await assertLoginEmailVerified(userId, runtime);

    const { token, sessionId } = await createSessionForUser(
      userId,
      runtime,
      undefined,
      loginContext,
    );

    emitLoginSuccess(userId, sessionId, runtime);

    // consumeOAuthState returns { codeVerifier?, linkUserId? } - redirectUrl was stored in codeVerifier.
    const rawRedirectUrl = relayState
      ? ((await consumeOAuthState(relayState))?.codeVerifier ?? config.postLoginRedirect ?? '/')
      : (config.postLoginRedirect ?? '/');
    const redirectUrl = isSafeRedirect(rawRedirectUrl) ? rawRedirectUrl : '/';

    setAuthCookie(c, COOKIE_TOKEN, token, isProd(), runtime.config);
    return c.redirect(redirectUrl);
  });

  // GET /auth/saml/metadata - serve SP metadata XML
  router.openapi(samlMetadataRoute, async c => {
    const config = getConfig().saml;
    if (!config) throw new HttpError(404, 'SAML not configured');

    const { initSaml, getSamlSpMetadata } = await loadSaml();
    const { sp } = await initSaml(config);

    const metadata = getSamlSpMetadata(sp);
    return c.body(metadata, 200, { 'Content-Type': 'application/xml' });
  });

  return router;
}
