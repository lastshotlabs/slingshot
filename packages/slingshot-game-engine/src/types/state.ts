/**
 * Plugin state key and runtime state contract for `slingshot-game-engine`.
 *
 * Plugin state is stored in `getContext(app).pluginState` keyed by
 * {@link GAME_ENGINE_PLUGIN_STATE_KEY} (Rule 15, Rule 16).
 */
import type { GameEnginePluginConfig } from './config';
import type {
  ChannelRuntimeState,
  GameDefinition,
  GamePlayerState,
  InputAck,
  Leaderboard,
  ProcessHandlerContext,
} from './models';

/** Stable key used for reading or publishing the game-engine plugin state. */
export const GAME_ENGINE_PLUGIN_STATE_KEY = 'slingshot-game-engine';

/**
 * Read-only snapshot of one active game session runtime.
 *
 * The snapshot is safe for app-layer inspection and persistence projection.
 * It intentionally does not expose the mutable `SessionRuntime` internals.
 */
export interface GameEngineActiveSessionSnapshot {
  /** Active session id. */
  readonly sessionId: string;

  /** Registered game type name for the active runtime. */
  readonly gameType: string;

  /** Current phase name, or `null` before phase entry. */
  readonly currentPhase: string | null;

  /** Current sub-phase name, if one is active. */
  readonly currentSubPhase: string | null;

  /** Current 1-based round index tracked by the runtime. */
  readonly currentRound: number;

  /** Absolute phase end timestamp when a phase timer is active. */
  readonly phaseEndsAt: number | null;

  /** Structured clone of the public game state. */
  readonly gameState: Readonly<Record<string, unknown>>;

  /** Read-only player snapshot copied from the runtime roster. */
  readonly players: readonly Readonly<GamePlayerState>[];

  /** Open channel snapshots for the active phase. */
  readonly activeChannels: readonly ChannelRuntimeState[];

  /** Computed player and team leaderboard for the active runtime. */
  readonly leaderboard: Leaderboard;
}

/** Optional override input when advancing an active session phase. */
export interface GameEngineAdvancePhaseInput {
  /**
   * Explicit phase to enter next.
   *
   * When omitted, the engine resolves the next phase from the current phase
   * definition exactly as it would during normal runtime progression.
   */
  readonly nextPhase?: string;
}

/** Input payload for server-side submission into an active session channel. */
export interface GameEngineSubmitInput {
  /** Active channel name to receive the submission. */
  readonly channel: string;

  /** Player user id submitting the input. */
  readonly userId: string;

  /** Arbitrary channel payload validated by the active channel schema. */
  readonly data: unknown;

  /** Client-style sequence number for dedupe and acknowledgment. */
  readonly sequence: number;
}

/**
 * Mutation callback surface for a live active session.
 *
 * This intentionally exposes the engine's sanctioned handler context rather
 * than the underlying mutable `SessionRuntime` object.
 */
export interface GameEngineSessionMutationContext {
  /** Fresh snapshot of the active session before the mutation runs. */
  readonly snapshot: GameEngineActiveSessionSnapshot;

  /** Public handler mutation API used by game handlers. */
  readonly ctx: ProcessHandlerContext;

  /** Publish a raw message to the full session audience. */
  publishToSession(message: unknown): void;

  /** Publish a raw message to one player room. */
  publishToPlayer(userId: string, message: unknown): void;

  /** Publish a raw message to the host room. */
  publishToHost(message: unknown): void;
}

/** Result of a session mutation callback. */
export interface GameEngineSessionMutationResult<TResult> {
  /** Callback return value. */
  readonly value: TResult;

  /** Fresh snapshot after the mutation completed. */
  readonly snapshot: GameEngineActiveSessionSnapshot;
}

/**
 * Narrow app-facing control surface for active session runtimes.
 *
 * Apps should use this surface instead of reading mutable `SessionRuntime`
 * internals from plugin state.
 */
export interface GameEngineSessionControls {
  /** Return `true` when the session currently has a live runtime. */
  has(sessionId: string): boolean;

  /** Return a read-only snapshot for one active session, or `null` if inactive. */
  get(sessionId: string): GameEngineActiveSessionSnapshot | null;

  /** Return read-only snapshots for every active session runtime. */
  list(): readonly GameEngineActiveSessionSnapshot[];

  /**
   * Advance an active session to its next phase.
   *
   * Returns the updated runtime snapshot, or `null` when the session is not
   * currently active.
   */
  advancePhase(
    sessionId: string,
    input?: GameEngineAdvancePhaseInput,
  ): Promise<GameEngineActiveSessionSnapshot | null>;

  /**
   * Submit validated input to an active session as if it arrived over the
   * realtime protocol.
   *
   * Returns the input acknowledgment, or `null` when the session is inactive.
   */
  submitInput(sessionId: string, input: GameEngineSubmitInput): Promise<InputAck | null>;

  /**
   * Run an app-controlled mutation against a live session using the public
   * handler mutation surface.
   *
   * Returns the callback result plus an updated snapshot, or `null` when the
   * session is inactive.
   */
  mutate<TResult>(
    sessionId: string,
    mutator: (context: GameEngineSessionMutationContext) => TResult | Promise<TResult>,
  ): Promise<GameEngineSessionMutationResult<TResult> | null>;
}

/**
 * Runtime state stored in `getContext(app).pluginState`.
 *
 * Frozen via `deepFreeze()` at registration time (Rule 10).
 * Adapters are captured via closure during `buildAdapter` callbacks.
 */
export interface GameEnginePluginState {
  /** Frozen plugin config. */
  readonly config: Readonly<GameEnginePluginConfig>;

  /** Resolved session entity adapter. */
  readonly sessionAdapter: unknown;

  /** Resolved player entity adapter. */
  readonly playerAdapter: unknown;

  /** Closure-owned game registry. Maps game type name → definition. */
  readonly gameRegistry: ReadonlyMap<string, GameDefinition>;

  /** Narrow public control surface for active session runtimes. */
  readonly sessionControls: GameEngineSessionControls;
}
