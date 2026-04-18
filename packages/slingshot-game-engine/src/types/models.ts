/**
 * All game domain model types.
 *
 * Shared types live in this dedicated file (Rule 6). These types are
 * consumed by lib/, entities/, operations/, plugin.ts, and exported
 * via the `./types` subpath for client SDK use.
 */
import type { z } from 'zod';

// ── Session & Player Runtime State ────────────────────────────────

/** Session status state machine states. */
export type SessionStatus = 'lobby' | 'starting' | 'playing' | 'paused' | 'completed' | 'abandoned';

/** Runtime session state visible to clients. */
export interface GameSessionState {
  readonly id: string;
  readonly gameType: string;
  readonly status: SessionStatus;
  readonly hostUserId: string;
  readonly joinCode: string | null;
  readonly currentPhase: string | null;
  readonly currentSubPhase: string | null;
  readonly currentRound: number;
  readonly rules: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly startedAt: string | null;
}

/** Runtime player state visible to clients. */
export interface GamePlayerState {
  readonly userId: string;
  readonly displayName: string;
  readonly role: string | null;
  readonly team: string | null;
  readonly playerState: string | null;
  readonly score: number;
  readonly connected: boolean;
  readonly isHost: boolean;
  readonly isSpectator: boolean;
  readonly joinOrder: number;
}

// ── Game Definition ───────────────────────────────────────────────

/** Validated, frozen output of `defineGame()`. */
export interface GameDefinition {
  readonly name: string;
  readonly display: string;
  readonly description: string;
  readonly version: string;
  readonly icon: string;
  readonly tags: readonly string[];
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly allowSpectators: boolean;
  readonly maxSpectators: number;
  readonly roles: Readonly<Record<string, RoleDefinition>>;
  readonly roleVisibility: Readonly<Record<string, RoleVisibilityRule>>;
  readonly teams: Readonly<TeamDefinition> | null;
  readonly rules: z.ZodType;
  readonly presets: Readonly<Record<string, Record<string, unknown>>>;
  readonly content: Readonly<ContentDefinition> | null;
  readonly playerStates: readonly string[];
  readonly initialPlayerState: string | null;
  readonly phases: Readonly<Record<string, PhaseDefinition>>;
  readonly loop: Readonly<GameLoopDefinition> | null;
  readonly sync: Readonly<SyncDefinition>;
  readonly scoring: Readonly<ScoringDefinition> | null;
  readonly handlers: Readonly<Record<string, HandlerFunction>>;
  readonly hooks: Readonly<GameLifecycleHooks>;
  readonly checkWinCondition: ((ctx: ReadonlyHandlerContext) => WinResult | null) | null;
  readonly relayFilters: Readonly<Record<string, RelayFilterFunction>>;
  readonly rngSeed: 'random' | 'fixed' | 'session-id';
  readonly disconnect: Readonly<GameDisconnectConfig> | null;
}

/**
 * Input shape passed to `defineGame()`. Accepts partial/optional fields
 * that are resolved to full `GameDefinition` with defaults.
 */
export interface GameDefinitionInput<
  TRules extends z.ZodType = z.ZodType,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- positional type parameter for future use
  TGameState extends Record<string, unknown> = Record<string, unknown>,
  TContent extends z.ZodType | undefined = undefined,
> {
  name: string;
  display: string;
  description?: string;
  version?: string;
  icon?: string;
  tags?: string[];
  minPlayers: number;
  maxPlayers: number;
  allowSpectators?: boolean;
  maxSpectators?: number;
  roles?: Record<string, RoleDefinition>;
  roleVisibility?: Record<string, RoleVisibilityRule>;
  teams?: TeamDefinition;
  rules: TRules;
  presets?: Record<string, Partial<z.infer<TRules>>>;
  content?: ContentDefinition<TContent>;
  playerStates?: string[];
  initialPlayerState?: string;
  phases: Record<string, PhaseDefinition>;
  loop?: GameLoopDefinition;
  sync?: SyncDefinition;
  scoring?: ScoringDefinition;
  handlers: Record<string, HandlerFunction>;
  hooks?: GameLifecycleHooks;
  checkWinCondition?: (ctx: ReadonlyHandlerContext) => WinResult | null;
  relayFilters?: Record<string, RelayFilterFunction>;
  rngSeed?: 'random' | 'fixed' | 'session-id';
  disconnect?: GameDisconnectConfig;
}

