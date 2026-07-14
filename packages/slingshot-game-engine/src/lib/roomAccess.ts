/**
 * Who may subscribe to which game room.
 *
 * ## Why this exists (it fixes a live hole, not just a new feature)
 *
 * The framework's `defaultRoomSubscribeGuard` protects exactly one thing: a
 * `…:player:<uid>` room may only be joined by `<uid>`. **Everything else returns
 * `true`.** The game engine never set an `onRoomSubscribe`, so until now any
 * authenticated socket could subscribe to:
 *
 *   - `sessions:<id>:host` — the HOST-ONLY room. `broadcastTo('host', …)` and
 *     `publishToHost()` are real APIs that games use to send the host things the
 *     table is not supposed to see. Any player could read them.
 *   - any room of any OTHER session — watch a stranger's game by guessing an id.
 *   - `…:team:<t>` for a team the socket is not on.
 *
 * That was true in all four shipped games. This guard closes it, and doing so
 * correctly is also exactly what a display token needs, so the two land together.
 *
 * ## The rule
 *
 * You may only subscribe to rooms of a session you are actually in, and only to
 * the rooms within it that are yours:
 *
 *   | room          | who                                        |
 *   |---------------|--------------------------------------------|
 *   | `session`     | any member (player, spectator) — or a display |
 *   | `spectators`  | any member — or a display                    |
 *   | `host`        | the host, and nobody else                    |
 *   | `player:<u>`  | `<u>`, and nobody else                        |
 *   | `team:<t>`    | members of team `<t>`                         |
 *   | `role:<r>`    | members with role `<r>`                       |
 *   | `stream:<c>`  | any member                                    |
 *
 * A **display** socket (a TV) is a member of nothing. It gets `session` and
 * `spectators` on the one session its token names — the public broadcast feed,
 * the same thing every other client in the room already sees on their phone — and
 * nothing else. It is explicitly denied `host`, `player`, `team` and `role`.
 *
 * Anonymous sockets get nothing.
 */
import type { PlayerAdapterShape } from '../pluginRoutes';
import { listAdapterRecords } from './adapterQuery';
import { parseGameRoom } from './display';
import type { SessionRuntime } from './sessionRuntime';

/** The bits of a socket this guard reads. */
interface GuardSocket {
  data?: {
    actor?: { id?: string | null; kind?: string } | undefined;
    /**
     * Stamped by the `game:display.subscribe` handler once a display token has
     * been verified AND authorized. Its presence is proof, so nothing else may
     * ever write it.
     */
    displaySessionId?: string | undefined;
  };
}

/** A player's membership facts, from the runtime when it exists and the DB when it doesn't. */
interface Membership {
  readonly isHost: boolean;
  readonly team: string | null;
  readonly role: string | null;
}

async function resolveMembership(
  sessionId: string,
  userId: string,
  activeRuntimes: Map<string, SessionRuntime>,
  getPlayerAdapter: () => PlayerAdapterShape,
): Promise<Membership | null> {
  // Fast path: a live runtime already knows the roster.
  const runtime = activeRuntimes.get(sessionId);
  const seated = runtime?.players.get(userId);
  if (seated) {
    return {
      isHost: seated.isHost === true,
      team: seated.team ?? null,
      role: seated.role ?? null,
    };
  }

  // Slow path: THE LOBBY. There is no runtime before the game starts, which is
  // precisely when the TV and the players are connecting. A guard that only
  // consulted the runtime would deny every subscribe in the lobby.
  const rows = await listAdapterRecords(getPlayerAdapter(), { sessionId, userId });
  const row = rows.at(0);
  if (!row) return null;
  return {
    isHost: row.isHost === true,
    team: (row.team ?? null) as string | null,
    role: (row.role ?? null) as string | null,
  };
}

/**
 * Build the game endpoint's `onRoomSubscribe` guard.
 *
 * Replaces `defaultRoomSubscribeGuard` for the game WS endpoint.
 */
export function createGameRoomSubscribeGuard(deps: {
  readonly activeRuntimes: Map<string, SessionRuntime>;
  readonly getPlayerAdapter: () => PlayerAdapterShape;
}): (ws: unknown, room: string) => Promise<boolean> {
  const { activeRuntimes, getPlayerAdapter } = deps;

  return async (ws: unknown, room: string): Promise<boolean> => {
    const socket = ws as GuardSocket;
    const actorId = socket.data?.actor?.id ?? null;
    const displaySessionId = socket.data?.displaySessionId ?? null;

    const parsed = parseGameRoom(room);

    if (parsed === null) {
      // Not a game room. Keep the framework's default protection for private
      // per-user rooms rather than silently loosening anything we don't model.
      const match = /(?:^|:)player:(.+)$/.exec(room);
      if (!match) return true;
      return actorId !== null && actorId === match[1];
    }

    const { sessionId, roomType, target } = parsed;

    // ── A display (a TV). Read-only, one session, public feed only. ──────────
    if (displaySessionId !== null) {
      if (sessionId !== displaySessionId) return false;
      return roomType === 'session' || roomType === 'spectators';
    }

    // ── Anonymous sockets get nothing. ──────────────────────────────────────
    if (actorId === null) return false;

    // ── A seated user. Must actually be in THIS session. ─────────────────────
    const membership = await resolveMembership(
      sessionId,
      actorId,
      activeRuntimes,
      getPlayerAdapter,
    );
    if (membership === null) return false;

    switch (roomType) {
      case 'session':
      case 'spectators':
      case 'stream':
        return true;
      case 'host':
        return membership.isHost;
      case 'player':
        return target === actorId;
      case 'team':
        return membership.team !== null && membership.team === target;
      case 'role':
        return membership.role !== null && membership.role === target;
      default:
        return false;
    }
  };
}
