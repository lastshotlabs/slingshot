import { decodeIdToken } from 'arctic';
import type { Context } from 'hono';
import { z } from 'zod';
import { generateCodeVerifier, generateState, userAuth } from '@lastshotlabs/slingshot-auth';
import { ErrorResponse as OAuthErrorResponse } from '@lastshotlabs/slingshot-auth';
import type { AuthRuntimeContext, HookContext } from '@lastshotlabs/slingshot-auth';
import {
  assertLoginEmailVerified,
  consumeOAuthCode,
  consumeReauthConfirmation,
  createSessionForUser,
  emitLoginSuccess,
  getSuspended,
  isProd,
  refreshCsrfToken,
  runPreLoginHook,
  setAuthCookie,
  storeOAuthCode,
  storeReauthConfirmation,
  verifyAnyFactor,
} from '@lastshotlabs/slingshot-auth/plugin';
import { createRoute, errorResponse, withSecurity } from '@lastshotlabs/slingshot-core';
import { createRouter, getActor } from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { COOKIE_REFRESH_TOKEN, COOKIE_TOKEN } from '@lastshotlabs/slingshot-core';
import { getClientIp } from '@lastshotlabs/slingshot-core';

/**
 * Builds a `HookContext` from a Hono context for use with auth lifecycle hooks.
 *
 * Extracts the client IP, `User-Agent`, and `requestId` from the current request.
 * When the IP is `'unknown'` (e.g. behind a misconfigured proxy), it is omitted.
 *
 * @param c - The Hono request context.
 * @returns A `HookContext` suitable for `runPreLoginHook` and related hook helpers.
 */
const hookCtx = (c: Context<AppEnv>): HookContext => ({
  ip: getClientIp(c) !== 'unknown' ? getClientIp(c) : undefined,
  userAgent: c.req.header('user-agent') ?? undefined,
  requestId: c.get('requestId') as string | undefined,
});

const tags = ['OAuth'];

/** Returns the authenticated user's ID, or throws 401 if anonymous. */
const requireUserId = (c: Context<AppEnv>): string => {
  const actor = getActor(c);
  if (actor.kind !== 'user' || !actor.id)
    throw new HttpError(401, 'Authenticated user required');
  return actor.id;
};

/** Returns the authenticated session ID, or throws 401 if absent. */
const requireSessionId = (c: Context<AppEnv>): string => {
  const actor = getActor(c);
  if (!actor.sessionId) throw new HttpError(401, 'Missing sessionId');
  return actor.sessionId;
};

const requireCodeVerifier = (
  codeVerifier: string | undefined,
  message = 'Invalid or expired state',
): string => {
  if (!codeVerifier) {
    throw new HttpError(400, message);
  }
  return codeVerifier;
};

function appendRedirectParams(base: string, params: Record<string, string | undefined>): string {
  try {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    const entries = Object.entries(params).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    });
    if (entries.length === 0) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}${entries
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&')}`;
  }
}

function publicOAuthErrorCode(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401) return 'authentication_required';
    if (err.status === 403) return 'access_denied';
    if (err.status >= 500) return 'server_error';
  }
  return 'authentication_failed';
}

// `postLoginRedirect` is sourced from server-side config (passed into
// `createOAuthRouter` at startup) and is never derived from OAuth callback query
// parameters. `createOAuthPlugin` validates this value against the configured
// allowlist before this router is mounted.
/**
 * Completes an OAuth login flow after the provider callback has been validated.
 *
 * Runs the pre-login hook, finds or creates the user via `findOrCreateByProvider`,
 * creates a session, stores a one-time authorization code in the OAuth code repo,
 * and redirects to `postLoginRedirect?code=<code>`. On any error, redirects to
 * `postLoginRedirect?error=<public-code>` instead of returning a 4xx/5xx.
 *
 * @param c - The Hono request context for the callback route.
 * @param runtime - The auth runtime context providing adapter, config, and repos.
 * @param provider - OAuth provider name (e.g. `'github'`, `'google'`).
 * @param providerId - The user's unique ID at the OAuth provider.
 * @param profile - Minimal profile data extracted from the provider's token response.
 * @param postLoginRedirect - The server-configured redirect target. Never derived
 *   from user input — no allowlist validation is required.
 * @returns A Hono redirect response.
 *
 * @remarks
 * `preLogin` is run before `findOrCreateByProvider` so that allowlist/blocklist
 * hooks apply uniformly to both new and returning OAuth users. `preRegister` is
 * intentionally not called — by the time `user.created` is known the record already
 * exists, so it cannot gate registration. Required email verification is also
 * enforced before any OAuth session is minted, so social login cannot bypass the
 * same email-verification gate used by password and passkey auth.
 */
const finishOAuth = async (
  c: Context<AppEnv>,
  runtime: AuthRuntimeContext,
  provider: string,
  providerId: string,
  profile: { email?: string; name?: string; avatarUrl?: string },
  postLoginRedirect: string,
) => {
  const { adapter, config } = runtime;
  if (!adapter.findOrCreateByProvider) {
    return errorResponse(c, 'Auth adapter does not support social login', 500);
  }

  const identifier = profile.email ?? providerId;
  const ctx = hookCtx(c);

  try {
    // Fire preLogin before the adapter so OAuth users are subject to the same
    // access control as email/password users (fixes: #30).
    // preLogin runs for all OAuth sign-ins (new and returning) — a single hook
    // covers the allowlist case. preRegister is intentionally omitted: by the
    // time we know if user.created is true, the record already exists, so it
    // cannot gate registration. preLogin is the correct and sufficient gate.
    await runPreLoginHook(identifier, runtime, ctx);

    const user = await adapter.findOrCreateByProvider(provider, providerId, profile);

    if (user.created) {
      const role = config.defaultRole;
      if (role && adapter.setRoles) await adapter.setRoles(user.id, [role]);
    }

    await assertLoginEmailVerified(user.id, runtime);

    const metadata = {
      ipAddress: getClientIp(c),
      userAgent: c.req.header('user-agent') ?? undefined,
    };
    const session = await createSessionForUser(user.id, runtime, metadata, ctx);
    const { token, refreshToken: refreshTokenValue, sessionId } = session;

    emitLoginSuccess(user.id, sessionId, runtime);

    // Store a one-time authorization code instead of exposing the token in the redirect URL.
    // The client exchanges this code via POST /auth/oauth/exchange to get the session token.
    const code = await storeOAuthCode(
      runtime.repos.oauthCode,
      {
        token,
        userId: user.id,
        email: profile.email,
        refreshToken: refreshTokenValue,
      },
      runtime.dataEncryptionKeys,
    );

    try {
      const url = new URL(postLoginRedirect);
      url.searchParams.set('code', code);
      if (profile.email) url.searchParams.set('user', profile.email);
      return c.redirect(url.toString());
    } catch {
      // Relative path fallback
      const sep = postLoginRedirect.includes('?') ? '&' : '?';
      const userParam = profile.email ? `&user=${encodeURIComponent(profile.email)}` : '';
      return c.redirect(`${postLoginRedirect}${sep}code=${code}${userParam}`);
    }
  } catch (err) {
    return c.redirect(appendRedirectParams(postLoginRedirect, { error: publicOAuthErrorCode(err) }));
  }
};

/**
 * Creates the Hono router that serves all social OAuth login routes.
 *
 * Mounts the following routes for each entry in `providers`:
 * - `POST /auth/:provider`                      — redirect to provider auth page
 * - `GET  /auth/oauth/:provider/callback`       — handle the OAuth callback
 * - `POST /auth/oauth/exchange`                 — exchange one-time code → session token
 * - `POST /auth/oauth/:provider/unlink`         — disconnect social provider from account
 * - `POST /auth/oauth/:provider/reauth`         — initiate re-auth before unlink
 * - `POST /auth/oauth/:provider/reauth/confirm` — confirm re-auth
 *
 * Actual mounted provider paths use `/auth/:provider` for login initiation,
 * callbacks, linking, unlinking, and re-auth initiation. The `/auth/oauth/*`
 * prefix is only used for the one-time code exchange and re-auth confirmation
 * endpoints.
 *
 * On successful login the user is redirected to `postLoginRedirect` with a
 * `code` query parameter. The client must then `POST /auth/oauth/exchange` to
 * convert the code into a session token (avoids tokens in redirect URLs).
 *
 * Public OAuth login initiation, provider linking, and OAuth re-auth initiation
 * all use `POST` routes so the standard CSRF middleware can protect
 * cookie-authenticated browsers and anonymous login boundaries. Legacy
 * `GET /auth/:provider`, `GET /auth/:provider/link`, and
 * `GET /auth/:provider/reauth` initiators are not mounted.
 *
 * Session-bound provider linking, unlinking, and OAuth re-auth routes also fail
 * closed with `403` when the account is suspended or when required email
 * verification is no longer satisfied. This keeps stale sessions from mutating
 * linked-identity state or minting new re-auth proofs.
 *
 * @param providers - List of provider names (e.g. `['github', 'google']`).
 * @param postLoginRedirect - Server-side redirect target after login. Never
 *   derived from user input — no allowlist check is required.
 * @param runtime - Auth runtime context from `getAuthRuntimeContext`.
 * @param rateLimit - Optional rate-limit overrides for the unlink endpoint.
 * @returns A Hono router to be mounted at the app root.
 *
 * @remarks
 * This function is called internally by `createOAuthPlugin`. Call it directly
 * only when composing a custom plugin.
 *
 * @example
 * ```ts
 * import { createOAuthRouter } from '@lastshotlabs/slingshot-oauth';
 *
 * // Inside a custom plugin's setupRoutes:
 * const router = createOAuthRouter(['github'], '/dashboard', runtime);
 * app.route('/', router);
 * ```
 */
