import { z } from 'zod';
import { getAuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import type { AuthRateLimitConfig } from '@lastshotlabs/slingshot-auth';
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { emitPackageStabilityWarning, getPluginStateOrNull } from '@lastshotlabs/slingshot-core';
import { createOAuthRouter } from './routes/oauth';

/**
 * Options for `createOAuthPlugin`.
 *
 * All fields are optional - the plugin works out of the box with defaults.
 */
export type OAuthPluginOptions = {
  /**
   * URL or path to redirect the browser to after a successful OAuth login.
   * A `code` query parameter is appended (one-time auth code for token exchange)
   * and optionally a `user` parameter containing the user's email.
   * Default: `"/"`.
   */
  postRedirect?: string;
  /**
   * Absolute URL origins or exact absolute URLs allowed for `postRedirect`.
   * Relative paths are always allowed. When omitted, absolute redirects are rejected.
   */
  allowedRedirectUrls?: string[];
  /**
   * Rate-limit overrides for OAuth-specific endpoints (e.g. the unlink route).
   * Falls back to sensible built-in defaults when not provided.
   *
   * @remarks
   * Rate limiting is applied per IP address to the OAuth callback endpoint
   * (`GET /auth/:provider/callback`) and the state-validation step during the
   * OAuth flow. This guards against callback replay and state-guessing attacks.
   * Other OAuth routes (login initiation, exchange, link, unlink, reauth) may
   * also be subject to the configured limits depending on the
   * `AuthRateLimitConfig` shape.
   */
  rateLimit?: AuthRateLimitConfig;
};

const absoluteHttpUrlSchema = z
  .string()
  .url()
  .refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  }, 'Expected an absolute HTTP(S) URL');

const redirectTargetSchema = z
  .string()
  .min(1)
  .refine(value => {
    if (value.startsWith('/') && !value.startsWith('//')) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Expected a relative path or absolute HTTP(S) URL');

export const oauthPluginConfigSchema = z
  .object({
    postRedirect: redirectTargetSchema.optional(),
    allowedRedirectUrls: z.array(absoluteHttpUrlSchema).optional(),
    rateLimit: z.custom<AuthRateLimitConfig>(v => v == null || typeof v === 'object').optional(),
  })
  .loose();

function isRelativeRedirect(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

function isAllowedAbsoluteRedirect(value: string, allowedRedirectUrls: readonly string[]): boolean {
  const target = new URL(value);
  return allowedRedirectUrls.some(entry => {
    const allowed = new URL(entry);
    if (allowed.origin !== target.origin) return false;
    const allowedIsOriginOnly = allowed.pathname === '/' && !allowed.search && !allowed.hash;
    if (allowedIsOriginOnly) return true;
    return allowed.href === target.href;
  });
}

function validatePostRedirect(postRedirect: string, allowedRedirectUrls: readonly string[]): void {
  const parsed = redirectTargetSchema.safeParse(postRedirect);
  if (!parsed.success) {
    throw new Error(`[slingshot-oauth] Invalid postRedirect: ${parsed.error.issues[0]?.message}`);
  }
  if (isRelativeRedirect(postRedirect)) return;
  if (allowedRedirectUrls.length === 0) {
    throw new Error(
      '[slingshot-oauth] Absolute postRedirect values require allowedRedirectUrls to be configured.',
    );
  }
  if (!isAllowedAbsoluteRedirect(postRedirect, allowedRedirectUrls)) {
    throw new Error(
      `[slingshot-oauth] postRedirect '${postRedirect}' is not allowed by allowedRedirectUrls.`,
    );
  }
}

/**
 * Creates the Slingshot social OAuth login plugin.
 *
 * Automatically mounts OAuth login, callback, and account-link routes for every
 * provider configured in `slingshot-auth` (`auth.oauth.providers`). If no
 * providers are configured, the plugin is a no-op and mounts no routes.
 *
 * Mounted routes (one set per provider, e.g. `github`):
 * - `POST /auth/:provider`                 - redirect to the provider's auth page
 * - `GET  /auth/:provider/callback`        - handle the OAuth callback
 * - `POST /auth/oauth/exchange`            - exchange a one-time code for a session token
 * - `POST /auth/:provider/link`            - initiate provider linking for the signed-in user
 * - `DELETE /auth/:provider/link`          - disconnect a social provider from the account
 * - `POST /auth/:provider/reauth`          - re-authenticate before unlink (if MFA required)
 * - `POST /auth/oauth/:provider/reauth/confirm` - confirm re-authentication
 *
 * Public OAuth login initiation, provider linking, and OAuth re-auth initiation
 * all use `POST` routes so the standard CSRF middleware can protect
 * cookie-authenticated browsers and anonymous login boundaries. Legacy
 * `GET /auth/:provider`, `GET /auth/:provider/link`, and
 * `GET /auth/:provider/reauth` initiators are not mounted.
 *
 * @param options - Optional configuration (redirect target, rate-limit overrides).
 * @returns A `SlingshotPlugin` to pass to `createApp()` / `createServer()`.
 *
 * @remarks
 * Requires `slingshot-auth` to be registered first (listed in `dependencies`).
 *
 * When no OAuth providers are configured in `slingshot-auth` (`auth.oauth.providers`
 * is empty or absent), `setupRoutes` returns immediately without mounting any routes.
 * Any attempt to reach an OAuth route will result in a 404 from the underlying router -
 * the plugin does not mount 501 stubs in this case.
 *
 * @example
 * ```ts
 * import { createOAuthPlugin } from '@lastshotlabs/slingshot-oauth';
 *
 * const app = await createApp({
 *   plugins: [
 *     authPlugin,
 *     createOAuthPlugin({ postRedirect: '/dashboard' }),
 *   ],
 * });
 * ```
 */
export function createOAuthPlugin(options?: OAuthPluginOptions): SlingshotPlugin {
  const resolvedOptions = oauthPluginConfigSchema.parse(options ?? {}) as OAuthPluginOptions;

  emitPackageStabilityWarning(
    '@lastshotlabs/slingshot-oauth',
    'experimental',
    'Use the next channel until the social login surface is promoted to stable.',
  );

  return {
    name: 'slingshot-oauth',
    dependencies: ['slingshot-auth'],

    setupRoutes({ app }: PluginSetupContext) {
      const runtime = getAuthRuntimeContext(getPluginStateOrNull(app));
      const providers = Object.keys(runtime.oauth.providers);
      if (providers.length === 0) return;

      const postRedirect = resolvedOptions.postRedirect ?? runtime.config.oauthPostRedirect ?? '/';
      const allowedRedirectUrls =
        resolvedOptions.allowedRedirectUrls ?? runtime.config.oauthAllowedRedirectUrls;
      validatePostRedirect(postRedirect, allowedRedirectUrls);
      app.route(
        '/',
        createOAuthRouter(
          providers,
          postRedirect,
          runtime,
          resolvedOptions.rateLimit ?? runtime.config.rateLimit,
        ),
      );
    },
  };
}
