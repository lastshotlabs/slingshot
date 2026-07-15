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

  /** Structured clone of the LIVE rules (staged patches not yet included). */
  readonly rules: Readonly<Record<string, unknown>>;

  /**
   * Structured clone of the rules patch staged for the next declared
   * boundary, or `null` when nothing is pending. Apps render this so the
   * rules sheet can mark pending values until they apply.
   */
  readonly stagedRulesPatch: Readonly<Record<string, unknown>> | null;

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
   * Pause a live session: freeze all timers (preserving remaining time) and
   * make the input pipeline reject submissions with code `SESSION_PAUSED`.
   *
   * Idempotent. Returns the updated snapshot, or `null` when the session is not
   * currently active.
   */
  pauseSession(sessionId: string): GameEngineActiveSessionSnapshot | null;

  /**
   * Resume a paused session: re-arm all timers with their remaining time and
   * re-open the input pipeline.
   *
   * Idempotent. Returns the updated snapshot, or `null` when the session is not
   * currently active.
   */
  resumeSession(sessionId: string): GameEngineActiveSessionSnapshot | null;

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

  /**
   * Move the host role to another player in the session.
   *
   * Persists `isHost` on the player rows and `hostUserId` on the session (so it
   * survives with or without a live runtime — a lobby has no runtime), enforces
   * the "exactly one host" invariant, and broadcasts `game:host.transferred`
   * when a runtime is active.
   *
   * The engine deliberately does NOT auto-transfer on a socket close: a
   * transient disconnect must not cost the host their role. Apps call this for
   * an explicit handoff, or to let players reclaim a match whose host is gone
   * for good (use room presence to decide "gone").
   *
   * Returns the updated snapshot, or `null` when no runtime is active (the
   * transfer is still persisted). Throws if the target is not a session member
   * or is a spectator.
   */
  transferHost(
    sessionId: string,
    newHostUserId: string,
  ): Promise<GameEngineActiveSessionSnapshot | null>;

  /**
   * Stage a rules patch on a live session, to apply at the next boundary the
   * game declares safe (`GameDefinition.applyStagedRules`, or an explicit
   * {@link applyStagedRules} call). Validates the merged result NOW and throws
   * `GameError(RULES_VALIDATION_FAILED)` on an invalid patch; broadcasts
   * `game:rules.staged`; persists immediately so a pending edit survives a
   * restart.
   *
   * Returns the full pending patch plus the phases it will apply at, or
   * `null` when the session has no live runtime (a lobby — apply directly to
   * the row instead).
   */
  stageRules(
    sessionId: string,
    patch: Record<string, unknown>,
  ): {
    staged: Record<string, unknown>;
    appliesAtPhases: readonly string[];
    snapshot: GameEngineActiveSessionSnapshot;
  } | null;

  /**
   * Apply the staged patch (if any) to the live rules right now — for games
   * whose safe boundary is an app-code moment rather than a phase entry.
   *
   * Returns the new live rules, `null` when nothing was staged, or `null`
   * when the session has no live runtime.
   */
  applyStagedRules(sessionId: string): Readonly<Record<string, unknown>> | null;

  /**
   * Apply a rules patch to the live rules IMMEDIATELY — for the fields a game
   * deliberately keeps instant (a kill-switch dial). `silent: true` skips the
   * `game:rules.applied` broadcast, preserving instant-and-silent semantics.
   *
   * Throws `GameError(RULES_VALIDATION_FAILED)` on an invalid patch. Returns
   * the new live rules, or `null` when the session has no live runtime.
   */
  updateRules(
    sessionId: string,
    patch: Record<string, unknown>,
    options?: { silent?: boolean },
  ): Readonly<Record<string, unknown>> | null;
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
