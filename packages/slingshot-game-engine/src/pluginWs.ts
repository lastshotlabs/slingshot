/**
 * Game engine WebSocket endpoint wiring.
 *
 * Extracted from plugin.ts for maintainability. Wires WS incoming handlers,
 * close handlers, and reconnection flows onto the framework's WS endpoint map.
 *
 * @internal — not exported from the package public API.
 */
import type { SlingshotEventBus, WsPluginEndpoint } from '@lastshotlabs/slingshot-core';
import { listAdapterRecords } from './lib/adapterQuery';
import { sessionRoom, spectatorRoom } from './lib/display';
import { loadDisplaySessionFacts } from './lib/displayRuntime';
import { authorizeDisplayToken, verifyDisplayToken } from './lib/displayToken';
import { rejectInput } from './lib/input';
import { createGameRoomSubscribeGuard } from './lib/roomAccess';
import type { SessionRuntime } from './lib/sessionRuntime';
import {
  handleDisconnect,
  handleReconnectFlow,
  handleSubscribeConnection,
  processInputPipeline,
} from './lib/sessionRuntime';
import type { PlayerAdapterShape, SessionAdapterShape } from './pluginRoutes';
import type { GameDefinition } from './types/models';
import { type IncomingHandlerContext, buildIncomingDispatch } from './ws/incoming';

/** Dependencies for WS wiring. */
export interface PluginWsDeps {
  wsEndpoint: string;
  endpointMap: Record<string, WsPluginEndpoint | undefined>;
  gameRegistry: ReadonlyMap<string, GameDefinition>;
  activeRuntimes: Map<string, SessionRuntime>;
  sessionAdapter: SessionAdapterShape;
  playerAdapter: PlayerAdapterShape;
  bus: SlingshotEventBus;
  /** HMAC secret for display (TV) tokens. `null` disables casting. */
  displaySecret: string | readonly string[] | null;
}

/**
 * Wire WS incoming handlers onto the framework endpoint map.
 *
 * @internal
 */