// ── Roles ─────────────────────────────────────────────────────────

/** Role definition within a game type. */
export interface RoleDefinition {
  count: number | 'remaining' | ((ctx: RoleAssignmentContext) => number);
  enabled?: boolean | ((ctx: RoleAssignmentContext) => boolean);
  display?: string;
  description?: string;
}

/** Context available during role assignment. */
export interface RoleAssignmentContext {
  readonly rules: Readonly<Record<string, unknown>>;
  readonly playerCount: number;
  readonly teamCount: number;
}

/** Rule controlling which other roles a given role can see. */
export type RoleVisibilityRule =
  | { sees: string[] }
  | {
      sees: (playerCount: number, rules: Readonly<Record<string, unknown>>) => string[];
    };

// ── Teams ─────────────────────────────────────────────────────────

/** Team configuration for a game type. */
export interface TeamDefinition {
  count: number | ((ctx: { rules: Record<string, unknown>; playerCount: number }) => number);
  names?: string[];
  colors?: string[];
  assignment: 'auto' | 'draft' | 'random' | 'self-select';
  allowUneven?: boolean;
  minPerTeam?: number;
  maxPerTeam?: number;
  roleConstraints?: Record<string, number>;
}

// ── Phases ─────────────────────────────────────────────────────────

/** Phase advance trigger strategy. */
export type PhaseAdvanceTrigger =
  | 'auto'
  | 'timeout'
  | 'manual'
  | 'all-channels-complete'
  | 'any-channel-complete';

/** Phase definition within a game's phase graph. */
export interface PhaseDefinition {
  next: string | null | ((ctx: ReadonlyHandlerContext) => string | null);
  enabled?: boolean | ((ctx: ReadonlyHandlerContext) => boolean);
  advance?: PhaseAdvanceTrigger;
  timeout?: number | ((ctx: ReadonlyHandlerContext) => number);
  delay?: number | ((ctx: ReadonlyHandlerContext) => number);
  channels?: Record<string, ChannelDefinition>;
  subPhases?: Record<string, SubPhaseDefinition>;
  subPhaseOrder?: string[];
  loop?: boolean;
  onEnter?: string;
  onExit?: string;
  display?: Record<string, string>;
}

/** Sub-phase definition within a parent phase. */
export interface SubPhaseDefinition {
  enabled?: boolean | ((ctx: ReadonlyHandlerContext) => boolean);
  advance?: PhaseAdvanceTrigger;
  timeout?: number | ((ctx: ReadonlyHandlerContext) => number);
  delay?: number | ((ctx: ReadonlyHandlerContext) => number);
  channels?: Record<string, ChannelDefinition>;
  onEnter?: string;
  onExit?: string;
  display?: Record<string, string>;
}

// ── Channels ──────────────────────────────────────────────────────

/** Channel interaction mode. */
export type ChannelMode = 'collect' | 'race' | 'stream' | 'turn' | 'vote' | 'free';

/**
 * Who can submit input to a channel.
 *
 * String literals cover common patterns. Object forms filter by
 * role, state, team, or dynamic player subsets. Function form
 * is fully custom.
 */
export type ChannelFromConfig =
  | 'all-players'
  | 'active-player'
  | 'other-players'
  | 'host'
  | { role: string }
  | { role: string; state: string }
  | { role: string; team: string }
  | { state: string }
  | { state: string[] }
  | { team: string }
  | { players: string | string[] }
  | ((ctx: ReadonlyHandlerContext, userId: string) => boolean);

/**
 * Where processed inputs or channel events are relayed.
 */
export type ChannelRelayConfig =
  | 'all'
  | 'others'
  | 'same-team'
  | 'other-teams'
  | 'none'
  | { role: string }
  | { state: string }
  | { state: string[] }
  | { team: string }
  | { players: string | string[] }
  | 'custom';

