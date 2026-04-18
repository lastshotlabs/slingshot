/**
 * Display router.
 *
 * Decides which WS rooms to publish to and what data to include.
 * The actual transport is slingshot's `ctx.wsPublish` responsibility.
 * Supports static relay configs, custom relay filters, and dynamic
 * relay re-evaluation per message for stream channels.
 *
 * See spec §13 for the full contract.
 */
import type {
  ChannelRelayConfig,
  GamePlayerState,
  PlayerInfo,
  ReadonlyHandlerContext,
  RelayFilterFunction,
} from '../types/models';

/** Room key formats for the game engine. */
export const ROOM_PREFIX = 'sessions';

/** Build a session broadcast room key. */
export function sessionRoom(sessionId: string): string {
  return `${ROOM_PREFIX}:${sessionId}:session`;
}

/** Build a host-only room key. */
export function hostRoom(sessionId: string): string {
  return `${ROOM_PREFIX}:${sessionId}:host`;
}

/** Build a per-player private room key. */
export function playerRoom(sessionId: string, userId: string): string {
  return `${ROOM_PREFIX}:${sessionId}:player:${userId}`;
}

/** Build a per-team room key. */
export function teamRoom(sessionId: string, teamName: string): string {
  return `${ROOM_PREFIX}:${sessionId}:team:${teamName}`;
}

/** Build a per-role room key. */
export function roleRoom(sessionId: string, roleName: string): string {
  return `${ROOM_PREFIX}:${sessionId}:role:${roleName}`;
}

/** Build a spectator room key. */
export function spectatorRoom(sessionId: string): string {
  return `${ROOM_PREFIX}:${sessionId}:spectators`;
}

/** Build a stream relay room key. */
export function streamRoom(sessionId: string, channelName: string): string {
  return `${ROOM_PREFIX}:${sessionId}:stream:${channelName}`;
}

/**
 * Parse a game room key into its components.
 *
 * @returns Parsed room info, or null if not a game room.
 */
export function parseGameRoom(room: string): {
  sessionId: string;
  roomType: 'session' | 'host' | 'player' | 'team' | 'role' | 'spectators' | 'stream';
  target: string | null;
} | null {
  const parts = room.split(':');
  if (parts[0] !== ROOM_PREFIX || parts.length < 3) return null;

  const sessionId = parts[1];
  const roomType = parts[2];

  switch (roomType) {
    case 'session':
    case 'host':
    case 'spectators':
      return { sessionId, roomType, target: null };
    case 'player':
    case 'team':
    case 'role':
    case 'stream':
      return {
        sessionId,
        roomType,
        target: parts[3] ?? null,
      };
    default:
      return null;
  }
}

/**
 * Resolve relay config to a list of target rooms.
 *
 * @param relay - The channel's relay config.
 * @param sessionId - Current session ID.
 * @param sender - The player who submitted input.
 * @param players - All players in the session.
 * @returns Array of room keys to publish to, and optionally a set of socket IDs to exclude.
 */
export function resolveRelayTargets(
  relay: ChannelRelayConfig,
  sessionId: string,
  sender: GamePlayerState,
  players: readonly GamePlayerState[],
): { rooms: string[]; excludeSenderSocket?: boolean } {
  if (relay === 'all') {
    return { rooms: [sessionRoom(sessionId)] };
  }

  if (relay === 'others') {
    return { rooms: [sessionRoom(sessionId)], excludeSenderSocket: true };
  }

  if (relay === 'same-team') {
    if (!sender.team) return { rooms: [] };
    return { rooms: [teamRoom(sessionId, sender.team)] };
  }

  if (relay === 'other-teams') {
    const teams = new Set<string>();
    for (const p of players) {
      if (p.team && p.team !== sender.team) {
        teams.add(p.team);
      }
    }
    return {
      rooms: [...teams].map(t => teamRoom(sessionId, t)),
    };
  }

  if (relay === 'none') {
    return { rooms: [] };
  }

  if (relay === 'custom') {
    // Custom relay is handled by the caller using relayFilters
    return { rooms: [] };
  }

  if (typeof relay === 'object') {
    if ('role' in relay) {
      return { rooms: [roleRoom(sessionId, relay.role)] };
    }
    if ('team' in relay) {
      return { rooms: [teamRoom(sessionId, relay.team)] };
    }
    if ('state' in relay) {
      const states = Array.isArray(relay.state) ? relay.state : [relay.state];
      const targetUsers = players.filter(
        p => p.playerState !== null && states.includes(p.playerState),
      );
      return {
        rooms: targetUsers.map(p => playerRoom(sessionId, p.userId)),
      };
    }
    if ('players' in relay) {
      const playerIds = Array.isArray(relay.players) ? relay.players : [relay.players];
      return {
        rooms: playerIds.map(id => playerRoom(sessionId, id)),
      };
    }
  }

  return { rooms: [] };
}