export function wireWsEndpoint(deps: PluginWsDeps): void {
  const {
    wsEndpoint,
    endpointMap,
    gameRegistry,
    activeRuntimes,
    sessionAdapter,
    playerAdapter,
    bus,
    displaySecret,
  } = deps;

  // Wire resolveSession callback (section 5.10.9)
  const resolveSession = async (sessionId: string) => {
    const session = await sessionAdapter.getById(sessionId);
    if (!session) return null;
    const players = await listAdapterRecords(playerAdapter, { sessionId });
    const gameDef = gameRegistry.get(session.gameType as string);
    if (!gameDef) return null;
    return {
      session: {
        id: session.id as string,
        gameType: session.gameType as string,
        status: session.status as string,
        hostUserId: session.hostUserId as string,
      },
      players: players.map(p => ({
        userId: p.userId as string,
        displayName: (p.displayName ?? '') as string,
        role: (p.role ?? null) as string | null,
        team: (p.team ?? null) as string | null,
        playerState: (p.playerState ?? null) as string | null,
        score: (p.score ?? 0) as number,
        connected: (p.connected ?? true) as boolean,
        isHost: (p.isHost ?? false) as boolean,
        isSpectator: (p.isSpectator ?? false) as boolean,
        joinOrder: (p.joinOrder ?? 0) as number,
      })),
      gameDef,
      runtime: activeRuntimes.get(sessionId),
    };
  };

  // Wire processInput callback (section 5.10.5)
  const processInput = async (
    sessionId: string,
    channel: string,
    userId: string,
    data: unknown,
    sequence: number,
    epoch?: number,
  ) => {
    const runtime = activeRuntimes.get(sessionId);
    if (!runtime) {
      return rejectInput('SESSION_NOT_FOUND', 'No active runtime for session.', sequence);
    }
    return processInputPipeline(runtime, channel, userId, data, sequence, epoch);
  };

  // Wire handleReconnect callback (section 5.10.7)
  const handleReconnect = async (
    sessionId: string,
    userId: string,
    subscribe: (room: string) => void,
    ack: (data: unknown) => void,
    publish: (room: string, data: unknown) => void,
  ) => {
    const runtime = activeRuntimes.get(sessionId);
    if (!runtime) return;
    return handleReconnectFlow(runtime, userId, subscribe, ack, publish);
  };

  // Wire restoreConnection callback (#4) — subscribe treated as reconnect.
  const restoreConnection = async (
    sessionId: string,
    userId: string,
    publish: (room: string, data: unknown) => void,
  ): Promise<boolean> => {
    const runtime = activeRuntimes.get(sessionId);
    if (!runtime) return false;
    return handleSubscribeConnection(runtime, userId, publish);
  };

  const incomingHandlers = buildIncomingDispatch({
    resolveSession,
    processInput,
    handleReconnect,
    restoreConnection,
    getSessionEpoch: sessionId => activeRuntimes.get(sessionId)?.inputEpoch ?? null,
    bus,
  });

  const endpoint = (endpointMap[wsEndpoint] ??= {});
  const incoming: NonNullable<typeof endpoint.incoming> =
    endpoint.incoming === undefined ? {} : { ...endpoint.incoming };

  // Wire real WS transport per slingshot-chat pattern (section 5.10.9)
  for (const handler of incomingHandlers) {
    incoming[handler.event] = {
      auth: 'userAuth',
      handler: (
        ws: unknown,
        payload: unknown,
        context: {
          socketId: string;
          actor: import('@lastshotlabs/slingshot-core').Actor;
          requestTenantId: string | null;
          endpoint: string;
          publish(room: string, data: unknown): void;
          subscribe(room: string): void;
          unsubscribe(room: string): void;
        },
      ) => {
        const wsSocket = ws as { send(data: string): void };
        const wsCtx: IncomingHandlerContext = {
          actorId: context.actor.id ?? '',
          socketId: context.socketId,
          payload,
          ack: data => wsSocket.send(JSON.stringify(data)),
          publish: (room, data) => context.publish(room, data),
          subscribe: room => context.subscribe(room),
          unsubscribe: room => context.unsubscribe(room),
        };
        return handler.handler(wsCtx);
      },
    };
  }
  // ── game:display.subscribe — a TV joins ────────────────────────────────────
  //
  // `auth: 'none'` because a cast TV has no session and never will. The token in
  // the PAYLOAD is the credential, and this handler verifies it itself.
  //
  // Note what is NOT happening here: this socket never acquires a user actor. So
  // every other handler above — `game:input` included — is still `auth: 'userAuth'`
  // and still rejects it, without a single check written by this function.
  // **Read-only is a property of the socket's identity, not of code remembering
  // to be careful.** That is the whole reason the token produces `id: null`.
  incoming['game:display.subscribe'] = {
    auth: 'none',
    handler: (
      ws: unknown,
      payload: unknown,
      context: {
        socketId: string;
        publish(room: string, data: unknown): void;
        subscribe(room: string): void;
        unsubscribe(room: string): void;
      },
    ) => {
      const wsSocket = ws as {
        send(data: string): void;
        data?: { displaySessionId?: string };
      };
      const deny = (reason: string): void => {
        wsSocket.send(
          JSON.stringify({
            event: 'game:display.denied',
            error: { code: 'DISPLAY_TOKEN_INVALID', reason },
          }),
        );
      };

      const body = (payload ?? {}) as { token?: unknown };
      const token = typeof body.token === 'string' ? body.token : null;
      if (token === null) {
        deny('malformed');
        return;
      }
      if (displaySecret === null) {
        deny('unsupported');
        return;
      }

      const verified = verifyDisplayToken(token, { secret: displaySecret });
      if (!verified.ok) {
        deny(verified.reason);
        return;
      }

      return (async () => {
        const facts = await loadDisplaySessionFacts(sessionAdapter, verified.claims.sessionId);
        const authorized = authorizeDisplayToken(verified.claims, facts);
        if (!authorized.ok) {
          deny(authorized.reason);
          return;
        }

        const sessionId = verified.claims.sessionId;

        // Stamp the socket. `createGameRoomSubscribeGuard` reads this, and it is
        // the ONLY thing that writes it — so its presence is proof the token was
        // verified AND authorized, not merely presented.
        if (wsSocket.data) wsSocket.data.displaySessionId = sessionId;

        // The public feed, and nothing else. Not `host`, not `player:*`, not
        // `team:*` — the guard denies those to a display socket anyway, but we
        // never even ask.
        context.subscribe(sessionRoom(sessionId));
        context.subscribe(spectatorRoom(sessionId));

        wsSocket.send(JSON.stringify({ event: 'game:display.subscribed', sessionId }));
      })();
    },
  };

  endpoint.incoming = incoming;

  // Close the room-subscription hole AND scope display sockets. Until now the
  // engine set no guard, so the framework's default applied — and that one only
  // protects `player:*` rooms, leaving `sessions:<id>:host` (and every other
  // session's rooms) open to any authenticated socket. See lib/roomAccess.ts.
  endpoint.onRoomSubscribe = createGameRoomSubscribeGuard({
    activeRuntimes,
    getPlayerAdapter: () => playerAdapter,
  });

  // Wire WS close handler for disconnect detection (section 2)
  endpoint.on ??= {};
  endpoint.on.close = async ws => {
    const wsData = ws as {
      data: {
        actor: { id: string | null };
        id: string;
        rooms: Set<string>;
        endpoint: string;
      };
    };
    const userId = wsData.data.actor.id;
    if (!userId) return;

    // Await disconnect handling so cleanup completes before the socket is fully released.
    // Also iterate all runtimes — a user may be in multiple sessions.
    const disconnectPromises: Promise<void>[] = [];
    for (const [, runtime] of activeRuntimes) {
      if (runtime.players.has(userId)) {
        disconnectPromises.push(handleDisconnect(runtime, userId));
      }
    }
    await Promise.allSettled(disconnectPromises);
  };
}
