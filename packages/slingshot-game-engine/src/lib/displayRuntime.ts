/**
 * The HTTP half of display tokens: minting, revoking, and turning a token on a
 * request into a `kind: 'display'` actor.
 *
 * See `displayToken.ts` for the threat model. The single most important property
 * is repeated here because everything else depends on it:
 *
 *   **The display actor has `id: null`.** Slingshot's `userAuth` requires
 *   `kind === 'user'` AND a non-null `id`, so a display token cannot satisfy
 *   `userAuth` anywhere, in any package, now or later. Every existing app route
 *   that guards on `getActorId(c)` already rejects it — including routes written
 *   before display tokens existed. Apps opt IN explicitly; they never opt out.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { Actor, AppEnv } from '@lastshotlabs/slingshot-core';
import { getActor, getContext, getSlingshotCtx } from '@lastshotlabs/slingshot-core';
import type { SessionAdapterShape } from '../pluginRoutes';
import {
  type DisplaySessionFacts,
  authorizeDisplayToken,
  readDisplayTokenFromRequest,
  verifyDisplayToken,
} from './displayToken';

/** Claim key carrying the verified session id on a display actor. */
const DISPLAY_SESSION_CLAIM = 'displaySessionId';

/**
 * Resolve the app's HMAC signing secret.
 *
 * Display tokens are signed with the same secret as every other framework
 * signature. An app with no signing secret cannot mint them — and we fail closed
 * with a clear message rather than inventing a key nobody can rotate.
 */
export function resolveSigningSecret(c: Context<AppEnv>): string | readonly string[] | null {
  const signing = getSlingshotCtx(c).signing;
  const secret = signing?.secret ?? null;
  if (secret === null || secret === undefined) return null;
  if (Array.isArray(secret)) return secret.length > 0 ? (secret as string[]) : null;
  return typeof secret === 'string' && secret.length > 0 ? secret : null;
}

/**
 * The signing secret, resolved from the app (not a request).
 *
 * Used at WS-wiring time, where there is no Hono `Context`. Returns `null` when
 * the app configured no signing secret — casting is then simply unavailable, and
 * says so, rather than falling back to an unrotatable invented key.
 */
export function resolveContextSigningSecret(app: object): string | readonly string[] | null {
  const signing = (getContext(app as never) as { signing?: { secret?: unknown } | null }).signing;
  const secret = signing?.secret ?? null;
  if (secret === null || secret === undefined) return null;
  if (Array.isArray(secret)) {
    const keys = secret.filter((k): k is string => typeof k === 'string' && k.length > 0);
    return keys.length > 0 ? keys : null;
  }
  return typeof secret === 'string' && secret.length > 0 ? secret : null;
}

/** Read a session record down to the facts display authorization needs. */
export async function loadDisplaySessionFacts(
  adapter: SessionAdapterShape,
  sessionId: string,
): Promise<DisplaySessionFacts | null> {
  const session = await adapter.getById(sessionId);
  if (!session) return null;
  return {
    id: session.id as string,
    status: (session.status ?? 'lobby') as string,
    displayEpoch: Number(session.displayEpoch ?? 0),
  };
}

/** The frozen actor a valid display token produces. */
function displayActor(sessionId: string, tokenId: string): Actor {
  return Object.freeze({
    // `null` ON PURPOSE — this is the load-bearing security property. See above.
    id: null,
    kind: 'display' as const,
    tenantId: null,
    sessionId: null,
    roles: null,
    claims: Object.freeze({ displaySessionId: sessionId, displayTokenId: tokenId }),
  });
}

/**
 * Middleware: if the request carries a display token, verify it and publish a
 * display actor.
 *
 * An **invalid** token is a hard 401 with a specific reason, rather than a silent
 * downgrade to anonymous. A silently-ignored token is exactly the bug this whole
 * feature exists to fix: the TV showed the home screen and nobody could tell why.
 * An **absent** token is not an error — the request is simply anonymous and normal
 * auth applies.
 */
export function createDisplayTokenMiddleware(deps: {
  readonly getSessionAdapter: () => SessionAdapterShape;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = readDisplayTokenFromRequest({
      query: name => c.req.query(name),
      header: name => c.req.header(name),
    });
    if (token === null) {
      await next();
      return;
    }

    const secret = resolveSigningSecret(c);
    if (secret === null) {
      return c.json(
        { error: { code: 'DISPLAY_TOKEN_UNSUPPORTED', message: 'Signing is not configured.' } },
        503,
      );
    }

    const verified = verifyDisplayToken(token, { secret });
    if (!verified.ok) {
      return c.json(
        { error: { code: 'DISPLAY_TOKEN_INVALID', message: `Display token ${verified.reason}.` } },
        401,
      );
    }

    const facts = await loadDisplaySessionFacts(
      deps.getSessionAdapter(),
      verified.claims.sessionId,
    );
    const authorized = authorizeDisplayToken(verified.claims, facts);
    if (!authorized.ok) {
      return c.json(
        {
          error: { code: 'DISPLAY_TOKEN_INVALID', message: `Display token ${authorized.reason}.` },
        },
        401,
      );
    }

    c.set('actor', displayActor(verified.claims.sessionId, verified.claims.tokenId));
    await next();
  };
}

/**
 * The session this request is a display for, or `null`.
 *
 * This is the ONLY sanctioned way an app authorizes a TV. Use it to widen a route
 * that would otherwise require a user:
 *
 * ```ts
 * const userId  = getActorId(c);                    // null for a TV
 * const display = getDisplaySessionId(c);           // the session, for a TV
 * if (!userId && display !== match.gameSessionId) return c.json(…, 401);
 * ```
 *
 * Note what this does NOT do: it never returns a user id, so a display can never
 * be mistaken for a player by any code that reads identity the normal way.
 */
export function getDisplaySessionId(c: Context<AppEnv>): string | null {
  const actor = getActor(c);
  // The actor IS the record. Reading the session off the verified actor's claims
  // — rather than a parallel context variable — means there is exactly one thing
  // to trust, and it cannot drift out of step with the identity it describes.
  if (actor.kind !== 'display') return null;
  const value = actor.claims[DISPLAY_SESSION_CLAIM];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** True when this request is a display bound to `sessionId`. */
export function isDisplayFor(c: Context<AppEnv>, sessionId: string): boolean {
  return getDisplaySessionId(c) === sessionId;
}
