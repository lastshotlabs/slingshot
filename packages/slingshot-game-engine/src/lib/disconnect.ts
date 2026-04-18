/**
 * Disconnection and reconnection handling.
 *
 * Grace periods, state snapshots, turn behavior on disconnect,
 * host transfer, and reconnection flow.
 *
 * See spec §21 for the full contract.
 */
import type {
  GameDisconnectConfig,
  GamePlayerState,
  ReadonlyHandlerContext,
} from '../types/models';

/** Resolved disconnect configuration with defaults applied. */
export interface ResolvedDisconnectConfig {
  readonly gracePeriodMs: number;
  readonly maxDisconnects: number;
  readonly pauseOnDisconnect: 'never' | 'always' | 'turn-player';
  readonly turnBehavior: 'skip' | 'timeout' | 'auto-action' | 'pause';
  readonly autoActionHandler: string | null;
}

/** Default disconnect config values. */
export const DEFAULT_DISCONNECT_CONFIG: ResolvedDisconnectConfig = {
  gracePeriodMs: 60_000,
  maxDisconnects: 5,
  pauseOnDisconnect: 'never',
  turnBehavior: 'skip',
  autoActionHandler: null,
};

/** Mutable disconnect tracking state for an active session. */
export interface MutableDisconnectState {
  /** Maps userId to their grace period timer ID. */
  graceTimers: Map<string, string>;
  /** Maps userId to their state snapshot at disconnect time. */
  snapshots: Map<string, DisconnectSnapshot>;
}

/** Snapshot of a player's state at disconnect time. */
export interface DisconnectSnapshot {
  readonly userId: string;
  readonly disconnectedAt: number;
  readonly wasActivePlayer: boolean;
  readonly turnTimeRemaining: number | null;
  readonly playerState: string | null;
}

/** Create initial disconnect state. */
export function createDisconnectState(): MutableDisconnectState {
  return {
    graceTimers: new Map(),
    snapshots: new Map(),
  };
}

/**
 * Resolve disconnect configuration from game definition and plugin defaults.
 *
 * Per-game overrides take precedence over plugin-level defaults.
 */
export function resolveDisconnectConfig(
  pluginConfig: Partial<ResolvedDisconnectConfig>,
  gameConfig: GameDisconnectConfig | null,
  ctx?: ReadonlyHandlerContext,
): ResolvedDisconnectConfig {
  const base: ResolvedDisconnectConfig = {
    ...DEFAULT_DISCONNECT_CONFIG,
    ...pluginConfig,
  };

  if (!gameConfig) return base;

  let gracePeriodMs = base.gracePeriodMs;
  if (gameConfig.gracePeriodMs !== undefined) {
    gracePeriodMs =
      typeof gameConfig.gracePeriodMs === 'function' && ctx
        ? gameConfig.gracePeriodMs(ctx)
        : typeof gameConfig.gracePeriodMs === 'number'
          ? gameConfig.gracePeriodMs
          : gracePeriodMs;
  }

  return {
    gracePeriodMs,
    maxDisconnects: gameConfig.maxDisconnects ?? base.maxDisconnects,
    pauseOnDisconnect: gameConfig.pauseOnDisconnect ?? base.pauseOnDisconnect,
    turnBehavior: gameConfig.turnBehavior ?? base.turnBehavior,
    autoActionHandler: gameConfig.autoActionHandler ?? base.autoActionHandler,
  };
}

/**
 * Record a player disconnect and create a snapshot.
 *
 * @returns The snapshot created for reconnection restoration.
 */
export function recordDisconnect(
  state: MutableDisconnectState,
  player: GamePlayerState,
  activePlayerId: string | null,
  turnTimeRemaining: number | null,
): DisconnectSnapshot {
  const snapshot: DisconnectSnapshot = {
    userId: player.userId,
    disconnectedAt: Date.now(),
    wasActivePlayer: player.userId === activePlayerId,
    turnTimeRemaining,
    playerState: player.playerState,
  };

  state.snapshots.set(player.userId, snapshot);
  return snapshot;
}

/**
 * Record a grace period timer for a disconnected player.
 */
export function setGraceTimer(
  state: MutableDisconnectState,
  userId: string,
  timerId: string,
): void {
  state.graceTimers.set(userId, timerId);
}

/**
 * Get the grace period timer ID for a disconnected player.
 */
export function getGraceTimerId(state: MutableDisconnectState, userId: string): string | null {
  return state.graceTimers.get(userId) ?? null;
}

/**
 * Clear disconnect state for a reconnecting player.
 *
 * @returns The snapshot from disconnect time, or null if not found.
 */
export function clearDisconnect(
  state: MutableDisconnectState,
  userId: string,
): DisconnectSnapshot | null {
  const snapshot = state.snapshots.get(userId) ?? null;
  state.snapshots.delete(userId);
  state.graceTimers.delete(userId);
  return snapshot;
}