/**
 * Get all rooms a player should be subscribed to.
 */
export function getPlayerRooms(sessionId: string, player: GamePlayerState): string[] {
  const rooms = [sessionRoom(sessionId)];

  if (player.isSpectator) {
    rooms.push(spectatorRoom(sessionId));
  } else {
    rooms.push(playerRoom(sessionId, player.userId));

    if (player.isHost) {
      rooms.push(hostRoom(sessionId));
    }
    if (player.team) {
      rooms.push(teamRoom(sessionId, player.team));
    }
    if (player.role) {
      rooms.push(roleRoom(sessionId, player.role));
    }
  }

  return rooms;
}

// ── Custom Relay Filters ────────────────────────────────────────────

/**
 * Resolve a custom relay filter to target player rooms.
 *
 * When `relay` is `'custom'`, calls the game-defined relay filter
 * function which returns a list of target userIds. Each target
 * receives the message in their private room.
 *
 * @param filterName - Name of the filter function from `gameDef.relayFilters`.
 * @param relayFilters - The game definition's relay filter map.
 * @param sender - The player who submitted input.
 * @param input - The input data.
 * @param players - All players in the session.
 * @param ctx - Read-only handler context.
 * @param sessionId - The session ID.
 * @returns Array of room keys to publish to.
 */
export function resolveCustomRelayTargets(
  filterName: string,
  relayFilters: Readonly<Record<string, RelayFilterFunction>>,
  sender: GamePlayerState,
  input: unknown,
  players: readonly GamePlayerState[],
  ctx: ReadonlyHandlerContext,
  sessionId: string,
): string[] {
  if (!Object.prototype.hasOwnProperty.call(relayFilters, filterName)) {
    return [];
  }
  const filter = relayFilters[filterName];

  const senderInfo: PlayerInfo = {
    userId: sender.userId,
    displayName: sender.displayName,
    role: sender.role,
    team: sender.team,
    playerState: sender.playerState,
    connected: sender.connected,
  };

  const playerInfos: PlayerInfo[] = players.map(p => ({
    userId: p.userId,
    displayName: p.displayName,
    role: p.role,
    team: p.team,
    playerState: p.playerState,
    connected: p.connected,
  }));

  const targetUserIds = filter(senderInfo, input, playerInfos, ctx);
  return targetUserIds.map(uid => playerRoom(sessionId, uid));
}

/**
 * Resolve relay targets with support for both static configs and
 * custom relay filters. This is the primary relay resolution entry
 * point that handles all relay types including 'custom'.
 *
 * For stream channels with `dynamicRelay: true`, this should be
 * called per message rather than cached at channel open.
 */
export function resolveRelayTargetsFull(
  relay: ChannelRelayConfig,
  sessionId: string,
  sender: GamePlayerState,
  players: readonly GamePlayerState[],
  channelName: string | null,
  relayFilters: Readonly<Record<string, RelayFilterFunction>>,
  ctx: ReadonlyHandlerContext,
  input?: unknown,
): { rooms: string[]; excludeSenderSocket?: boolean } {
  if (relay === 'custom') {
    // Use the channel name as the relay filter key
    const filterKey = channelName ?? '';
    const rooms = resolveCustomRelayTargets(
      filterKey,
      relayFilters,
      sender,
      input,
      players,
      ctx,
      sessionId,
    );
    return { rooms };
  }

  return resolveRelayTargets(relay, sessionId, sender, players);
}