/** Base channel definition shared by all modes. */
export interface ChannelDefinition {
  mode: ChannelMode;
  enabled?: boolean | ((ctx: ReadonlyHandlerContext) => boolean);
  from: ChannelFromConfig;
  relay: ChannelRelayConfig;
  schema: z.ZodType;
  process?: string;
  timeout?: number | ((ctx: ReadonlyHandlerContext) => number);
  rateLimit?: { max: number; per: number };
  persist?: boolean | { maxCount?: number; ttlSeconds?: number };

  // Collect mode
  allowChange?: boolean;
  revealMode?: 'immediate' | 'after-close' | 'never';
  shuffleOnReveal?: boolean;

  // Race mode
  count?: number | ((ctx: ReadonlyHandlerContext) => number);
  onClaimed?: string;
  onTimeout?: string;
  latencyCompensation?: { enabled: boolean; maxCompensationMs: number };

  // Stream mode
  buffer?: boolean;
  dynamicRelay?: boolean;

  // Turn mode
  turnOrder?: 'sequential' | 'random' | 'custom';
  multi?: boolean;
  turnTimeout?: number | ((ctx: ReadonlyHandlerContext) => number);
  onTurnTimeout?: string;
  completeWhen?: 'one-round' | 'all-passed' | 'handler';
  passSchema?: z.ZodType;

  // Vote mode
  anonymous?: boolean;
  tieBreaker?: string;
}

// ── Channel Runtime State ─────────────────────────────────────────

/** Runtime state of an active channel. */
export interface ChannelRuntimeState {
  readonly name: string;
  readonly mode: ChannelMode;
  readonly open: boolean;
  readonly startedAt: number;
  readonly endsAt: number | null;
  readonly submissions: ReadonlyMap<string, { input: unknown; submittedAt: number }>;
  readonly claimedBy: readonly string[];
  readonly complete: boolean;
}

// ── Turn Order ────────────────────────────────────────────────────

/** Runtime turn order state. */
export interface TurnState {
  readonly order: readonly string[];
  readonly activeIndex: number;
  readonly activePlayer: string | null;
  readonly acted: ReadonlySet<string>;
  readonly cycleCount: number;
  readonly direction: 1 | -1;
}

// ── Game Loop ─────────────────────────────────────────────────────

/** Game loop configuration from a game definition. */
export interface GameLoopDefinition {
  tickRate: number;
  onTick: string;
  maxOverrunMs?: number;
}

// ── Sync ──────────────────────────────────────────────────────────

/** State sync configuration. */
export interface SyncDefinition {
  mode: 'event' | 'delta' | 'snapshot';
  fullSnapshotEvery?: number;
  interpolationWindowMs?: number;
  scopedSync?: boolean;
  scopeHandler?: string;
}

// ── Scoring ───────────────────────────────────────────────────────

/** Scoring configuration. */
export interface ScoringDefinition {
  mode: 'cumulative' | 'per-round' | 'elimination' | 'custom';
  teamScoring?: boolean;
  display?: {
    label?: string;
    showChange?: boolean;
    showRank?: boolean;
    showStreak?: boolean;
    sortDirection?: 'desc' | 'asc';
  };
  maxScore?: number | ((ctx: ReadonlyHandlerContext) => number);
}

/** Single score entry. */
export interface ScoreEntry {
  readonly userId: string;
  readonly score: number;
  readonly rank: number;
}

/** Team score entry. */
export interface TeamScoreEntry {
  readonly team: string;
  readonly score: number;
  readonly rank: number;
}

/** Computed leaderboard. */
export interface Leaderboard {
  readonly players: readonly ScoreEntry[];
  readonly teams: readonly TeamScoreEntry[];
}

// ── Content ───────────────────────────────────────────────────────

/** Content definition for a game type. */
export interface ContentDefinition<TContent extends z.ZodType | undefined = undefined> {
  schema?: TContent;
  providers?: Record<string, ContentProviderDefinition>;
  required?: boolean;
  userContent?: boolean;
}

/** A named content provider. */
export interface ContentProviderDefinition {
  inputSchema?: z.ZodType;
  load: (input: unknown) => unknown;
  validate?: (data: unknown) => boolean;
}

// ── Handlers ──────────────────────────────────────────────────────