/**
 * Check if a player has exceeded the maximum disconnect count.
 */
export function isOverDisconnectLimit(
  disconnectCount: number,
  config: ResolvedDisconnectConfig,
): boolean {
  if (config.maxDisconnects === 0) return false;
  return disconnectCount >= config.maxDisconnects;
}

/**
 * Determine whether the game should pause on this disconnect.
 */
export function shouldPauseOnDisconnect(
  config: ResolvedDisconnectConfig,
  isActivePlayer: boolean,
): boolean {
  switch (config.pauseOnDisconnect) {
    case 'always':
      return true;
    case 'turn-player':
      return isActivePlayer;
    case 'never':
    default:
      return false;
  }
}

/**
 * Determine how to handle a disconnected player's turn.
 *
 * @returns The resolved turn behavior.
 */
export function resolveTurnBehavior(
  config: ResolvedDisconnectConfig,
): 'skip' | 'timeout' | 'auto-action' | 'pause' {
  return config.turnBehavior;
}

/**
 * Select the next host after the current host disconnects.
 *
 * Picks the longest-connected remaining player (lowest joinOrder).
 *
 * @returns The userId of the new host, or null if no players remain.
 */
export function selectNewHost(
  players: readonly GamePlayerState[],
  disconnectedHostId: string,
): string | null {
  const candidates = players.filter(
    p => p.userId !== disconnectedHostId && p.connected && !p.isSpectator,
  );

  if (candidates.length === 0) return null;

  // Sort by joinOrder ascending — lowest is longest-connected
  candidates.sort((a, b) => a.joinOrder - b.joinOrder);
  return candidates[0].userId;
}

/**
 * Check if all non-spectator players are disconnected.
 */
export function areAllPlayersDisconnected(players: readonly GamePlayerState[]): boolean {
  const activePlayers = players.filter(p => !p.isSpectator);
  return activePlayers.length > 0 && activePlayers.every(p => !p.connected);
}

/**
 * Build a state snapshot for a reconnecting player.
 *
 * Returns the data structure defined in §21.4 step 5.
 */
export function buildReconnectionSnapshot(
  sessionId: string,
  session: {
    status: string;
    currentPhase: string | null;
    currentSubPhase: string | null;
    rules: Record<string, unknown>;
  },
  players: readonly GamePlayerState[],
  gameState: Record<string, unknown>,
  privateState: unknown,
  activePlayer: string | null,
  channels: ReadonlyMap<
    string,
    {
      name: string;
      mode: string;
      open: boolean;
      endsAt: number | null;
    }
  >,
  scores: ReadonlyMap<string, number>,
  phaseEndsAt: number | null,
): Record<string, unknown> {
  const channelData: Record<string, unknown> = {};
  for (const [name, ch] of channels) {
    channelData[name] = {
      name: ch.name,
      mode: ch.mode,
      open: ch.open,
      endsAt: ch.endsAt,
    };
  }

  const scoreData: Record<string, number> = {};
  for (const [userId, score] of scores) {
    scoreData[userId] = score;
  }

  return {
    type: 'game:state.snapshot',
    sessionId,
    session: {
      status: session.status,
      currentPhase: session.currentPhase,
      currentSubPhase: session.currentSubPhase,
      rules: session.rules,
    },
    players: players.map(p => ({
      userId: p.userId,
      displayName: p.displayName,
      role: p.role,
      team: p.team,
      playerState: p.playerState,
      score: p.score,
      connected: p.connected,
      isHost: p.isHost,
      isSpectator: p.isSpectator,
    })),
    gameState,
    privateState,
    currentPhase: session.currentPhase,
    currentSubPhase: session.currentSubPhase,
    phaseEndsAt,
    activePlayer,
    channels: channelData,
    scores: scoreData,
  };
}

// ── Channel Disconnect Behavior (§21.3) ─────────────────────────────

/** Behavior specification per channel mode when a player disconnects. */
export type ChannelDisconnectAction =
  | { action: 'abstain' }
  | { action: 'stop-sending' }
  | { action: 'apply-turn-behavior' }
  | { action: 'no-effect' };

/**
 * Determine the channel behavior when a player disconnects.
 *
 * Returns the action to take per channel mode as specified in §21.3.
 */
export function getChannelDisconnectBehavior(
  channelMode: string,
  isActivePlayer: boolean,
): ChannelDisconnectAction {
  switch (channelMode) {
    case 'collect':
      // Slot = null (didn't submit). Channel can still complete.
      return { action: 'abstain' };
    case 'race':
      // Can't participate. If only eligible, channel times out.
      return { action: 'stop-sending' };
    case 'stream':
      // Stops sending/receiving.
      return { action: 'stop-sending' };
    case 'turn':
      // Apply turnBehavior if it's their turn
      return isActivePlayer ? { action: 'apply-turn-behavior' } : { action: 'no-effect' };
    case 'vote':
      // Abstention. Channel can still complete.
      return { action: 'abstain' };
    case 'free':
      // Stops sending. No effect on others.
      return { action: 'stop-sending' };
    default:
      return { action: 'no-effect' };
  }
}

