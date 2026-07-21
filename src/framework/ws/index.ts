import { resolveRequestActor } from '@framework/lib/resolveRequestActor';
import type { Server } from 'bun';
import {
  COOKIE_TOKEN,
  HEADER_USER_TOKEN,
  setStandaloneClientIp,
} from '@lastshotlabs/slingshot-core';
import type { Actor, RequestActorResolver } from '@lastshotlabs/slingshot-core';

/**
 * Per-socket data attached to every WebSocket connection by the Bun server.
 *
 * This type is the `data` object passed to all `ws.*` handler callbacks
 * (`open`, `message`, `close`, `drain`). The generic `T` parameter lets
 * plugins attach custom fields (e.g., `roomId`) at upgrade time. The base
 * fields are populated by {@link createWsUpgradeHandler}.
 *
 * @template T - Additional per-connection fields merged into the base shape.
 */
export type SocketData<T extends object = object> = {
  /** Unique connection identifier (UUID v4), assigned on upgrade. */
  id: string;
  /**
   * Authenticated `Actor` for this connection. Resolves to `ANONYMOUS_ACTOR`
   * (`{ id: null, kind: 'anonymous', ... }`) for unauthenticated connections.
   */
  actor: Actor;
  /**
   * Request-scoped tenant identifier captured at upgrade time, or `null`
   * when no tenant context applies. Distinct from `actor.tenantId` which
   * carries identity-bound tenant scope.
   */
  requestTenantId: string | null;
  /** Set of room names this socket has joined. Managed by the WebSocket plugin. */
  rooms: Set<string>;
  /** Upgrade path this socket connected via, e.g. `"/chat"`. Used as a routing key. */
  endpoint: string;
  /** Session ID assigned on open when connection recovery is configured. */
  sessionId?: string;
} & T;

type BaseSocketData = SocketData;

/**
 * Create the default WebSocket upgrade handler for a Bun HTTP server.
 *
 * Resolves the authenticated `Actor` from the upgrade request's session cookie or
 * bearer token (via the optional `actorResolver`), then calls `server.upgrade()` to
 * promote the connection to a WebSocket. If the upgrade succeeds the handler returns
 * `undefined` (Bun expects no response for successful upgrades); on failure it returns
 * a 400 JSON error response.
 *
 * Requests without a credential may proceed as anonymous. A request that presents a
 * standard Slingshot credential but cannot resolve it is rejected with 401 so clients
 * can refresh or retry instead of opening a misleading anonymous connection.
 *
 * @param server - The Bun `Server` instance that owns this WebSocket connection.
 *   Typically `Bun.serve()`'s return value. Must be typed with `BaseSocketData`
 *   (or a compatible supertype) so `server.upgrade()` can attach the socket data.
 * @param endpoint - Route path this upgrade handler is mounted on (e.g., `"/chat"`).
 *   Stored in `SocketData.endpoint` for use in room routing and fanout.
 * @param actorResolver - Optional custom resolver that returns the authenticated
 *   `Actor` for the upgrade request. Uses anonymous when `null` or omitted.
 * @returns An async handler `(req: Request) => Promise<Response | undefined>`.
 *   Returns `undefined` on successful upgrade, or a `400` response on failure.
 *
 * @example
 * ```ts
 * const handler = createWsUpgradeHandler(server, '/chat');
 * app.get('/chat', async c => await handler(c.req.raw) ?? new Response(null));
 * ```
 */
export const createWsUpgradeHandler =
  (server: Server<BaseSocketData>, endpoint: string, actorResolver?: RequestActorResolver | null) =>
  async (req: Request): Promise<Response | undefined> => {
    try {
      const ip = server.requestIP(req)?.address;
      if (ip) setStandaloneClientIp(req, ip);
    } catch {
      // intentional — requestIP may throw in some environments
    }
    const credentialPresented = hasPresentedCredential(req);
    let resolved: Actor;
    try {
      resolved = await resolveRequestActor(req, actorResolver ?? null);
    } catch (error) {
      if (!credentialPresented) throw error;
      return Response.json({ error: 'Invalid or unavailable credentials' }, { status: 401 });
    }
    if (credentialPresented && resolved.kind === 'anonymous') {
      return Response.json({ error: 'Invalid or expired credentials' }, { status: 401 });
    }
    // Freeze the actor at the boundary (Rule 10) — downstream WS handlers
    // receive an immutable identity. ANONYMOUS_ACTOR is already pre-frozen.
    const actor = Object.isFrozen(resolved) ? resolved : Object.freeze(resolved);
    // requestTenantId is set to null at upgrade time — tenant middleware does not run
    // on WS upgrade. Consumers that need request-tenant scope on a socket should wrap
    // this handler with their own tenant resolver and merge into `data` before calling
    // `server.upgrade()`. `actor.tenantId` carries identity-bound tenant separately.
    const upgraded = server.upgrade(req, {
      data: {
        id: crypto.randomUUID(),
        actor,
        requestTenantId: null,
        rooms: new Set(),
        endpoint,
      },
    });
    return upgraded ? undefined : Response.json({ error: 'Upgrade failed' }, { status: 400 });
  };

function hasPresentedCredential(req: Request): boolean {
  const headerToken = req.headers.get(HEADER_USER_TOKEN)?.trim();
  if (headerToken) return true;

  const authorization = req.headers.get('authorization')?.trim();
  if (authorization && /^Bearer\s+\S+/i.test(authorization)) return true;

  const queryToken = new URL(req.url).searchParams.get('token')?.trim();
  if (queryToken) return true;

  const cookie = req.headers.get('cookie');
  return Boolean(
    cookie
      ?.split(';')
      .map(part => part.trim())
      .find(part => part.startsWith(`${COOKIE_TOKEN}=`))
      ?.slice(COOKIE_TOKEN.length + 1)
      .trim(),
  );
}