/** Handler function signature. All handlers receive ProcessHandlerContext. */
export type HandlerFunction = (
  ctx: ProcessHandlerContext,
  ...args: unknown[]
) => undefined | Promise<void> | HandlerResult | Promise<HandlerResult>;

/** Result returned by a handler. */
export interface HandlerResult {
  valid?: boolean;
  reason?: string;
  data?: unknown;
  reject?: boolean;
}

/** Relay filter function for custom channel relay. */
export type RelayFilterFunction = (
  sender: PlayerInfo,
  input: unknown,
  players: PlayerInfo[],
  ctx: ReadonlyHandlerContext,
) => string[];

/** Minimal player info passed to relay filters and hooks. */
export interface PlayerInfo {
  readonly userId: string;
  readonly displayName: string;
  readonly role: string | null;
  readonly team: string | null;
  readonly playerState: string | null;
  readonly connected: boolean;
}

// ── Win Result ────────────────────────────────────────────────────

/** Result of a completed game. */
export interface WinResult {
  winners?: string[];
  winningTeam?: string;
  reason: string;
  draw?: boolean;
  rankings?: Array<{ userId: string; rank: number; score: number }>;
}

// ── Input Pipeline ────────────────────────────────────────────────

/** Acknowledgment sent to a client after input processing. */
export interface InputAck {
  accepted: boolean;
  code?: string;
  reason?: string;
  sequence?: number;
  data?: unknown;
  details?: unknown;
}

/** Buffered input from a stream channel (consumed in tick handler). */
export interface BufferedInput {
  readonly userId: string;
  readonly data: unknown;
  readonly timestamp: number;
}

/** Scheduled event for the game loop. */
export interface ScheduledEvent {
  readonly id: string;
  readonly type: string;
  readonly data: unknown;
  readonly firesAtTick: number;
}

// ── Vote Tally ────────────────────────────────────────────────────

/** Vote tally result for a vote channel. */
export interface VoteTally {
  readonly options: ReadonlyMap<string, number>;
  readonly winner: string | null;
  readonly tie: boolean;
  readonly totalVotes: number;
  readonly votes?: ReadonlyMap<string, string>;
}

// ── Timers ─────────────────────────────────────────────────────────

/** Server-authoritative game timer. */
export interface GameTimer {
  readonly id: string;
  readonly type: 'phase' | 'channel' | 'turn' | 'custom';
  readonly sessionId: string;
  readonly startedAt: number;
  readonly duration: number;
  readonly endsAt: number;
  readonly pausedAt: number | null;
  readonly remainingAtPause: number | null;
  readonly callback: string;
  readonly data?: unknown;
}

// ── Replay ────────────────────────────────────────────────────────

/** Single entry in the replay log. */
export interface ReplayEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly timestamp: number;
  readonly type: ReplayEventType;
  readonly data: unknown;
}

/** All replay event types. */
export type ReplayEventType =
  | 'session.created'
  | 'session.started'
  | 'session.completed'
  | 'session.abandoned'
  | 'session.paused'
  | 'session.resumed'
  | 'player.joined'
  | 'player.left'
  | 'player.disconnected'
  | 'player.reconnected'
  | 'player.stateChanged'
  | 'player.replaced'
  | 'phase.entered'
  | 'phase.exited'
  | 'subPhase.entered'
  | 'subPhase.exited'
  | 'channel.opened'
  | 'channel.closed'
  | 'channel.input'
  | 'channel.race.claimed'
  | 'channel.vote.tally'
  | 'turn.advanced'
  | 'score.changed'
  | 'timer.started'
  | 'timer.expired'
  | 'timer.cancelled'
  | 'state.updated'
  | 'rng.called'
  | 'error';

// ── WS Protocol Messages ─────────────────────────────────────────

/** Client → Server WS message types. */
export type ClientToServerMessage =
  | { type: 'game:subscribe'; sessionId: string }
  | { type: 'game:reconnect'; sessionId: string }
  | { type: 'game:unsubscribe'; sessionId: string }
  | {
      type: 'game:input';
      sessionId: string;
      channel: string;
      data: unknown;
      sequence: number;
    }
  | { type: 'game:stream.subscribe'; sessionId: string; channel: string }
  | { type: 'game:stream.unsubscribe'; sessionId: string; channel: string };