// ── Replacement Players (§21.6) ─────────────────────────────────────

/** Result of a player replacement. */
export interface ReplacementResult {
  readonly oldUserId: string;
  readonly newUserId: string;
  readonly newDisplayName: string;
  /** Fields transferred from old player record. */
  readonly transferred: {
    readonly score: number;
    readonly role: string | null;
    readonly team: string | null;
    readonly playerState: string | null;
  };
}

/**
 * Prepare a player replacement transfer.
 *
 * Computes the transfer data — the caller handles actual entity
 * updates, room revocation/subscription, and broadcasting.
 */
export function prepareReplacement(
  oldPlayer: GamePlayerState,
  newUserId: string,
  newDisplayName: string,
): ReplacementResult {
  return {
    oldUserId: oldPlayer.userId,
    newUserId,
    newDisplayName,
    transferred: {
      score: oldPlayer.score,
      role: oldPlayer.role,
      team: oldPlayer.team,
      playerState: oldPlayer.playerState,
    },
  };
}

// ── AFK Detection (§14.9) ───────────────────────────────────────────

/** Mutable AFK tracking state for a session. */
export interface MutableAfkState {
  /** Maps userId → last input timestamp. */
  lastInputAt: Map<string, number>;
  /** Maps userId → consecutive turn timeouts. */
  consecutiveTurnTimeouts: Map<string, number>;
  /** Set of userIds currently flagged AFK. */
  afkPlayers: Set<string>;
}

/** Create initial AFK state. */
export function createAfkState(): MutableAfkState {
  return {
    lastInputAt: new Map(),
    consecutiveTurnTimeouts: new Map(),
    afkPlayers: new Set(),
  };
}

/**
 * Record player input activity (resets AFK timers).
 */
export function recordPlayerActivity(state: MutableAfkState, userId: string): void {
  state.lastInputAt.set(userId, Date.now());
  state.consecutiveTurnTimeouts.set(userId, 0);
  state.afkPlayers.delete(userId);
}

/**
 * Record a turn timeout for a player.
 *
 * @returns `true` if the player should be flagged AFK (exceeded threshold).
 */
export function recordTurnTimeout(
  state: MutableAfkState,
  userId: string,
  maxConsecutiveTimeouts: number,
): boolean {
  const count = (state.consecutiveTurnTimeouts.get(userId) ?? 0) + 1;
  state.consecutiveTurnTimeouts.set(userId, count);

  if (count >= maxConsecutiveTimeouts) {
    state.afkPlayers.add(userId);
    return true;
  }
  return false;
}

/**
 * Check if a player is AFK based on inactivity threshold.
 *
 * @param thresholdMs - Inactivity threshold in milliseconds (default: 60000).
 * @returns `true` if the player has been inactive past the threshold.
 */
export function checkInactivityAfk(
  state: MutableAfkState,
  userId: string,
  thresholdMs = 60_000,
): boolean {
  const lastInput = state.lastInputAt.get(userId);
  if (lastInput === undefined) return false;

  const inactive = Date.now() - lastInput >= thresholdMs;
  if (inactive) {
    state.afkPlayers.add(userId);
  }
  return inactive;
}

/**
 * Check if a player is currently flagged as AFK.
 */
export function isPlayerAfk(state: MutableAfkState, userId: string): boolean {
  return state.afkPlayers.has(userId);
}

// ── Grace Period Expiry Actions (§21.5) ─────────────────────────────

/** Actions to take when a grace period expires. */
export interface GraceExpiryActions {
  /** Whether to unpause the game (if it was paused for this player). */
  unpause: boolean;
  /** Whether to skip the player's turn. */
  skipTurn: boolean;
  /** Whether all players are now disconnected (trigger abandonment). */
  allDisconnected: boolean;
}

/**
 * Determine the actions to take when a grace period expires.
 */
export function resolveGraceExpiry(
  config: ResolvedDisconnectConfig,
  snapshot: DisconnectSnapshot,
  players: readonly GamePlayerState[],
): GraceExpiryActions {
  const unpause =
    config.pauseOnDisconnect === 'always' ||
    (config.pauseOnDisconnect === 'turn-player' && snapshot.wasActivePlayer);

  const skipTurn =
    snapshot.wasActivePlayer && (config.turnBehavior === 'skip' || config.turnBehavior === 'pause');

  const allDisconnected = areAllPlayersDisconnected(players);

  return { unpause, skipTurn, allDisconnected };
}