export const createOAuthRouter = (
  providers: string[],
  postLoginRedirect: string,
  runtime: AuthRuntimeContext,
  rateLimit?: import('@lastshotlabs/slingshot-auth').AuthRateLimitConfig,
) => {
  const { adapter, eventBus } = runtime;
  /**
   * Rate-limit options for all OAuth provider unlink endpoints
   * (`DELETE /auth/:provider/link`).
   *
   * Defaults to 5 requests per 60-minute window per user ID. Both the window
   * and the ceiling are overridable via the `rateLimit.oauthUnlink` config
   * field passed to `createOAuthRouter`. The limit is keyed by `userId` (not
   * IP) so the constraint follows the authenticated user across different IPs.
   */
  const oauthUnlinkOpts = {
    windowMs: rateLimit?.oauthUnlink?.windowMs ?? 60 * 60 * 1000,
    max: rateLimit?.oauthUnlink?.max ?? 5,
  };
  const getConfig = () => runtime.config;

  /**
   * Validates the optional request body for OAuth provider unlink endpoints
   * (`DELETE /auth/:provider/link`).
   *
   * @remarks
   * When the account has a password or MFA methods configured, at least one
   * verification credential must be supplied. The `method` field defaults to
   * `'password'` if `password` is present, `'totp'` if `code` is present, or
   * must be explicit for `emailOtp`, `webauthn`, and `recovery` flows.
   * `reauthToken` is required for `emailOtp` and `webauthn` methods.
   * `webauthnResponse` carries the full WebAuthn assertion object.
   */
  const unlinkVerificationSchema = z.object({
    method: z
      .enum(['totp', 'emailOtp', 'webauthn', 'password', 'recovery'])
      .optional()
      .describe('Verification method to use.'),
    code: z.string().optional().describe('TOTP code, email OTP code, or recovery code.'),
    password: z.string().optional().describe('Account password.'),
    reauthToken: z
      .string()
      .optional()
      .describe('Reauth challenge token (required for emailOtp and webauthn methods).'),
    webauthnResponse: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('WebAuthn assertion response (required for webauthn method).'),
  });

  type UnlinkVerificationBody = z.infer<typeof unlinkVerificationSchema>;

  /**
   * Verifies the user's identity before allowing an OAuth provider to be unlinked.
   *
   * Returns `null` when verification passes (or is not required because the user
   * has no password and no MFA methods). Returns an error descriptor with the
   * appropriate HTTP status when verification fails or credentials are missing.
   *
   * @param userId - The authenticated user's ID.
   * @param sessionId - The current session ID (used by some MFA verification paths).
   * @param body - The verification credentials from the unlink request body.
   * @returns `null` on success, or `{ error, status }` describing the failure.
   */
  async function verifyUnlinkFactor(
    userId: string,
    sessionId: string,
    body: UnlinkVerificationBody,
  ): Promise<{ error: string; status: 400 | 401 } | null> {
    const hasPassword = adapter.hasPassword ? await adapter.hasPassword(userId) : false;
    const mfaMethods =
      getConfig().mfa && adapter.getMfaMethods ? await adapter.getMfaMethods(userId) : [];
    if (!hasPassword && mfaMethods.length === 0) return null;

    const method = body.method ?? (body.password ? 'password' : body.code ? 'totp' : undefined);
    if (!method) {
      return {
        error: 'Verification is required to unlink this provider. Provide method and credentials.',
        status: 400,
      };
    }

    const valid = await verifyAnyFactor(userId, sessionId, runtime, {
      method,
      code: body.code,
      password: body.password,
      reauthToken: body.reauthToken,
      webauthnResponse: body.webauthnResponse as object | undefined,
    });
    if (!valid) return { error: 'Invalid verification', status: 401 };
    return null;
  }

  const assertSensitiveOauthMutationAllowed = async (c: Context<AppEnv>, userId: string) => {
    const suspensionStatus = await getSuspended(adapter, userId);
    if (suspensionStatus.suspended) {
      eventBus.emit('security.auth.login.blocked', {
        userId,
        reason: 'suspended',
        meta: { reason: 'suspended' },
      });
      return errorResponse(c, 'Account suspended', 403);
    }

    try {
      await assertLoginEmailVerified(userId, runtime);
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        return errorResponse(c, err.message, 403);
      }
      throw err;
    }

    return null;
  };

  const oauthProviders = runtime.oauth.providers;
  const oauthStateStore = runtime.oauth.stateStore;
  const router = createRouter();

  /**
   * Persists an OAuth state token (with optional PKCE code verifier and link user ID)
   * to the state store for validation during the callback.
   */
  const storeOAuthState = (state: string, codeVerifier?: string, linkUserId?: string) =>
    oauthStateStore.store(state, codeVerifier, linkUserId);

  /**
   * Consumes and removes an OAuth state token from the store.
   * Returns the stored metadata (code verifier, link user ID) or `null` if not found.
   */
  const consumeOAuthState = (state: string) => oauthStateStore.consume(state);

  const encodeOAuthLinkContext = (userId: string, sessionId: string): string =>
    `link:${encodeURIComponent(userId)}:${encodeURIComponent(sessionId)}`;

  const parseOAuthLinkContext = (
    value: string | undefined,
  ): { userId: string; sessionId: string } | null => {
    if (!value?.startsWith('link:')) return null;
    const [encodedUserId, encodedSessionId] = value.slice('link:'.length).split(':');
    if (!encodedUserId || !encodedSessionId) return null;
    return {
      userId: decodeURIComponent(encodedUserId),
      sessionId: decodeURIComponent(encodedSessionId),
    };
  };

  const finishProviderLink = async (
    c: Context<AppEnv>,
    storedLinkUserId: string | undefined,
    provider: string,
    providerUserId: string,
  ) => {
    const link = parseOAuthLinkContext(storedLinkUserId);
    if (!link) return null;
    const actor = getActor(c);
    if (actor.kind !== 'user' || actor.id !== link.userId || actor.sessionId !== link.sessionId) {
      return errorResponse(c, 'Authenticated session does not match OAuth link request', 401);
    }
    const blocked = await assertSensitiveOauthMutationAllowed(c, link.userId);
    if (blocked) return blocked;
    if (!adapter.linkProvider)
      return errorResponse(c, 'Auth adapter does not support linkProvider', 500);
    await adapter.linkProvider(link.userId, provider, providerUserId);
    eventBus.emit('security.auth.oauth.linked', {
      userId: link.userId,
      meta: { provider },
    });
    const sep = postLoginRedirect.includes('?') ? '&' : '?';
    return c.redirect(`${postLoginRedirect}${sep}linked=${encodeURIComponent(provider)}`);
  };

  /** Returns the Google Arctic provider, throwing if not configured. */
  const getGoogle = () => {
    if (!oauthProviders.google) throw new Error('Google OAuth not configured');
    return oauthProviders.google;
  };
  /** Returns the Apple Arctic provider, throwing if not configured. */
  const getApple = () => {
    if (!oauthProviders.apple) throw new Error('Apple OAuth not configured');
    return oauthProviders.apple;
  };
  /** Returns the Microsoft Entra ID Arctic provider, throwing if not configured. */
  const getMicrosoft = () => {
    if (!oauthProviders.microsoft) throw new Error('Microsoft Entra ID OAuth not configured');
    return oauthProviders.microsoft;
  };
  /** Returns the GitHub Arctic provider, throwing if not configured. */
  const getGitHub = () => {
    if (!oauthProviders.github) throw new Error('GitHub OAuth not configured');
    return oauthProviders.github;
  };
  /** Returns the LinkedIn Arctic provider, throwing if not configured. */
  const getLinkedIn = () => {
    if (!oauthProviders.linkedin) throw new Error('LinkedIn OAuth not configured');
    return oauthProviders.linkedin;
  };
  /** Returns the Twitter Arctic provider, throwing if not configured. */
  const getTwitter = () => {
    if (!oauthProviders.twitter) throw new Error('Twitter OAuth not configured');
    return oauthProviders.twitter;
  };
  /** Returns the GitLab Arctic provider, throwing if not configured. */
  const getGitLab = () => {
    if (!oauthProviders.gitlab) throw new Error('GitLab OAuth not configured');
    return oauthProviders.gitlab;
  };
  /** Returns the Slack Arctic provider, throwing if not configured. */
  const getSlack = () => {
    if (!oauthProviders.slack) throw new Error('Slack OAuth not configured');
    return oauthProviders.slack;
  };
  /** Returns the Bitbucket Arctic provider, throwing if not configured. */
  const getBitbucket = () => {
    if (!oauthProviders.bitbucket) throw new Error('Bitbucket OAuth not configured');
    return oauthProviders.bitbucket;
  };

  // ─── Google ───────────────────────────────────────────────────────────────
  if (providers.includes('google')) {
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/google',
        summary: 'Initiate Google OAuth',
        description:
          "Redirects the user to Google's consent screen to begin the OAuth login flow. After the user authorizes, Google redirects back to `/auth/google/callback`.",
        tags,
        responses: {
          302: { description: "Redirect to Google's OAuth consent screen." },
          500: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'OAuth provider not configured.',
          },
        },
      }),
      async c => {
        const state = generateState();
        const codeVerifier = generateCodeVerifier();
        await storeOAuthState(state, codeVerifier);
        const url = getGoogle().createAuthorizationURL(state, codeVerifier, [
          'openid',
          'profile',
          'email',
        ]);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      createRoute({
        method: 'get',
        path: '/auth/google/callback',
        summary: 'Google OAuth callback',
        description:
          'Handles the redirect from Google after user authorization. Validates the OAuth state and code, then creates or finds the user account. Sets a session cookie and redirects to the configured post-login URL.',
        tags,
        request: {
          query: z.object({
            code: z.string().describe('Authorization code from Google.'),
            state: z.string().describe('OAuth state parameter for CSRF protection.'),
          }),
        },
        responses: {
          302: { description: 'Redirect to the post-login URL with session token.' },
          400: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'Invalid callback parameters or expired state.',
          },
          403: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description:
              'Account is suspended or must verify its email before provider linking can complete.',
          },
        },
      }),
      async c => {
        const { code, state } = c.req.valid('query');
        if (!code || !state) return errorResponse(c, 'Invalid callback', 400);

        const stored = await consumeOAuthState(state);
        if (!stored?.codeVerifier) return errorResponse(c, 'Invalid or expired state', 400);

        const tokens = await getGoogle().validateAuthorizationCode(code, stored.codeVerifier);
        const info = (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${tokens.accessToken()}` },
        }).then(r => r.json())) as { sub: string; email?: string; name?: string; picture?: string };

        const linkResponse = await finishProviderLink(c, stored.linkUserId, 'google', info.sub);
        if (linkResponse) return linkResponse;
        if (stored.linkUserId) return errorResponse(c, 'Invalid or expired state', 400);

        return finishOAuth(
          c,
          runtime,
          'google',
          info.sub,
          { email: info.email, name: info.name, avatarUrl: info.picture },
          postLoginRedirect,
        );
      },
    );

    router.use('/auth/google/link', userAuth);

    router.openapi(
      withSecurity(
        createRoute({
          method: 'post',
          path: '/auth/google/link',
          summary: 'Link Google account',
          description:
            "Initiates an OAuth flow to link a Google account to the authenticated user. Requires a valid session. Redirects to Google's consent screen.",
          tags,
          responses: {
            302: { description: "Redirect to Google's OAuth consent screen." },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider linking can begin.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const state = generateState();
        const codeVerifier = generateCodeVerifier();
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        await storeOAuthState(state, codeVerifier, encodeOAuthLinkContext(userId, sessionId));
        const url = getGoogle().createAuthorizationURL(state, codeVerifier, [
          'openid',
          'profile',
          'email',
        ]);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      withSecurity(
        createRoute({
          method: 'delete',
          path: '/auth/google/link',
          summary: 'Unlink Google account',
          description:
            'Removes the linked Google OAuth account from the authenticated user. Requires a valid session and factor verification when the account has a password or MFA enabled.',
          tags,
          request: {
            body: {
              required: false,
              content: { 'application/json': { schema: unlinkVerificationSchema } },
              description:
                'Factor verification (required when the account has a password or MFA enabled).',
            },
          },
          responses: {
            204: { description: 'Google account unlinked successfully.' },
            400: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Verification is required but not provided.',
            },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session or invalid verification.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider unlinking is allowed.',
            },
            429: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Too many unlink attempts. Try again later.',
            },
            500: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Auth adapter does not support unlinkProvider.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        if (!adapter.unlinkProvider) {
          return errorResponse(c, 'Auth adapter does not support unlinkProvider', 500);
        }
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        if (await runtime.rateLimit.trackAttempt(`oauth-unlink:${userId}`, oauthUnlinkOpts)) {
          return errorResponse(c, 'Too many unlink attempts. Try again later.', 429);
        }
        const body = c.req.valid('json');
        const unlinkErr = await verifyUnlinkFactor(userId, sessionId, body);
        if (unlinkErr) return errorResponse(c, unlinkErr.error, unlinkErr.status);
        await adapter.unlinkProvider(userId, 'google');
        eventBus.emit('security.auth.oauth.unlinked', { userId, meta: { provider: 'google' } });
        return c.body(null, 204);
      },
    );
  }

  // ─── Apple ────────────────────────────────────────────────────────────────
  if (providers.includes('apple')) {
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/apple',
        summary: 'Initiate Apple OAuth',
        description:
          "Redirects the user to Apple's sign-in page to begin the OAuth login flow. After the user authorizes, Apple posts back to `/auth/apple/callback`.",
        tags,
        responses: {
          302: { description: "Redirect to Apple's OAuth sign-in page." },
          500: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'OAuth provider not configured.',
          },
        },
      }),
      async c => {
        const state = generateState();
        await storeOAuthState(state);
        const url = getApple().createAuthorizationURL(state, ['name', 'email']);
        return c.redirect(url.toString());
      },
    );

    // Apple sends a POST with form data to the callback URL
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/apple/callback',
        summary: 'Apple OAuth callback',
        description:
          'Handles the POST redirect from Apple after user authorization. Apple sends form-encoded data containing the authorization code and state. Validates the OAuth state, exchanges the code for tokens, then creates or finds the user account. Sets a session cookie and redirects to the configured post-login URL.',
        tags,
        responses: {
          302: { description: 'Redirect to the post-login URL with session token.' },
          400: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'Invalid callback parameters or expired state.',
          },
          403: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description:
              'Account is suspended or must verify its email before provider linking can complete.',
          },
        },
      }),
      async c => {
        const form = await c.req.formData();
        const code = form.get('code') as string | null;
        const state = form.get('state') as string | null;
        if (!code || !state) return errorResponse(c, 'Invalid callback', 400);

        const stored = await consumeOAuthState(state);
        if (!stored) return errorResponse(c, 'Invalid or expired state', 400);

        const tokens = await getApple().validateAuthorizationCode(code);
        const claims = decodeIdToken(tokens.idToken()) as { sub: string; email?: string };

        const linkResponse = await finishProviderLink(c, stored.linkUserId, 'apple', claims.sub);
        if (linkResponse) return linkResponse;
        if (stored.linkUserId) return errorResponse(c, 'Invalid or expired state', 400);

        // Apple only sends name on the very first sign-in
        const userJSON = form.get('user') as string | null;
        const userInfo = userJSON
          ? (JSON.parse(userJSON) as { name?: { firstName?: string; lastName?: string } })
          : {};
        const name = userInfo.name
          ? `${userInfo.name.firstName ?? ''} ${userInfo.name.lastName ?? ''}`.trim() || undefined
          : undefined;

        return finishOAuth(
          c,
          runtime,
          'apple',
          claims.sub,
          { email: claims.email, name },
          postLoginRedirect,
        );
      },
    );

    router.use('/auth/apple/link', userAuth);

    router.openapi(
      withSecurity(
        createRoute({
          method: 'post',
          path: '/auth/apple/link',
          summary: 'Link Apple account',
          description:
            "Initiates an OAuth flow to link an Apple account to the authenticated user. Requires a valid session. Redirects to Apple's sign-in page.",
          tags,
          responses: {
            302: { description: "Redirect to Apple's OAuth sign-in page." },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider linking can begin.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const state = generateState();
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        await storeOAuthState(state, undefined, encodeOAuthLinkContext(userId, sessionId));
        const url = getApple().createAuthorizationURL(state, ['name', 'email']);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      withSecurity(
        createRoute({
          method: 'delete',
          path: '/auth/apple/link',
          summary: 'Unlink Apple account',
          description:
            'Removes the linked Apple OAuth account from the authenticated user. Requires a valid session and factor verification when the account has a password or MFA enabled.',
          tags,
          request: {
            body: {
              required: false,
              content: { 'application/json': { schema: unlinkVerificationSchema } },
              description:
                'Factor verification (required when the account has a password or MFA enabled).',
            },
          },
          responses: {
            204: { description: 'Apple account unlinked successfully.' },
            400: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Verification is required but not provided.',
            },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session or invalid verification.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider unlinking is allowed.',
            },
            429: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Too many unlink attempts. Try again later.',
            },
            500: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Auth adapter does not support unlinkProvider.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        if (!adapter.unlinkProvider) {
          return errorResponse(c, 'Auth adapter does not support unlinkProvider', 500);
        }
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        if (await runtime.rateLimit.trackAttempt(`oauth-unlink:${userId}`, oauthUnlinkOpts)) {
          return errorResponse(c, 'Too many unlink attempts. Try again later.', 429);
        }
        const body = c.req.valid('json');
        const unlinkErr = await verifyUnlinkFactor(userId, sessionId, body);
        if (unlinkErr) return errorResponse(c, unlinkErr.error, unlinkErr.status);
        await adapter.unlinkProvider(userId, 'apple');
        eventBus.emit('security.auth.oauth.unlinked', { userId, meta: { provider: 'apple' } });
        return c.body(null, 204);
      },
    );
  }

  // ─── Microsoft ──────────────────────────────────────────────────────────
  if (providers.includes('microsoft')) {
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/microsoft',
        summary: 'Initiate Microsoft OAuth',
        description:
          "Redirects the user to Microsoft's sign-in page to begin the OAuth login flow. After the user authorizes, Microsoft redirects back to `/auth/microsoft/callback`.",
        tags,
        responses: {
          302: { description: "Redirect to Microsoft's OAuth sign-in page." },
          500: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'OAuth provider not configured.',
          },
        },
      }),
      async c => {
        const state = generateState();
        const codeVerifier = generateCodeVerifier();
        await storeOAuthState(state, codeVerifier);
        const url = getMicrosoft().createAuthorizationURL(state, codeVerifier, [
          'openid',
          'profile',
          'email',
        ]);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      createRoute({
        method: 'get',
        path: '/auth/microsoft/callback',
        summary: 'Microsoft OAuth callback',
        description:
          'Handles the redirect from Microsoft after user authorization. Validates the OAuth state and code, then creates or finds the user account. Sets a session cookie and redirects to the configured post-login URL.',
        tags,
        request: {
          query: z.object({
            code: z.string().describe('Authorization code from Microsoft.'),
            state: z.string().describe('OAuth state parameter for CSRF protection.'),
          }),
        },
        responses: {
          302: { description: 'Redirect to the post-login URL with session token.' },
          400: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'Invalid callback parameters or expired state.',
          },
          403: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description:
              'Account is suspended or must verify its email before provider linking can complete.',
          },
        },
      }),
      async c => {
        const { code, state } = c.req.valid('query');
        if (!code || !state) return errorResponse(c, 'Invalid callback', 400);

        const stored = await consumeOAuthState(state);
        if (!stored?.codeVerifier) return errorResponse(c, 'Invalid or expired state', 400);

        const tokens = await getMicrosoft().validateAuthorizationCode(code, stored.codeVerifier);
        const info = (await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${tokens.accessToken()}` },
        }).then(r => r.json())) as {
          id: string;
          displayName?: string;
          mail?: string;
          userPrincipalName?: string;
        };

        const linkResponse = await finishProviderLink(c, stored.linkUserId, 'microsoft', info.id);
        if (linkResponse) return linkResponse;
        if (stored.linkUserId) return errorResponse(c, 'Invalid or expired state', 400);

        return finishOAuth(
          c,
          runtime,
          'microsoft',
          info.id,
          { email: info.mail ?? info.userPrincipalName, name: info.displayName },
          postLoginRedirect,
        );
      },
    );

    router.use('/auth/microsoft/link', userAuth);

    router.openapi(
      withSecurity(
        createRoute({
          method: 'post',
          path: '/auth/microsoft/link',
          summary: 'Link Microsoft account',
          description:
            "Initiates an OAuth flow to link a Microsoft account to the authenticated user. Requires a valid session. Redirects to Microsoft's sign-in page.",
          tags,
          responses: {
            302: { description: "Redirect to Microsoft's OAuth sign-in page." },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider linking can begin.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const state = generateState();
        const codeVerifier = generateCodeVerifier();
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        await storeOAuthState(state, codeVerifier, encodeOAuthLinkContext(userId, sessionId));
        const url = getMicrosoft().createAuthorizationURL(state, codeVerifier, [
          'openid',
          'profile',
          'email',
        ]);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      withSecurity(
        createRoute({
          method: 'delete',
          path: '/auth/microsoft/link',
          summary: 'Unlink Microsoft account',
          description:
            'Removes the linked Microsoft OAuth account from the authenticated user. Requires a valid session and factor verification when the account has a password or MFA enabled.',
          tags,
          request: {
            body: {
              required: false,
              content: { 'application/json': { schema: unlinkVerificationSchema } },
              description:
                'Factor verification (required when the account has a password or MFA enabled).',
            },
          },
          responses: {
            204: { description: 'Microsoft account unlinked successfully.' },
            400: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Verification is required but not provided.',
            },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session or invalid verification.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider unlinking is allowed.',
            },
            429: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Too many unlink attempts. Try again later.',
            },
            500: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Auth adapter does not support unlinkProvider.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        if (!adapter.unlinkProvider) {
          return errorResponse(c, 'Auth adapter does not support unlinkProvider', 500);
        }
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        if (await runtime.rateLimit.trackAttempt(`oauth-unlink:${userId}`, oauthUnlinkOpts)) {
          return errorResponse(c, 'Too many unlink attempts. Try again later.', 429);
        }
        const body = c.req.valid('json');
        const unlinkErr = await verifyUnlinkFactor(userId, sessionId, body);
        if (unlinkErr) return errorResponse(c, unlinkErr.error, unlinkErr.status);
        await adapter.unlinkProvider(userId, 'microsoft');
        eventBus.emit('security.auth.oauth.unlinked', { userId, meta: { provider: 'microsoft' } });
        return c.body(null, 204);
      },
    );
  }

  // ─── GitHub ────────────────────────────────────────────────────────────
  if (providers.includes('github')) {
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/github',
        summary: 'Initiate GitHub OAuth',
        description:
          "Redirects the user to GitHub's authorization page to begin the OAuth login flow. After the user authorizes, GitHub redirects back to `/auth/github/callback`.",
        tags,
        responses: {
          302: { description: "Redirect to GitHub's OAuth authorization page." },
          500: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'OAuth provider not configured.',
          },
        },
      }),
      async c => {
        const state = generateState();
        await storeOAuthState(state);
        const url = getGitHub().createAuthorizationURL(state, ['read:user', 'user:email']);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      createRoute({
        method: 'get',
        path: '/auth/github/callback',
        summary: 'GitHub OAuth callback',
        description:
          'Handles the redirect from GitHub after user authorization. Validates the OAuth state and code, then creates or finds the user account. Sets a session cookie and redirects to the configured post-login URL.',
        tags,
        request: {
          query: z.object({
            code: z.string().describe('Authorization code from GitHub.'),
            state: z.string().describe('OAuth state parameter for CSRF protection.'),
          }),
        },
        responses: {
          302: { description: 'Redirect to the post-login URL with session token.' },
          400: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'Invalid callback parameters or expired state.',
          },
          403: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description:
              'Account is suspended or must verify its email before provider linking can complete.',
          },
        },
      }),
      async c => {
        const { code, state } = c.req.valid('query');
        if (!code || !state) return errorResponse(c, 'Invalid callback', 400);

        const stored = await consumeOAuthState(state);
        if (!stored) return errorResponse(c, 'Invalid or expired state', 400);

        const tokens = await getGitHub().validateAuthorizationCode(code);
        const headers = {
          Authorization: `Bearer ${tokens.accessToken()}`,
          'User-Agent': 'slingshot',
        };

        const info = (await fetch('https://api.github.com/user', { headers }).then(r =>
          r.json(),
        )) as { id: number; login: string; name?: string; avatar_url?: string; email?: string };

        // GitHub may not return email on /user if it's private — fetch from /user/emails
        let email = info.email;
        if (!email) {
          const emails = (await fetch('https://api.github.com/user/emails', { headers }).then(r =>
            r.json(),
          )) as { email: string; primary: boolean; verified: boolean }[];
          email =
            emails.find(e => e.primary && e.verified)?.email ?? emails.find(e => e.verified)?.email;
        }

        const linkResponse = await finishProviderLink(c, stored.linkUserId, 'github', String(info.id));
        if (linkResponse) return linkResponse;
        if (stored.linkUserId) return errorResponse(c, 'Invalid or expired state', 400);

        return finishOAuth(
          c,
          runtime,
          'github',
          String(info.id),
          { email, name: info.name, avatarUrl: info.avatar_url },
          postLoginRedirect,
        );
      },
    );

    router.use('/auth/github/link', userAuth);

    router.openapi(
      withSecurity(
        createRoute({
          method: 'post',
          path: '/auth/github/link',
          summary: 'Link GitHub account',
          description:
            "Initiates an OAuth flow to link a GitHub account to the authenticated user. Requires a valid session. Redirects to GitHub's authorization page.",
          tags,
          responses: {
            302: { description: "Redirect to GitHub's OAuth authorization page." },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider linking can begin.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const state = generateState();
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        await storeOAuthState(state, undefined, encodeOAuthLinkContext(userId, sessionId));
        const url = getGitHub().createAuthorizationURL(state, ['read:user', 'user:email']);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      withSecurity(
        createRoute({
          method: 'delete',
          path: '/auth/github/link',
          summary: 'Unlink GitHub account',
          description:
            'Removes the linked GitHub OAuth account from the authenticated user. Requires a valid session and factor verification when the account has a password or MFA enabled.',
          tags,
          request: {
            body: {
              required: false,
              content: { 'application/json': { schema: unlinkVerificationSchema } },
              description:
                'Factor verification (required when the account has a password or MFA enabled).',
            },
          },
          responses: {
            204: { description: 'GitHub account unlinked successfully.' },
            400: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Verification is required but not provided.',
            },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session or invalid verification.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider unlinking is allowed.',
            },
            429: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Too many unlink attempts. Try again later.',
            },
            500: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Auth adapter does not support unlinkProvider.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        if (!adapter.unlinkProvider) {
          return errorResponse(c, 'Auth adapter does not support unlinkProvider', 500);
        }
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        if (await runtime.rateLimit.trackAttempt(`oauth-unlink:${userId}`, oauthUnlinkOpts)) {
          return errorResponse(c, 'Too many unlink attempts. Try again later.', 429);
        }
        const body = c.req.valid('json');
        const unlinkErr = await verifyUnlinkFactor(userId, sessionId, body);
        if (unlinkErr) return errorResponse(c, unlinkErr.error, unlinkErr.status);
        await adapter.unlinkProvider(userId, 'github');
        eventBus.emit('security.auth.oauth.unlinked', { userId, meta: { provider: 'github' } });
        return c.body(null, 204);
      },
    );
  }

  // ─── LinkedIn ────────────────────────────────────────────────────────────
  if (providers.includes('linkedin')) {
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/linkedin',
        summary: 'Initiate LinkedIn OAuth',
        description:
          "Redirects the user to LinkedIn's authorization page to begin the OAuth login flow. After the user authorizes, LinkedIn redirects back to `/auth/linkedin/callback`.",
        tags,
        responses: {
          302: { description: "Redirect to LinkedIn's OAuth authorization page." },
          500: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'OAuth provider not configured.',
          },
        },
      }),
      async c => {
        const state = generateState();
        await storeOAuthState(state);
        const url = getLinkedIn().createAuthorizationURL(state, ['openid', 'profile', 'email']);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      createRoute({
        method: 'get',
        path: '/auth/linkedin/callback',
        summary: 'LinkedIn OAuth callback',
        description:
          'Handles the redirect from LinkedIn after user authorization. Validates the OAuth state and code, then creates or finds the user account. Sets a session cookie and redirects to the configured post-login URL.',
        tags,
        request: {
          query: z.object({
            code: z.string().describe('Authorization code from LinkedIn.'),
            state: z.string().describe('OAuth state parameter for CSRF protection.'),
          }),
        },
        responses: {
          302: { description: 'Redirect to the post-login URL with session token.' },
          400: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'Invalid callback parameters or expired state.',
          },
          403: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description:
              'Account is suspended or must verify its email before provider linking can complete.',
          },
        },
      }),
      async c => {
        const { code, state } = c.req.valid('query');
        if (!code || !state) return errorResponse(c, 'Invalid callback', 400);

        const stored = await consumeOAuthState(state);
        if (!stored) return errorResponse(c, 'Invalid or expired state', 400);

        const tokens = await getLinkedIn().validateAuthorizationCode(code);
        const info = (await fetch('https://api.linkedin.com/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokens.accessToken()}` },
        }).then(r => r.json())) as { sub: string; email?: string; name?: string; picture?: string };

        const linkResponse = await finishProviderLink(c, stored.linkUserId, 'linkedin', info.sub);
        if (linkResponse) return linkResponse;
        if (stored.linkUserId) return errorResponse(c, 'Invalid or expired state', 400);

        return finishOAuth(
          c,
          runtime,
          'linkedin',
          info.sub,
          { email: info.email, name: info.name, avatarUrl: info.picture },
          postLoginRedirect,
        );
      },
    );

    router.use('/auth/linkedin/link', userAuth);

    router.openapi(
      withSecurity(
        createRoute({
          method: 'post',
          path: '/auth/linkedin/link',
          summary: 'Link LinkedIn account',
          description:
            "Initiates an OAuth flow to link a LinkedIn account to the authenticated user. Requires a valid session. Redirects to LinkedIn's authorization page.",
          tags,
          responses: {
            302: { description: "Redirect to LinkedIn's OAuth authorization page." },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider linking can begin.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const state = generateState();
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        await storeOAuthState(state, undefined, encodeOAuthLinkContext(userId, sessionId));
        const url = getLinkedIn().createAuthorizationURL(state, ['openid', 'profile', 'email']);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      withSecurity(
        createRoute({
          method: 'delete',
          path: '/auth/linkedin/link',
          summary: 'Unlink LinkedIn account',
          description:
            'Removes the linked LinkedIn OAuth account from the authenticated user. Requires a valid session and factor verification when the account has a password or MFA enabled.',
          tags,
          request: {
            body: {
              required: false,
              content: { 'application/json': { schema: unlinkVerificationSchema } },
              description:
                'Factor verification (required when the account has a password or MFA enabled).',
            },
          },
          responses: {
            204: { description: 'LinkedIn account unlinked successfully.' },
            400: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Verification is required but not provided.',
            },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session or invalid verification.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider unlinking is allowed.',
            },
            429: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Too many unlink attempts. Try again later.',
            },
            500: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Auth adapter does not support unlinkProvider.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        if (!adapter.unlinkProvider) {
          return errorResponse(c, 'Auth adapter does not support unlinkProvider', 500);
        }
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        if (await runtime.rateLimit.trackAttempt(`oauth-unlink:${userId}`, oauthUnlinkOpts)) {
          return errorResponse(c, 'Too many unlink attempts. Try again later.', 429);
        }
        const body = c.req.valid('json');
        const unlinkErr = await verifyUnlinkFactor(userId, sessionId, body);
        if (unlinkErr) return errorResponse(c, unlinkErr.error, unlinkErr.status);
        await adapter.unlinkProvider(userId, 'linkedin');
        eventBus.emit('security.auth.oauth.unlinked', { userId, meta: { provider: 'linkedin' } });
        return c.body(null, 204);
      },
    );
  }

  // ─── Twitter/X ───────────────────────────────────────────────────────────
  if (providers.includes('twitter')) {
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/twitter',
        summary: 'Initiate Twitter/X OAuth',
        description:
          "Redirects the user to Twitter/X's authorization page to begin the OAuth login flow. After the user authorizes, Twitter redirects back to `/auth/twitter/callback`.",
        tags,
        responses: {
          302: { description: "Redirect to Twitter/X's OAuth authorization page." },
          500: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'OAuth provider not configured.',
          },
        },
      }),
      async c => {
        const state = generateState();
        const codeVerifier = generateCodeVerifier();
        await storeOAuthState(state, codeVerifier);
        const url = getTwitter().createAuthorizationURL(state, codeVerifier, [
          'tweet.read',
          'users.read',
        ]);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      createRoute({
        method: 'get',
        path: '/auth/twitter/callback',
        summary: 'Twitter/X OAuth callback',
        description:
          'Handles the redirect from Twitter/X after user authorization. Validates the OAuth state and code, then creates or finds the user account. Sets a session cookie and redirects to the configured post-login URL.',
        tags,
        request: {
          query: z.object({
            code: z.string().describe('Authorization code from Twitter/X.'),
            state: z.string().describe('OAuth state parameter for CSRF protection.'),
          }),
        },
        responses: {
          302: { description: 'Redirect to the post-login URL with session token.' },
          400: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'Invalid callback parameters or expired state.',
          },
          403: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description:
              'Account is suspended or must verify its email before provider linking can complete.',
          },
        },
      }),
      async c => {
        const { code, state } = c.req.valid('query');
        if (!code || !state) return errorResponse(c, 'Invalid callback', 400);

        const stored = await consumeOAuthState(state);
        if (!stored?.codeVerifier) return errorResponse(c, 'Invalid or expired state', 400);

        const tokens = await getTwitter().validateAuthorizationCode(code, stored.codeVerifier);
        const info = (await fetch(
          'https://api.twitter.com/2/users/me?user.fields=name,profile_image_url',
          {
            headers: { Authorization: `Bearer ${tokens.accessToken()}` },
          },
        ).then(r => r.json())) as {
          data?: { id: string; name?: string; username?: string; profile_image_url?: string };
        };

        const user = info.data;
        if (!user?.id) return errorResponse(c, 'Failed to retrieve Twitter user info', 400);

        const linkResponse = await finishProviderLink(c, stored.linkUserId, 'twitter', user.id);
        if (linkResponse) return linkResponse;
        if (stored.linkUserId) return errorResponse(c, 'Invalid or expired state', 400);

        return finishOAuth(
          c,
          runtime,
          'twitter',
          user.id,
          { name: user.name, avatarUrl: user.profile_image_url },
          postLoginRedirect,
        );
      },
    );

    router.use('/auth/twitter/link', userAuth);

    router.openapi(
      withSecurity(
        createRoute({
          method: 'post',
          path: '/auth/twitter/link',
          summary: 'Link Twitter/X account',
          description:
            "Initiates an OAuth flow to link a Twitter/X account to the authenticated user. Requires a valid session. Redirects to Twitter/X's authorization page.",
          tags,
          responses: {
            302: { description: "Redirect to Twitter/X's OAuth authorization page." },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider linking can begin.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const state = generateState();
        const codeVerifier = generateCodeVerifier();
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        await storeOAuthState(state, codeVerifier, encodeOAuthLinkContext(userId, sessionId));
        const url = getTwitter().createAuthorizationURL(state, codeVerifier, [
          'tweet.read',
          'users.read',
        ]);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      withSecurity(
        createRoute({
          method: 'delete',
          path: '/auth/twitter/link',
          summary: 'Unlink Twitter/X account',
          description:
            'Removes the linked Twitter/X OAuth account from the authenticated user. Requires a valid session and factor verification when the account has a password or MFA enabled.',
          tags,
          request: {
            body: {
              required: false,
              content: { 'application/json': { schema: unlinkVerificationSchema } },
              description:
                'Factor verification (required when the account has a password or MFA enabled).',
            },
          },
          responses: {
            204: { description: 'Twitter/X account unlinked successfully.' },
            400: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Verification is required but not provided.',
            },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session or invalid verification.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider unlinking is allowed.',
            },
            429: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Too many unlink attempts. Try again later.',
            },
            500: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Auth adapter does not support unlinkProvider.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        if (!adapter.unlinkProvider) {
          return errorResponse(c, 'Auth adapter does not support unlinkProvider', 500);
        }
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        if (await runtime.rateLimit.trackAttempt(`oauth-unlink:${userId}`, oauthUnlinkOpts)) {
          return errorResponse(c, 'Too many unlink attempts. Try again later.', 429);
        }
        const body = c.req.valid('json');
        const unlinkErr = await verifyUnlinkFactor(userId, sessionId, body);
        if (unlinkErr) return errorResponse(c, unlinkErr.error, unlinkErr.status);
        await adapter.unlinkProvider(userId, 'twitter');
        eventBus.emit('security.auth.oauth.unlinked', { userId, meta: { provider: 'twitter' } });
        return c.body(null, 204);
      },
    );
  }

  // ─── GitLab ──────────────────────────────────────────────────────────────
  if (providers.includes('gitlab')) {
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/gitlab',
        summary: 'Initiate GitLab OAuth',
        description:
          "Redirects the user to GitLab's authorization page to begin the OAuth login flow. After the user authorizes, GitLab redirects back to `/auth/gitlab/callback`.",
        tags,
        responses: {
          302: { description: "Redirect to GitLab's OAuth authorization page." },
          500: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'OAuth provider not configured.',
          },
        },
      }),
      async c => {
        const state = generateState();
        await storeOAuthState(state);
        const url = getGitLab().createAuthorizationURL(state, ['read_user']);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      createRoute({
        method: 'get',
        path: '/auth/gitlab/callback',
        summary: 'GitLab OAuth callback',
        description:
          'Handles the redirect from GitLab after user authorization. Validates the OAuth state and code, then creates or finds the user account. Sets a session cookie and redirects to the configured post-login URL.',
        tags,
        request: {
          query: z.object({
            code: z.string().describe('Authorization code from GitLab.'),
            state: z.string().describe('OAuth state parameter for CSRF protection.'),
          }),
        },
        responses: {
          302: { description: 'Redirect to the post-login URL with session token.' },
          400: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'Invalid callback parameters or expired state.',
          },
          403: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description:
              'Account is suspended or must verify its email before provider linking can complete.',
          },
        },
      }),
      async c => {
        const { code, state } = c.req.valid('query');
        if (!code || !state) return errorResponse(c, 'Invalid callback', 400);

        const stored = await consumeOAuthState(state);
        if (!stored) return errorResponse(c, 'Invalid or expired state', 400);

        const tokens = await getGitLab().validateAuthorizationCode(code);
        const info = (await fetch('https://gitlab.com/api/v4/user', {
          headers: { Authorization: `Bearer ${tokens.accessToken()}` },
        }).then(r => r.json())) as {
          id: number;
          email?: string;
          name?: string;
          avatar_url?: string;
        };

        const linkResponse = await finishProviderLink(c, stored.linkUserId, 'gitlab', String(info.id));
        if (linkResponse) return linkResponse;
        if (stored.linkUserId) return errorResponse(c, 'Invalid or expired state', 400);

        return finishOAuth(
          c,
          runtime,
          'gitlab',
          String(info.id),
          { email: info.email, name: info.name, avatarUrl: info.avatar_url },
          postLoginRedirect,
        );
      },
    );

    router.use('/auth/gitlab/link', userAuth);

    router.openapi(
      withSecurity(
        createRoute({
          method: 'post',
          path: '/auth/gitlab/link',
          summary: 'Link GitLab account',
          description:
            "Initiates an OAuth flow to link a GitLab account to the authenticated user. Requires a valid session. Redirects to GitLab's authorization page.",
          tags,
          responses: {
            302: { description: "Redirect to GitLab's OAuth authorization page." },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider linking can begin.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const state = generateState();
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        await storeOAuthState(state, undefined, encodeOAuthLinkContext(userId, sessionId));
        const url = getGitLab().createAuthorizationURL(state, ['read_user']);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      withSecurity(
        createRoute({
          method: 'delete',
          path: '/auth/gitlab/link',
          summary: 'Unlink GitLab account',
          description:
            'Removes the linked GitLab OAuth account from the authenticated user. Requires a valid session and factor verification when the account has a password or MFA enabled.',
          tags,
          request: {
            body: {
              required: false,
              content: { 'application/json': { schema: unlinkVerificationSchema } },
              description:
                'Factor verification (required when the account has a password or MFA enabled).',
            },
          },
          responses: {
            204: { description: 'GitLab account unlinked successfully.' },
            400: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Verification is required but not provided.',
            },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session or invalid verification.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider unlinking is allowed.',
            },
            429: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Too many unlink attempts. Try again later.',
            },
            500: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Auth adapter does not support unlinkProvider.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        if (!adapter.unlinkProvider) {
          return errorResponse(c, 'Auth adapter does not support unlinkProvider', 500);
        }
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        if (await runtime.rateLimit.trackAttempt(`oauth-unlink:${userId}`, oauthUnlinkOpts)) {
          return errorResponse(c, 'Too many unlink attempts. Try again later.', 429);
        }
        const body = c.req.valid('json');
        const unlinkErr = await verifyUnlinkFactor(userId, sessionId, body);
        if (unlinkErr) return errorResponse(c, unlinkErr.error, unlinkErr.status);
        await adapter.unlinkProvider(userId, 'gitlab');
        eventBus.emit('security.auth.oauth.unlinked', { userId, meta: { provider: 'gitlab' } });
        return c.body(null, 204);
      },
    );
  }

  // ─── Slack ───────────────────────────────────────────────────────────────
  if (providers.includes('slack')) {
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/slack',
        summary: 'Initiate Slack OAuth',
        description:
          "Redirects the user to Slack's authorization page to begin the OAuth login flow. After the user authorizes, Slack redirects back to `/auth/slack/callback`.",
        tags,
        responses: {
          302: { description: "Redirect to Slack's OAuth authorization page." },
          500: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'OAuth provider not configured.',
          },
        },
      }),
      async c => {
        const state = generateState();
        await storeOAuthState(state);
        const url = getSlack().createAuthorizationURL(state, ['openid', 'profile', 'email']);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      createRoute({
        method: 'get',
        path: '/auth/slack/callback',
        summary: 'Slack OAuth callback',
        description:
          'Handles the redirect from Slack after user authorization. Validates the OAuth state and code, then creates or finds the user account. Sets a session cookie and redirects to the configured post-login URL.',
        tags,
        request: {
          query: z.object({
            code: z.string().describe('Authorization code from Slack.'),
            state: z.string().describe('OAuth state parameter for CSRF protection.'),
          }),
        },
        responses: {
          302: { description: 'Redirect to the post-login URL with session token.' },
          400: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'Invalid callback parameters or expired state.',
          },
          403: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description:
              'Account is suspended or must verify its email before provider linking can complete.',
          },
        },
      }),
      async c => {
        const { code, state } = c.req.valid('query');
        if (!code || !state) return errorResponse(c, 'Invalid callback', 400);

        const stored = await consumeOAuthState(state);
        if (!stored) return errorResponse(c, 'Invalid or expired state', 400);

        const tokens = await getSlack().validateAuthorizationCode(code);
        const info = (await fetch('https://slack.com/api/openid.connect.userInfo', {
          headers: { Authorization: `Bearer ${tokens.accessToken()}` },
        }).then(r => r.json())) as { sub: string; email?: string; name?: string; picture?: string };

        const linkResponse = await finishProviderLink(c, stored.linkUserId, 'slack', info.sub);
        if (linkResponse) return linkResponse;
        if (stored.linkUserId) return errorResponse(c, 'Invalid or expired state', 400);

        return finishOAuth(
          c,
          runtime,
          'slack',
          info.sub,
          { email: info.email, name: info.name, avatarUrl: info.picture },
          postLoginRedirect,
        );
      },
    );

    router.use('/auth/slack/link', userAuth);

    router.openapi(
      withSecurity(
        createRoute({
          method: 'post',
          path: '/auth/slack/link',
          summary: 'Link Slack account',
          description:
            "Initiates an OAuth flow to link a Slack account to the authenticated user. Requires a valid session. Redirects to Slack's authorization page.",
          tags,
          responses: {
            302: { description: "Redirect to Slack's OAuth authorization page." },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider linking can begin.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const state = generateState();
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        await storeOAuthState(state, undefined, encodeOAuthLinkContext(userId, sessionId));
        const url = getSlack().createAuthorizationURL(state, ['openid', 'profile', 'email']);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      withSecurity(
        createRoute({
          method: 'delete',
          path: '/auth/slack/link',
          summary: 'Unlink Slack account',
          description:
            'Removes the linked Slack OAuth account from the authenticated user. Requires a valid session and factor verification when the account has a password or MFA enabled.',
          tags,
          request: {
            body: {
              required: false,
              content: { 'application/json': { schema: unlinkVerificationSchema } },
              description:
                'Factor verification (required when the account has a password or MFA enabled).',
            },
          },
          responses: {
            204: { description: 'Slack account unlinked successfully.' },
            400: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Verification is required but not provided.',
            },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session or invalid verification.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider unlinking is allowed.',
            },
            429: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Too many unlink attempts. Try again later.',
            },
            500: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Auth adapter does not support unlinkProvider.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        if (!adapter.unlinkProvider) {
          return errorResponse(c, 'Auth adapter does not support unlinkProvider', 500);
        }
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        if (await runtime.rateLimit.trackAttempt(`oauth-unlink:${userId}`, oauthUnlinkOpts)) {
          return errorResponse(c, 'Too many unlink attempts. Try again later.', 429);
        }
        const body = c.req.valid('json');
        const unlinkErr = await verifyUnlinkFactor(userId, sessionId, body);
        if (unlinkErr) return errorResponse(c, unlinkErr.error, unlinkErr.status);
        await adapter.unlinkProvider(userId, 'slack');
        eventBus.emit('security.auth.oauth.unlinked', { userId, meta: { provider: 'slack' } });
        return c.body(null, 204);
      },
    );
  }

  // ─── Bitbucket ───────────────────────────────────────────────────────────
  if (providers.includes('bitbucket')) {
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/bitbucket',
        summary: 'Initiate Bitbucket OAuth',
        description:
          "Redirects the user to Bitbucket's authorization page to begin the OAuth login flow. After the user authorizes, Bitbucket redirects back to `/auth/bitbucket/callback`.",
        tags,
        responses: {
          302: { description: "Redirect to Bitbucket's OAuth authorization page." },
          500: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'OAuth provider not configured.',
          },
        },
      }),
      async c => {
        const state = generateState();
        await storeOAuthState(state);
        const url = getBitbucket().createAuthorizationURL(state);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      createRoute({
        method: 'get',
        path: '/auth/bitbucket/callback',
        summary: 'Bitbucket OAuth callback',
        description:
          'Handles the redirect from Bitbucket after user authorization. Validates the OAuth state and code, then creates or finds the user account. Sets a session cookie and redirects to the configured post-login URL.',
        tags,
        request: {
          query: z.object({
            code: z.string().describe('Authorization code from Bitbucket.'),
            state: z.string().describe('OAuth state parameter for CSRF protection.'),
          }),
        },
        responses: {
          302: { description: 'Redirect to the post-login URL with session token.' },
          400: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'Invalid callback parameters or expired state.',
          },
          403: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description:
              'Account is suspended or must verify its email before provider linking can complete.',
          },
        },
      }),
      async c => {
        const { code, state } = c.req.valid('query');
        if (!code || !state) return errorResponse(c, 'Invalid callback', 400);

        const stored = await consumeOAuthState(state);
        if (!stored) return errorResponse(c, 'Invalid or expired state', 400);

        const tokens = await getBitbucket().validateAuthorizationCode(code);
        const info = (await fetch('https://api.bitbucket.org/2.0/user', {
          headers: { Authorization: `Bearer ${tokens.accessToken()}` },
        }).then(r => r.json())) as {
          account_id: string;
          display_name?: string;
          links?: { avatar?: { href?: string } };
        };

        // Bitbucket may not expose email on /user — fetch from /user/emails
        const emails = (await fetch('https://api.bitbucket.org/2.0/user/emails', {
          headers: { Authorization: `Bearer ${tokens.accessToken()}` },
        }).then(r => r.json())) as {
          values?: { email: string; is_primary: boolean; is_confirmed: boolean }[];
        };
        const email =
          emails.values?.find(e => e.is_primary && e.is_confirmed)?.email ??
          emails.values?.find(e => e.is_confirmed)?.email;

        const linkResponse = await finishProviderLink(c, stored.linkUserId, 'bitbucket', info.account_id);
        if (linkResponse) return linkResponse;
        if (stored.linkUserId) return errorResponse(c, 'Invalid or expired state', 400);

        return finishOAuth(
          c,
          runtime,
          'bitbucket',
          info.account_id,
          { email, name: info.display_name, avatarUrl: info.links?.avatar?.href },
          postLoginRedirect,
        );
      },
    );

    router.use('/auth/bitbucket/link', userAuth);

    router.openapi(
      withSecurity(
        createRoute({
          method: 'post',
          path: '/auth/bitbucket/link',
          summary: 'Link Bitbucket account',
          description:
            "Initiates an OAuth flow to link a Bitbucket account to the authenticated user. Requires a valid session. Redirects to Bitbucket's authorization page.",
          tags,
          responses: {
            302: { description: "Redirect to Bitbucket's OAuth authorization page." },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider linking can begin.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        const state = generateState();
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        await storeOAuthState(state, undefined, encodeOAuthLinkContext(userId, sessionId));
        const url = getBitbucket().createAuthorizationURL(state);
        return c.redirect(url.toString());
      },
    );

    router.openapi(
      withSecurity(
        createRoute({
          method: 'delete',
          path: '/auth/bitbucket/link',
          summary: 'Unlink Bitbucket account',
          description:
            'Removes the linked Bitbucket OAuth account from the authenticated user. Requires a valid session and factor verification when the account has a password or MFA enabled.',
          tags,
          request: {
            body: {
              required: false,
              content: { 'application/json': { schema: unlinkVerificationSchema } },
              description:
                'Factor verification (required when the account has a password or MFA enabled).',
            },
          },
          responses: {
            204: { description: 'Bitbucket account unlinked successfully.' },
            400: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Verification is required but not provided.',
            },
            401: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'No valid session or invalid verification.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before provider unlinking is allowed.',
            },
            429: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Too many unlink attempts. Try again later.',
            },
            500: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Auth adapter does not support unlinkProvider.',
            },
          },
        }),
        { cookieAuth: [] },
        { userToken: [] },
      ),
      async c => {
        if (!adapter.unlinkProvider) {
          return errorResponse(c, 'Auth adapter does not support unlinkProvider', 500);
        }
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
        if (blocked) return blocked;
        if (await runtime.rateLimit.trackAttempt(`oauth-unlink:${userId}`, oauthUnlinkOpts)) {
          return errorResponse(c, 'Too many unlink attempts. Try again later.', 429);
        }
        const body = c.req.valid('json');
        const unlinkErr = await verifyUnlinkFactor(userId, sessionId, body);
        if (unlinkErr) return errorResponse(c, unlinkErr.error, unlinkErr.status);
        await adapter.unlinkProvider(userId, 'bitbucket');
        eventBus.emit('security.auth.oauth.unlinked', { userId, meta: { provider: 'bitbucket' } });
        return c.body(null, 204);
      },
    );
  }

  // ─── OAuth Re-auth ──────────────────────────────────────────────────────
  // Per-provider re-auth routes — only mounted when reauth is enabled in config.
  // Allows forcing the user to re-authenticate with their OAuth provider before
  // sensitive operations (e.g. account deletion, MFA changes).

  if (getConfig().oauthReauth?.enabled ?? false) {
    for (const provider of providers) {
      // Skip Apple — Apple does not support prompt= parameter for re-auth
      if (provider === 'apple') continue;

      router.use(`/auth/${provider}/reauth`, userAuth);

      router.openapi(
        withSecurity(
          createRoute({
            method: 'post',
            path: `/auth/${provider}/reauth`,
            summary: `Initiate ${provider} OAuth re-authentication`,
            description: `Forces the authenticated user to re-authenticate with ${provider} before a sensitive operation. Requires a valid session. Redirects to the provider with \`prompt=${getConfig().oauthReauth?.promptType ?? 'login'}\`.`,
            tags,
            request: {
              query: z.object({
                purpose: z
                  .string()
                  .describe('Reason for re-auth (e.g. delete_account, change_password).'),
                returnUrl: z
                  .string()
                  .optional()
                  .describe(
                    'URL to redirect to after successful re-auth. Must be a relative path.',
                  ),
              }),
            },
            responses: {
              302: { description: 'Redirect to provider re-auth page.' },
              400: {
                content: { 'application/json': { schema: OAuthErrorResponse } },
                description: 'Provider not linked to this account.',
              },
              401: {
                content: { 'application/json': { schema: OAuthErrorResponse } },
                description: 'No valid session.',
              },
              403: {
                content: { 'application/json': { schema: OAuthErrorResponse } },
                description:
                  'Account is suspended or must verify its email before OAuth re-authentication can begin.',
              },
              500: {
                content: { 'application/json': { schema: OAuthErrorResponse } },
                description: 'OAuth provider not configured.',
              },
            },
          }),
          { cookieAuth: [] },
          { userToken: [] },
        ),
        async c => {
          const userId = requireUserId(c);
          const sessionId = requireSessionId(c);
          const { purpose, returnUrl } = c.req.valid('query');
          const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
          if (blocked) return blocked;

          // Verify user has this provider linked
          const user = adapter.getUser ? await adapter.getUser(userId) : null;
          const providerKey = `${provider}:`;
          const hasProvider = user?.providerIds?.some(id => id.startsWith(providerKey));
          if (!hasProvider) {
            return errorResponse(c, `No ${provider} account linked to this user`, 400);
          }

          const state = generateState();
          const codeVerifier =
            provider === 'google' || provider === 'microsoft' ? generateCodeVerifier() : undefined;

          // Encode re-auth context into the OAuth state's linkUserId field using a
          // "reauth:" prefix, so the callback can recover it after consuming the state.
          // Format: "reauth:userId:sessionId:purpose[:returnUrl]"
          await storeOAuthState(
            state,
            codeVerifier,
            `reauth:${userId}:${sessionId}:${encodeURIComponent(purpose)}${returnUrl ? `:${encodeURIComponent(returnUrl)}` : ''}`,
          );

          const promptType = getConfig().oauthReauth?.promptType ?? 'login';
          let url: URL;
          if (provider === 'google') {
            url = getGoogle().createAuthorizationURL(state, requireCodeVerifier(codeVerifier), [
              'openid',
              'profile',
              'email',
            ]);
          } else if (provider === 'microsoft') {
            url = getMicrosoft().createAuthorizationURL(state, requireCodeVerifier(codeVerifier), [
              'openid',
              'profile',
              'email',
            ]);
          } else {
            // GitHub
            url = getGitHub().createAuthorizationURL(state, ['read:user', 'user:email']);
          }
          url.searchParams.set('prompt', promptType);
          return c.redirect(url.toString());
        },
      );

      router.openapi(
        createRoute({
          method: 'get',
          path: `/auth/${provider}/reauth/callback`,
          summary: `${provider} OAuth re-auth callback`,
          description: `Handles the redirect from ${provider} after re-authentication. Verifies the provider account matches the linked account, then issues a short-lived confirmation code for the client to exchange.`,
          tags,
          request: {
            query: z.object({
              code: z.string().describe('Authorization code from provider.'),
              state: z.string().describe('OAuth state parameter.'),
            }),
          },
          responses: {
            302: { description: 'Redirect with confirmation code (or error).' },
            400: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description: 'Invalid state, expired session, or provider account mismatch.',
            },
            403: {
              content: { 'application/json': { schema: OAuthErrorResponse } },
              description:
                'Account is suspended or must verify its email before OAuth re-authentication can complete.',
            },
          },
        }),
        async c => {
          const { code, state } = c.req.valid('query');
          if (!code || !state) return errorResponse(c, 'Invalid callback', 400);

          const stored = await consumeOAuthState(state);
          if (!stored?.linkUserId?.startsWith('reauth:')) {
            return errorResponse(c, 'Invalid or expired state', 400);
          }

          // Parse reauth info encoded in linkUserId: "reauth:userId:sessionId:purpose[:returnUrl]"
          // userId and sessionId are UUID-safe (no colons); purpose and returnUrl are encodeURIComponent'd.
          const parts = stored.linkUserId.slice('reauth:'.length).split(':');
          if (parts.length < 3) return errorResponse(c, 'Invalid or expired state', 400);
          const [userId, sessionId, encodedPurpose, encodedReturnUrl] = parts;
          const purpose = decodeURIComponent(encodedPurpose);
          const returnUrl = encodedReturnUrl ? decodeURIComponent(encodedReturnUrl) : undefined;
          const blocked = await assertSensitiveOauthMutationAllowed(c, userId);
          if (blocked) return blocked;

          // Exchange code for tokens and get the provider user ID
          let providerUserId: string;
          try {
            if (provider === 'google') {
              const tokens = await getGoogle().validateAuthorizationCode(
                code,
                requireCodeVerifier(stored.codeVerifier),
              );
              const info = (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
                headers: { Authorization: `Bearer ${tokens.accessToken()}` },
              }).then(r => r.json())) as { sub: string };
              providerUserId = info.sub;
            } else if (provider === 'microsoft') {
              const tokens = await getMicrosoft().validateAuthorizationCode(
                code,
                requireCodeVerifier(stored.codeVerifier),
              );
              const info = (await fetch('https://graph.microsoft.com/v1.0/me', {
                headers: { Authorization: `Bearer ${tokens.accessToken()}` },
              }).then(r => r.json())) as { id: string };
              providerUserId = info.id;
            } else {
              // GitHub
              const tokens = await getGitHub().validateAuthorizationCode(code);
              const info = (await fetch('https://api.github.com/user', {
                headers: {
                  Authorization: `Bearer ${tokens.accessToken()}`,
                  'User-Agent': 'slingshot',
                },
              }).then(r => r.json())) as { id: number };
              providerUserId = String(info.id);
            }
          } catch {
            return errorResponse(c, 'Failed to verify provider identity', 400);
          }

          // Verify the provider account matches what is linked to this user
          const user = adapter.getUser ? await adapter.getUser(userId) : null;
          const expectedKey = `${provider}:${providerUserId}`;
          const isLinked = user?.providerIds?.includes(expectedKey);
          if (!isLinked) {
            eventBus.emit('security.auth.oauth.reauthed', {
              userId,
              sessionId,
              meta: { provider, purpose, mismatch: true },
            });
            return errorResponse(c, 'Provider account mismatch', 400);
          }

          // Issue a confirmation code
          const confirmationCode = await storeReauthConfirmation(runtime.repos.oauthReauth, {
            userId,
            sessionId,
            purpose,
          });

          eventBus.emit('security.auth.oauth.reauthed', {
            userId,
            sessionId,
            meta: { provider, purpose },
          });

          // Redirect with confirmation code — validate returnUrl against open redirect
          const isSafeRedirect = (url: string) =>
            url.startsWith('/') && !url.startsWith('//') && !url.includes('://');
          const redirectBase = returnUrl && isSafeRedirect(returnUrl) ? returnUrl : '/';
          try {
            const url = new URL(redirectBase, 'http://localhost');
            url.searchParams.set('reauth_code', confirmationCode);
            // Use relative redirect for relative paths
            return c.redirect(`${url.pathname}${url.search}`);
          } catch {
            // Fallback also uses the already-validated redirectBase
            const sep = redirectBase.includes('?') ? '&' : '?';
            return c.redirect(
              `${redirectBase}${sep}reauth_code=${encodeURIComponent(confirmationCode)}`,
            );
          }
        },
      );
    }
  }

  // ─── Code Exchange ─────────────────────────────────────────────────────
  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/oauth/exchange',
      summary: 'Exchange OAuth authorization code for session token',
      description:
        'Exchanges a one-time authorization code (received from the OAuth redirect) for a session token. The code is single-use and expires after 60 seconds. Sets session cookies for browser clients; returns the token in the JSON response for mobile/SPA clients.',
      tags,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                code: z.string().describe('One-time authorization code from the OAuth redirect.'),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({
                token: z.string().describe('Session JWT.'),
                userId: z.string().describe('Authenticated user ID.'),
                email: z.string().optional().describe('User email if available.'),
                refreshToken: z
                  .string()
                  .optional()
                  .describe('Refresh token if refresh tokens are configured.'),
              }),
            },
          },
          description: 'Session token and user info.',
        },
        400: {
          content: { 'application/json': { schema: OAuthErrorResponse } },
          description: 'Missing code parameter.',
        },
        401: {
          content: { 'application/json': { schema: OAuthErrorResponse } },
          description: 'Invalid, expired, or already-used code.',
        },
        429: {
          content: { 'application/json': { schema: OAuthErrorResponse } },
          description: 'Rate limit exceeded.',
        },
      },
    }),
    async c => {
      // Rate limit by IP to prevent brute-forcing codes within the 60s TTL
      const ip = getClientIp(c);
      const limited = await runtime.rateLimit.trackAttempt(`oauth-exchange:ip:${ip}`, {
        max: 20,
        windowMs: 60_000,
      });
      if (limited) {
        return errorResponse(c, 'Too many requests', 429);
      }

      const { code } = c.req.valid('json');
      if (!code) return errorResponse(c, 'Missing code', 400);

      const payload = await consumeOAuthCode(
        runtime.repos.oauthCode,
        code,
        runtime.dataEncryptionKeys,
      );
      if (!payload) return errorResponse(c, 'Invalid or expired code', 401);

      // Set session cookies for browser clients
      const rtConfig = getConfig().refreshToken;
      setAuthCookie(
        c,
        COOKIE_TOKEN,
        payload.token,
        isProd(),
        runtime.config,
        rtConfig ? (rtConfig.accessTokenExpiry ?? 900) : undefined,
      );
      if (payload.refreshToken && rtConfig) {
        setAuthCookie(
          c,
          COOKIE_REFRESH_TOKEN,
          payload.refreshToken,
          isProd(),
          runtime.config,
          rtConfig.refreshTokenExpiry ?? 2_592_000,
        );
      }
      if (getConfig().csrfEnabled) refreshCsrfToken(c);

      return c.json(
        {
          token: payload.token,
          userId: payload.userId,
          email: payload.email,
          refreshToken: payload.refreshToken,
        },
        200,
      );
    },
  );

  // ─── Re-auth Confirmation Exchange ──────────────────────────────────────
  if (getConfig().oauthReauth?.enabled ?? false) {
    router.use('/auth/oauth/reauth/exchange', userAuth);
    router.openapi(
      createRoute({
        method: 'post',
        path: '/auth/oauth/reauth/exchange',
        summary: 'Exchange OAuth re-auth confirmation code for step-up proof',
        description:
          'Exchanges a one-time re-auth confirmation code (received from the re-auth callback redirect) for a step-up proof. The code is single-use and expires after 5 minutes. Returns confirmation that the user successfully re-authenticated with their OAuth provider.',
        tags,
        request: {
          body: {
            content: {
              'application/json': {
                schema: z.object({
                  code: z
                    .string()
                    .describe('One-time re-auth confirmation code from the redirect.'),
                }),
              },
            },
          },
        },
        responses: {
          200: {
            content: {
              'application/json': {
                schema: z.object({
                  reauthConfirmed: z.literal(true).describe('Always true on success.'),
                  purpose: z.string().describe('The purpose the re-auth was requested for.'),
                  userId: z.string().describe('The re-authenticated user ID.'),
                }),
              },
            },
            description: 'Re-auth confirmed.',
          },
          400: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'Missing code parameter.',
          },
          401: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'Invalid, expired, or already-used code.',
          },
          429: {
            content: { 'application/json': { schema: OAuthErrorResponse } },
            description: 'Rate limit exceeded.',
          },
        },
      }),
      async c => {
        const ip = getClientIp(c);
        const limited = await runtime.rateLimit.trackAttempt(`oauth-reauth-exchange:ip:${ip}`, {
          max: 20,
          windowMs: 60_000,
        });
        if (limited) {
          return errorResponse(c, 'Too many requests', 429);
        }

        const { code } = c.req.valid('json');
        if (!code) return errorResponse(c, 'Missing code', 400);

        const payload = await consumeReauthConfirmation(runtime.repos.oauthReauth, code);
        if (!payload) return errorResponse(c, 'Invalid or expired code', 401);
        const userId = requireUserId(c);
        const sessionId = requireSessionId(c);
        if (payload.userId !== userId || payload.sessionId !== sessionId) {
          return errorResponse(c, 'Invalid or expired code', 401);
        }

        return c.json(
          {
            reauthConfirmed: true as const,
            purpose: payload.purpose,
            userId,
          },
          200,
        );
      },
    );
  }

  return router;
};