/** Server → Client WS message types. */
export type ServerToClientMessage =
  | { type: 'game:state.snapshot'; sessionId: string; [key: string]: unknown }
  | {
      type: 'game:phase.entered';
      sessionId: string;
      phase: string;
      subPhase: string | null;
      timeout: number | null;
      phaseEndsAt: number | null;
    }
  | {
      type: 'game:phase.pending';
      sessionId: string;
      phase: string;
      delay: number;
      startsAt: number;
    }
  | {
      type: 'game:subPhase.entered';
      sessionId: string;
      phase: string;
      subPhase: string;
    }
  | {
      type: 'game:channel.opened';
      sessionId: string;
      channel: string;
      mode: string;
      timeout: number | null;
      channelEndsAt: number | null;
    }
  | {
      type: 'game:channel.closed';
      sessionId: string;
      channel: string;
      reason: string;
    }
  | {
      type: 'game:channel.input';
      sessionId: string;
      channel: string;
      userId: string;
      data: unknown;
      timestamp: number;
    }
  | {
      type: 'game:channel.race.claimed';
      sessionId: string;
      channel: string;
      userId: string;
      claimedAt: number;
    }
  | {
      type: 'game:channel.vote.tally';
      sessionId: string;
      channel: string;
      tally: VoteTally;
    }
  | {
      type: 'game:channel.collect.revealed';
      sessionId: string;
      channel: string;
      inputs: Array<{ userId: string; input: unknown }>;
    }
  | {
      type: 'game:input.ack';
      sessionId: string;
      channel: string;
      sequence: number;
      accepted: boolean;
      code?: string;
      reason?: string;
      data?: unknown;
      details?: unknown;
    }
  | {
      type: 'game:state.updated';
      sessionId: string;
      data: Record<string, unknown>;
    }
  | {
      type: 'game:state.delta';
      sessionId: string;
      tick: number;
      patches: unknown[];
      timestamp: number;
    }
  | { type: 'game:privateState.updated'; sessionId: string; data: unknown }
  | {
      type: 'game:player.joined';
      sessionId: string;
      player: GamePlayerState;
    }
  | { type: 'game:player.left'; sessionId: string; userId: string }
  | { type: 'game:player.disconnected'; sessionId: string; userId: string }
  | { type: 'game:player.reconnected'; sessionId: string; userId: string }
  | {
      type: 'game:player.stateChanged';
      sessionId: string;
      userId: string;
      previousState: string;
      newState: string;
    }
  | {
      type: 'game:player.replaced';
      sessionId: string;
      oldUserId: string;
      newUserId: string;
    }
  | {
      type: 'game:host.transferred';
      sessionId: string;
      newHostUserId: string;
    }
  | {
      type: 'game:score.changed';
      sessionId: string;
      userId: string;
      score: number;
      change: number;
      breakdown?: unknown;
    }
  | {
      type: 'game:turn.advanced';
      sessionId: string;
      activePlayer: string;
      turnEndsAt: number | null;
    }
  | {
      type: 'game:timer.updated';
      sessionId: string;
      phaseEndsAt: number;
    }
  | { type: 'game:session.started'; sessionId: string }
  | { type: 'game:session.paused'; sessionId: string }
  | { type: 'game:session.resumed'; sessionId: string }
  | {
      type: 'game:session.completed';
      sessionId: string;
      winResult: WinResult;
    }
  | {
      type: 'game:stream.data';
      sessionId: string;
      channel: string;
      userId: string;
      data: unknown;
      timestamp: number;
    }
  | {
      type: 'game:error';
      sessionId: string;
      code: string;
      message: string;
      details?: unknown;
    };

// ── Session Mutex ─────────────────────────────────────────────────

/** Session-level async mutex for serializing state mutations. */
export interface SessionMutex {
  acquire(): Promise<() => void>;
}

// ── Disconnect Config (per-game override) ─────────────────────────

