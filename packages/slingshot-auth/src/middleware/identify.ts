import { readAuthCookie } from '@auth/lib/cookieOptions';
import { isProd } from '@auth/lib/env';
import { verifyToken } from '@auth/lib/jwt';
import { getSuspended } from '@auth/lib/suspension';
import type { MiddlewareHandler } from 'hono';
import type { Actor, AppEnv } from '@lastshotlabs/slingshot-core';
import {
  ANONYMOUS_ACTOR,
  COOKIE_TOKEN,
  HEADER_USER_TOKEN,
  HttpError,
  type PluginStateMap,
  createPluginStateMap,
  isPublicPath,
  publishPluginState,
  sha256,
  timingSafeEqual,
} from '@lastshotlabs/slingshot-core';
import { getClientIp } from '@lastshotlabs/slingshot-core';
import { AUTH_RUNTIME_KEY, type AuthRuntimeContext } from '../runtime';

function readBearerToken(header: string | undefined): string | null {
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

function computeFingerprint(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  fields: Array<'ip' | 'ua' | 'accept-language'>,
): string {
  const parts = fields.map(f => {
    if (f === 'ip') return getClientIp(c);
    if (f === 'ua') return c.req.header('user-agent') ?? '';
    return c.req.header('accept-language') ?? '';
  });
  return sha256(parts.join(':'));
}

/**
 * Creates the identity-resolution middleware for a given auth runtime.
 *
 * On every request this middleware reads the session token (from the `session` cookie or the
 * `x-user-token` header for non-browser clients) and resolves the authenticated user identity.
 * The result is published as a frozen `Actor` object on the Hono context (`c.get('actor')`)
 * and can be read via `getActor(c)`, `getActorId(c)`, or `getActorTenantId(c)` from
 * `@lastshotlabs/slingshot-core`.
 *
 * Processing steps (in order):
 * 1. **Token extraction** — checks the auth cookie first, then `x-user-token`, then
 *    `Authorization: Bearer <token>`.
 *    Initialises all identity context variables to `null` before processing.
 * 2. **JWT verification** — verifies the token's signature and expiry using the configured
 *    signing secret (supports rotating secrets via `string[]`).
 * 3. **M2M token detection** — if the JWT contains a `scope` claim but no `sid` claim, the
 *    caller is treated as a machine-to-machine client (`actor.kind = 'service-account'`).
 * 4. **Session lookup** — retrieves the stored token from the session repository and performs
 *    a timing-safe comparison to ensure the token has not been superseded (e.g., by a logout
 *    or session rotation on another device).
 * 5. **Fingerprint binding** (optional) — when `signing.sessionBinding` is configured, the
 *    middleware hashes the request's IP address, User-Agent, and/or Accept-Language header.
 *    - On the first authenticated request the fingerprint is stored.
 *    - On subsequent requests the fingerprint is compared. Mismatch handling is controlled
 *      by `onMismatch`: `'unauthenticate'` (default), `'reject'` (throws `HttpError 401`),
 *      or `'log-only'` (sets identity but emits a log warning).
 * 6. **Suspension check** — unless `auth.checkSuspensionOnIdentify` is explicitly set to
 *    `false`, the adapter's `getSuspended` is called. Suspended users are treated as
 *    unauthenticated (actor reverts to anonymous).
 * 7. **Idle timeout tracking** — when `auth.trackLastActive` or `auth.sessionPolicy.idleTimeout`
 *    is configured, `sessionRepo.updateSessionLastActive` is called asynchronously (fire-and-
 *    forget, errors are logged but not propagated).
 * 8. **Actor construction** — builds a frozen `Actor` from the resolved identity variables
 *    and publishes it via `c.set('actor', ...)`. The actor captures `id`, `kind`, `tenantId`,
 *    `sessionId`, `roles`, and `claims` at resolution time.
 *
 * This middleware never rejects a request on its own — it only sets or clears the identity
 * context variables. Use `userAuth` (or `requireStepUp`, `requireVerifiedEmail`) after
 * `createIdentifyMiddleware` to gate access.
 *
 * @param authRuntime - The auth runtime context providing config, session repo, adapter, and
 *   signing config. Obtained from `getAuthRuntimeFromRequest(c)` or injected during plugin setup.
 * @returns A Hono `MiddlewareHandler<AppEnv>` that publishes a frozen `Actor` on the context
 *   and calls `next()`.
 *
 * @remarks
 * **Timing-safe token handling**: all comparisons that involve a secret or stored value
 * use `timingSafeEqual` from `slingshot-core` to prevent timing-oracle attacks:
 * - Session token comparison (`stored ?? ''` vs the presented JWT) — the empty-string
 *   fallback ensures the comparison runs even when the session is not found, preventing
 *   a fast-path timing leak that would reveal whether a session ID is valid.
 * - Fingerprint comparison (`storedFp` vs `current`) — avoids a timing difference between
 *   matching and non-matching fingerprints.
 *
 * JWT verification errors (expired token, bad signature, malformed token) are caught
 * silently via a `try/catch` and treated as unauthenticated — they do not propagate to
 * the error handler. The only exception is `HttpError`, which is re-thrown so
 * `onMismatch: 'reject'` fingerprint violations produce a proper 401 response.
 *
 * The middleware never short-circuits (it always calls `next()`). Downstream handlers
 * should use `getActorId(c)` to check authentication status. Use the `userAuth` middleware
 * (which wraps `identify`) for protected routes.
 *
 * @example
 * import { createIdentifyMiddleware } from '@lastshotlabs/slingshot-auth/plugin';
 * import { getActorId } from '@lastshotlabs/slingshot-core';
 *
 * // Applied automatically by createAuthPlugin — manual usage example:
 * const identify = createIdentifyMiddleware(authRuntime);
 * app.use('/api/*', identify);
 * app.get('/api/me', (c) => {
 *   const userId = getActorId(c);
 *   if (!userId) return c.json({ error: 'Unauthorized' }, 401);
 *   return c.json({ userId });
 * });
 */
export const createIdentifyMiddleware =
  (authRuntime: AuthRuntimeContext): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const currentCtx = c.get('slingshotCtx') as unknown as
      | ({ pluginState?: PluginStateMap } & Record<string, unknown>)
      | undefined;
    const pluginState =
      currentCtx?.pluginState instanceof Map ? currentCtx.pluginState : createPluginStateMap();
    if (!pluginState.has(AUTH_RUNTIME_KEY)) {
      publishPluginState(pluginState, AUTH_RUNTIME_KEY, authRuntime);
    }
    if (!currentCtx || currentCtx.pluginState !== pluginState) {
      c.set('slingshotCtx', {
        ...(currentCtx ?? {}),
        pluginState,
      } as unknown as AppEnv['Variables']['slingshotCtx']);
    }

    const existingActor = c.get('actor') as Actor | undefined;
    if (existingActor?.kind === 'api-key') {
      c.set('tokenPayload', c.get('tokenPayload') ?? null);
      await next();
      return;
    }

    const log = authRuntime.logger?.log ?? (() => {});
    const authTrace = authRuntime.logger?.authTrace ?? (() => {});
    const slingshotCtx =
      typeof (c as { get?: unknown }).get === 'function'
        ? ((c as { get(name: string): unknown }).get('slingshotCtx') as
            | { publicPaths?: Iterable<string> }
            | undefined)
        : undefined;

    if (isPublicPath(c.req.path, slingshotCtx?.publicPaths)) {
      c.set('tokenPayload', null);
      const tenantId = (c.get('tenantId') as string | null | undefined) ?? null;
      c.set('actor', Object.freeze({ ...ANONYMOUS_ACTOR, tenantId }) as Actor);
      await next();
      return;
    }

    const authConfig = authRuntime.config;
    const sessionRepo = authRuntime.repos.session;

    // Local identity state — accumulated during token verification, then
    // projected onto the Hono context and frozen as the canonical actor.
    let resolvedUserId: string | null = null;
    let resolvedSessionId: string | null = null;
    let resolvedRoles: string[] | null = null;
    let resolvedClientId: string | null = null;
    let resolvedTokenPayload: Record<string, unknown> | null = null;

    // cookie for browsers, x-user-token/Authorization headers for non-browser clients
    const token =
      readAuthCookie(c, COOKIE_TOKEN, isProd(), authConfig) ??
      c.req.header(HEADER_USER_TOKEN) ??
      readBearerToken(c.req.header('Authorization')) ??
      null;
    log(`[identify] token=${token ? 'present' : 'absent'}`);

    if (token) {
      try {
        const payload = await verifyToken(
          token,
          authConfig,
          authRuntime.signing ?? c.get('slingshotCtx').signing ?? null,
        );
        resolvedTokenPayload = payload;
        const sessionId = payload.sid as string | undefined;
        if (!sessionId) {
          // Check for M2M token (scope present, no sid)
          if (payload.scope && typeof payload.sub === 'string' && payload.sub.length > 0) {
            const client = authConfig.m2m
              ? await authRuntime.adapter.getM2MClient?.(payload.sub)
              : null;
            if (client?.active) {
              resolvedClientId = payload.sub;
              log(`[identify] M2M token for clientId=${payload.sub}`);
            } else {
              log('[identify] M2M token rejected — client missing, disabled, or M2M disabled');
            }
          } else {
            log('[identify] token missing sid claim — unauthenticated');
          }
        } else {
          const sub = payload.sub;
          if (!sub) {
            log('[identify] token missing sub claim — unauthenticated');
          } else {
            const stored = await sessionRepo.getSession(sessionId, authConfig);
            log('[identify] token verified, checking session...');
            authTrace(`[identify] userId=${sub}`);
            if (timingSafeEqual(stored ?? '', token)) {
              const signingCfg = authRuntime.signing ?? c.get('slingshotCtx').signing ?? null;
              const bindingCfg = signingCfg?.sessionBinding;

              if (bindingCfg) {
                const bindingOpts = typeof bindingCfg === 'object' ? bindingCfg : {};
                const fields: Array<'ip' | 'ua' | 'accept-language'> = bindingOpts.fields ?? [
                  'ip',
                  'ua',
                ];
                const onMismatch = bindingOpts.onMismatch ?? 'unauthenticate';

                const current = computeFingerprint(c, fields);
                const storedFp = await sessionRepo.getSessionFingerprint(sessionId);

                if (storedFp === null) {
                  // First authenticated request — store the fingerprint
                  sessionRepo.setSessionFingerprint(sessionId, current).catch(() => {
                    log('[identify] failed to store session fingerprint');
                  });
                  resolvedUserId = sub;
                  resolvedSessionId = sessionId;
                } else if (timingSafeEqual(storedFp, current)) {
                  resolvedUserId = sub;
                  resolvedSessionId = sessionId;
                } else {
                  log(`[identify] fingerprint mismatch, onMismatch=${onMismatch}`);
                  authTrace(`[identify] sessionId=${sessionId}`);
                  if (onMismatch === 'reject') {
                    throw new HttpError(401, 'Unauthorized', 'FINGERPRINT_MISMATCH');
                  } else if (onMismatch === 'log-only') {
                    resolvedUserId = sub;
                    resolvedSessionId = sessionId;
                  }
                  // onMismatch === "unauthenticate" — leave resolvedUserId null
                }
              } else {
                resolvedUserId = sub;
                resolvedSessionId = sessionId;
              }

              if (resolvedUserId) {
                if (authConfig.checkSuspensionOnIdentify) {
                  const suspensionStatus = await getSuspended(authRuntime.adapter, sub).catch(
                    () => ({ suspended: false }),
                  );
                  if (suspensionStatus.suspended) {
                    resolvedUserId = null;
                    resolvedSessionId = null;
                    resolvedRoles = null;
                    log(`[identify] userId=${sub} is suspended — unauthenticated`);
                  }
                }
              }

              if (resolvedUserId) {
                authTrace(`[identify] userId=${sub} sessionId=${sessionId}`);
                // Auto-enable lastActiveAt tracking when idleTimeout is configured
                if (authConfig.trackLastActive || authConfig.sessionPolicy.idleTimeout) {
                  sessionRepo.updateSessionLastActive(sessionId, authConfig).catch(() => {
                    log('[identify] failed to update session lastActiveAt');
                  });
                }
              }
            } else {
              log('[identify] token/session mismatch — unauthenticated');
            }
          }
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        log('[identify] invalid token — unauthenticated');
      }
    } else {
      log('[identify] no token — unauthenticated');
    }

    // Construct and publish the resolved actor — the canonical identity for this request.
    const resolvedTenantId = (c.get('tenantId') as string | null | undefined) ?? null;
    const actor: Actor = resolvedUserId
      ? {
          id: resolvedUserId,
          kind: 'user',
          tenantId: resolvedTenantId,
          sessionId: resolvedSessionId,
          roles: resolvedRoles,
          claims: {},
        }
      : resolvedClientId
        ? {
            id: resolvedClientId,
            kind: 'service-account',
            tenantId: resolvedTenantId,
            sessionId: null,
            roles: resolvedRoles,
            claims: {},
          }
        : { ...ANONYMOUS_ACTOR, tenantId: resolvedTenantId };
    c.set('actor', Object.freeze(actor) as Actor);
    c.set('tokenPayload', resolvedTokenPayload);

    await next();
  };