/** Per-game disconnect configuration (overrides plugin-level defaults). */
export interface GameDisconnectConfig {
  gracePeriodMs?: number | ((ctx: ReadonlyHandlerContext) => number);
  maxDisconnects?: number;
  pauseOnDisconnect?: 'never' | 'always' | 'turn-player';
  turnBehavior?: 'skip' | 'timeout' | 'auto-action' | 'pause';
  autoActionHandler?: string;
}

// ── Handler Contexts ──────────────────────────────────────────────

/**
 * Full mutation API available to all game handlers.
 *
 * Process handlers, onEnter, onExit, onTick, lifecycle hooks, and
 * win condition checks all receive this context (or the read-only subset).
 */
export interface ProcessHandlerContext {
  // Session info (read-only)
  readonly sessionId: string;
  readonly gameType: string;
  readonly rules: Readonly<Record<string, unknown>>;
  readonly currentPhase: string;
  readonly currentSubPhase: string | null;
  readonly currentRound: number;

  // Game state (mutable)
  gameState: Record<string, unknown>;

  // Private state
  getPrivateState(userId: string): unknown;
  setPrivateState(userId: string, data: unknown): void;
  updatePrivateState(userId: string, updater: (current: unknown) => unknown): void;

  // Player queries
  getPlayer(userId: string): Readonly<GamePlayerState>;
  getPlayers(): readonly Readonly<GamePlayerState>[];
  getPlayersByRole(role: string): readonly Readonly<GamePlayerState>[];
  getPlayersByTeam(team: string): readonly Readonly<GamePlayerState>[];
  getPlayersByState(state: string): readonly Readonly<GamePlayerState>[];
  getConnectedPlayers(): readonly Readonly<GamePlayerState>[];
  getDisconnectedPlayers(): readonly Readonly<GamePlayerState>[];

  // Player mutations
  setPlayerState(userId: string, state: string): void;
  setPlayerStates(userIds: string[], state: string): void;

  // Turn order
  getActivePlayer(): string | null;
  getTurnOrder(): readonly string[];
  setTurnOrder(order: string[]): void;
  setActivePlayer(userId: string): void;
  reverseTurnOrder(): void;
  skipNextPlayer(): void;
  skipPlayer(userId: string): void;
  insertNextPlayer(userId: string): void;
  rotateTurnStart(): void;
  completeTurnCycle(): void;
  getActedCount(): number;
  getActedPlayers(): string[];
  getRemainingPlayers(): string[];

  // Scoring
  addScore(userId: string, points: number, breakdown?: Record<string, unknown>): void;
  setScore(userId: string, points: number): void;
  getScore(userId: string): number;
  getLeaderboard(): Array<{ userId: string; score: number; rank: number }>;
  getTeamScores(): Array<{ team: string; score: number; rank: number }>;
  getPlayerStreak(userId: string): number;

  // Phase control
  advancePhase(): void;
  setNextPhase(phase: string): void;
  setCurrentRound(round: number): void;
  incrementRound(): void;

  // Channel control
  closeChannel(channelName: string): void;
  getChannelState(channelName: string): ChannelRuntimeState;
  getChannelInputs(channelName: string): Map<string, { input: unknown; submittedAt: number }>;

  // Timer control
  extendTimer(ms: number): void;
  resetTimer(ms: number): void;
  getTimeRemaining(): number;
  getPhaseEndsAt(): number;

  // RNG
  random: SeededRng;

  // Scheduled events (game loop only)
  scheduleEvent(delayTicks: number, type: string, data: unknown): string;
  cancelScheduledEvent(eventId: string): boolean;
  getScheduledEvents(): Array<{
    id: string;
    type: string;
    data: unknown;
    firesAtTick: number;
  }>;
  consumeBufferedInputs(channel: string): BufferedInput[];
  consumeScheduledEvents(): ScheduledEvent[];

  // State broadcasting
  broadcastState(data: Record<string, unknown>): void;
  broadcastTo(audience: string, data: Record<string, unknown>): void;
  sendToPlayer(userId: string, data: unknown): void;

  // Child sessions
  createChildSession(
    gameType: string,
    players: string[],
    rules?: Record<string, unknown>,
  ): Promise<{ sessionId: string }>;
  getChildSessionResult(sessionId: string): Promise<WinResult | null>;

  // Game end
  endGame(result: WinResult): void;

  // Logging
  log: {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
}

/**
 * Read-only subset of ProcessHandlerContext.
 *
 * Used for `enabled` conditions, `checkWinCondition`, dynamic config
 * resolution (`timeout: (ctx) => ...`), and `next` function resolution.
 */
export interface ReadonlyHandlerContext {
  readonly sessionId: string;
  readonly gameType: string;
  readonly rules: Readonly<Record<string, unknown>>;
  readonly currentPhase: string;
  readonly currentSubPhase: string | null;
  readonly currentRound: number;
  readonly gameState: Readonly<Record<string, unknown>>;

  getPrivateState(userId: string): unknown;
  getPlayer(userId: string): Readonly<GamePlayerState>;
  getPlayers(): readonly Readonly<GamePlayerState>[];
  getPlayersByRole(role: string): readonly Readonly<GamePlayerState>[];
  getPlayersByTeam(team: string): readonly Readonly<GamePlayerState>[];
  getPlayersByState(state: string): readonly Readonly<GamePlayerState>[];
  getConnectedPlayers(): readonly Readonly<GamePlayerState>[];
  getDisconnectedPlayers(): readonly Readonly<GamePlayerState>[];

  getActivePlayer(): string | null;
  getTurnOrder(): readonly string[];
  getActedCount(): number;
  getActedPlayers(): string[];
  getRemainingPlayers(): string[];

  getScore(userId: string): number;
  getLeaderboard(): Array<{ userId: string; score: number; rank: number }>;
  getTeamScores(): Array<{ team: string; score: number; rank: number }>;
  getPlayerStreak(userId: string): number;

  getChannelState(channelName: string): ChannelRuntimeState;
  getChannelInputs(channelName: string): Map<string, { input: unknown; submittedAt: number }>;

  getTimeRemaining(): number;
  getPhaseEndsAt(): number;

  random: SeededRng;

  getScheduledEvents(): Array<{
    id: string;
    type: string;
    data: unknown;
    firesAtTick: number;
  }>;

  log: {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
}

// ── Seeded RNG ────────────────────────────────────────────────────

/** Seeded PRNG interface exposed to handlers via `ctx.random`. */
export interface SeededRng {
  int(min: number, max: number): number;
  float(min: number, max: number): number;
  dice(count: number, sides: number): number[];
  shuffle<T>(array: T[]): T[];
  pick<T>(array: T[], count?: number): T | T[];
  weighted<T>(items: Array<{ value: T; weight: number }>): T;
  bool(probability?: number): boolean;
  seed(): number;
}

// ── Lifecycle Hooks ───────────────────────────────────────────────

/** Lifecycle hooks for a game definition. */
export interface GameLifecycleHooks {
  onSessionCreated?: (ctx: ProcessHandlerContext) => void | Promise<void>;
  onGameStart?: (
    ctx: ProcessHandlerContext,
  ) => undefined | Promise<void> | { cancel: true; reason: string };
  onGameEnd?: (ctx: ProcessHandlerContext, result: WinResult) => void | Promise<void>;
  onPhaseEnter?: (ctx: ProcessHandlerContext, phase: string) => void | Promise<void>;
  onPhaseExit?: (ctx: ProcessHandlerContext, phase: string) => void | Promise<void>;
  onTurnStart?: (ctx: ProcessHandlerContext, userId: string) => void | Promise<void>;
  onTurnEnd?: (ctx: ProcessHandlerContext, userId: string) => void | Promise<void>;
  onInput?: (
    ctx: ProcessHandlerContext,
    channel: string,
    userId: string,
    data: unknown,
  ) => void | Promise<void>;
  onPlayerJoined?: (ctx: ProcessHandlerContext, player: GamePlayerState) => void | Promise<void>;
  onPlayerDisconnected?: (
    ctx: ProcessHandlerContext,
    player: GamePlayerState,
  ) => void | Promise<void>;
  onPlayerReconnected?: (
    ctx: ProcessHandlerContext,
    player: GamePlayerState,
  ) => void | Promise<void>;
  onAllPlayersDisconnected?: (
    ctx: ProcessHandlerContext,
  ) => undefined | Promise<void> | { abandon: false } | Promise<{ abandon: false }>;
}
