/**
 * Session Runtime Manager.
 *
 * Per-session state owner that composes all lib/ modules into a running game.
 * Each active game session gets one `SessionRuntime` instance stored in a
 * closure-owned `Map<string, SessionRuntime>` inside the plugin factory.
 *
 * See spec §5.10 for the full contract.
 *
 * @internal — not exported from the package public API.
 */
import type { HookServices } from '@lastshotlabs/slingshot-core';
import { GameError, GameErrorCode } from '../errors';
import type { RateLimitBackend, ReplayStore } from '../types/adapters';
import type {
  GameDefinition,
  GamePlayerState,
  InputAck,
  ReplayEntry,
  SeededRng,
  WinResult,
} from '../types/models';
import type { MutableChannelState } from './channels';
import { closeChannel, createChannelState, recordSubmission } from './channels';
import type { MutableChildSessionState } from './childSessions';
import { createChildSessionState, getChildSessionResult } from './childSessions';
import type { MutableAfkState, MutableDisconnectState } from './disconnect';
import {
  areAllPlayersDisconnected,
  buildReconnectionSnapshot,
  clearDisconnect,
  createAfkState,
  createDisconnectState,
  getChannelDisconnectBehavior,
  getGraceTimerId,
  recordDisconnect,
  recordPlayerActivity,
  resolveDisconnectConfig,
  resolveTurnBehavior,
  setGraceTimer,
} from './disconnect';
import { getPlayerRooms, resolveRelayTargetsFull, sessionRoom } from './display';
import type { MutableGameLoopState } from './gameLoop';
import { bufferInput, createGameLoopState, startGameLoop, stopGameLoop } from './gameLoop';
import type { HandlerContextDeps } from './handlers';
import { buildProcessHandlerContext, buildReadonlyHandlerContext } from './handlers';
import {
  createHookErrorHandler,
  invokeOnAllPlayersDisconnected,
  invokeOnGameEnd,
  invokeOnGameStart,
  invokeOnInput,
  invokeOnPhaseEnter,
  invokeOnPhaseExit,
  invokeOnPlayerDisconnected,
  invokeOnPlayerReconnected,
  invokeOnTurnEnd,
  invokeOnTurnStart,
} from './hooks';
import { acceptInput, isAuthorizedForChannel, rejectInput, validateInput } from './input';
import type { MutablePhaseState } from './phases';
import {
  areAllChannelsComplete,
  createPhaseState,
  getAdvanceTrigger,
  getNextSubPhase,
  isAnyChannelComplete,
  resolveDelay,
  resolveFirstPhase,
  resolveNextPhase,
  resolveTimeout,
} from './phases';
import { assignRoles, assignTeams } from './players';
import { channelRateLimitKey, createInMemoryRateLimiter } from './rateLimit';
import type { ReplaySequence } from './replay';
import {
  createReplaySequence,
  logChannelClosed,
  logChannelInput,
  logChannelOpened,
  logPhaseEntered,
  logPhaseExited,
  logPlayerDisconnected,
  logPlayerReconnected,
  logSessionCompleted,
  logSessionStarted,
  logTimerStarted,
  logTurnAdvanced,
} from './replay';
import { createSeededRng } from './rng';
import { mergeRules } from './rules';
import type { MutablePlayer } from './runtimeTypes';
import type { MutableScoreState } from './scoring';
import {
  buildLeaderboard,
  createScoreState,
  initializePlayerScore,
  registerPlayerTeam,
} from './scoring';
import { serializeMap } from './serialize';
import { createPrivateStateManager } from './state';
import type { MutableTimerState } from './timers';
import {
  cancelAllTimers,
  cancelTimer,
  createTimer,
  createTimerState,
  getTimeRemaining,
} from './timers';
import type { MutableTurnState } from './turns';
import { advanceTurn, completeTurnCycle, createTurnState } from './turns';

// ── Types ────────────────────────────────────────────────────────
/** Per-session runtime state. */
export interface SessionRuntime {
  readonly sessionId: string;
  readonly gameType: string;
  readonly gameDef: Readonly<GameDefinition>;
  /**
   * The LIVE rules. Mutable on purpose: a staged patch (or an instant
   * `applyRulesPatch`) swaps in a freshly-validated frozen object — the object
   * itself is never mutated in place. Handlers always read the live object
   * through the handler context, which is rebuilt on every swap.
   */
  rules: Readonly<Record<string, unknown>>;

  /**
   * A pending rules patch, staged by the host mid-game and applied at the next
   * boundary the game declares safe ({@link GameDefinition.applyStagedRules}).
   * PERSISTED the moment it is staged — a saved-but-pending edit must survive
   * a restart.
   */
  stagedRulesPatch: Record<string, unknown> | null;

  readonly phaseState: MutablePhaseState;
  readonly turnState: MutableTurnState;
  readonly scoreState: MutableScoreState;
  readonly timerState: MutableTimerState;
  readonly gameLoopState: MutableGameLoopState | null;
  readonly disconnectState: MutableDisconnectState;
  readonly afkState: MutableAfkState;
  readonly childSessionState: MutableChildSessionState;
  readonly replaySeq: ReplaySequence;
  readonly rng: SeededRng;
  readonly privateStateManager: ReturnType<typeof createPrivateStateManager>;
  readonly rateLimiter: RateLimitBackend;

  gameState: Record<string, unknown>;
  players: Map<string, MutablePlayer>;
  channels: Map<string, MutableChannelState>;
  currentRound: number;

  /**
   * Monotonic INPUT EPOCH — bumped on every phase transition, stamped onto
   * every session-room frame the runtime publishes, and echoed back (optionally)
   * on `game:input`. The input pipeline rejects an input stamped with an OLDER
   * epoch: after a reconnect the per-connection sequence cache is reset and the
   * client's outbound queue flushes, so a stale input could otherwise re-land
   * under a fresh sequence and complete a same-named channel that has since
   * been reopened for a NEW phase/turn (hotseat's vanishing-picker P0). The
   * only phase-scoping before this was the channel-open check, which is exactly
   * what a reopened channel defeats.
   *
   * Inputs with NO stamp are treated as current (old clients, tests, REST-side
   * drivers). Inputs stamped AHEAD of the runtime are also accepted: a crash
   * can lose the tail of the epoch's history (it persists per phase
   * transition), so after a resume clients may briefly hold a higher stamp than
   * the runtime; a genuinely stale input is always strictly LOWER.
   */
  inputEpoch: number;

  /**
   * When true the session is paused: all timers are frozen and the input
   * pipeline rejects submissions with code `SESSION_PAUSED`. Toggled by the
   * engine's `pauseSession` / `resumeSession` controls.
   */
  paused: boolean;

  /**
   * Reentrancy guard for {@link advancePhase}. Prevents a phase-timeout firing
   * concurrently with a host-driven advance from double-advancing (both
   * capturing the same current phase).
   */
  advancing: boolean;

  /**
   * True only while a phase's `onEnter` handler (and the `onPhaseEnter` hook)
   * is being invoked. Together with the `'handler'` advance source this is what
   * lets {@link advancePhase} tell a *self-advance* — the entering phase asking
   * to move straight on, which must be honored — apart from an unrelated
   * external advance that merely raced with the transition, which must still be
   * dropped by the reentrancy guard.
   */
  inOnEnter: boolean;

  /**
   * Set when a phase self-advances from its own `onEnter`. The advance cannot
   * run inline (we are already inside `doAdvancePhase`), so it is recorded here
   * and replayed by `drainSelfAdvances` once the in-flight transition settles.
   */
  pendingSelfAdvance: boolean;

  /**
   * Phases traversed by the current chain of self-advances, used to bound the
   * chain and to name the offending phases if it turns out to be a cycle.
   */
  readonly selfAdvanceChain: string[];

  readonly publish: (
    room: string,
    message: unknown,
    options?: { exclude?: ReadonlySet<string>; volatile?: boolean; trackDelivery?: boolean },
  ) => void;
  readonly replayStore: ReplayStore;
  readonly log: {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
  readonly onCompleted?: (
    winResult: WinResult,
    leaderboard: unknown,
    finalGameState?: Record<string, unknown>,
  ) => Promise<void> | void;

  /** See {@link SessionRuntimeDeps.onRulesApplied}. */
  readonly onRulesApplied?: (
    patch: Record<string, unknown>,
    rules: Readonly<Record<string, unknown>>,
  ) => Promise<void> | void;

  /**
   * Accessor for framework {@link HookServices}. Supplied by the plugin on the
   * real runtime; absent in `TestGameHarness` so sims stay hermetic.
   * See {@link SessionRuntimeDeps.getHookServices}.
   */
  readonly getHookServices?: () => HookServices | undefined;

  handlerContext: ReturnType<typeof buildProcessHandlerContext>;

  /** Per-session per-player sequence dedup cache. */
  readonly sequenceCache: Map<string, Map<number, InputAck>>;

  /** Pending replay entries not yet flushed. */
  readonly pendingReplayEntries: ReplayEntry[];

  /**
   * Whether a coalescing flush is already queued for this microtask turn.
   *
   * Entries produced by one processing cycle (an input can emit several — a
   * channel input, a phase exit, a phase entry, a score change) batch into a
   * single `appendReplayEntries` call rather than one write per entry.
   */
  replayFlushScheduled: boolean;

  /**
   * Serializing chain for replay writes.
   *
   * Batches MUST reach the store in sequence order — a durable store that
   * received batch 2 before batch 1 would produce a replay that cannot be
   * deterministically reconstructed. Each flush chains onto the previous one
   * rather than racing it.
   */
  replayFlushChain: Promise<void>;

  /** See {@link SessionRuntimeDeps.persistState}. */
  readonly persistState?: (snapshot: PersistedRuntimeState) => Promise<void>;

  /**
   * Per-runtime persistence queue. Writes must land in transition order, and
   * teardown must be able to drain the final write before storage closes.
   */
  persistenceTail: Promise<void>;
}

/**
 * The durable footprint of a live session — everything a fresh process needs
 * to pick a game back up mid-phase.
 *
 * Handed to {@link SessionRuntimeDeps.persistState} after every settled phase
 * transition, and hydrated back through {@link SessionRuntimeDeps.resume}.
 *
 * `rngState` doubles as the RESUMABILITY MARKER: only the persist path ever
 * writes it, so a session row carrying one is a row whose gameState is real
 * mid-game progress — as opposed to the creation-time snapshot every session
 * row has always carried, which resurrecting would "resume" a game back to
 * turn zero with a straight face.
 */
export interface PersistedRuntimeState {
  gameState: Record<string, unknown>;
  currentPhase: string | null;
  currentSubPhase: string | null;
  currentRound: number;
  privateState: Record<string, unknown>;
  rngState: number;
  /**
   * The LIVE rules. Rules used to be frozen for the session lifetime, so the
   * creation-time row was always right; staged patches mean a mid-game apply
   * must reach the row or a restart resumes onto the pre-change rules.
   */
  rules: Record<string, unknown>;
  /** A staged-but-not-yet-applied patch. Survives a restart; `null` when none. */
  stagedRulesPatch: Record<string, unknown> | null;
  /**
   * The input epoch at the settled transition. Must ride the durable footprint:
   * clients hold the last-broadcast epoch, so a restart that reset the counter
   * to zero would make the engine reject EVERY stamped input as "from the
   * future"… or, worse, accept genuinely stale ones as current.
   */
  inputEpoch: number;
}

/** Snapshot fields hydrated back into a resumed runtime. */
export interface RuntimeResumeState {
  currentPhase: string | null;
  currentRound: number;
  currentSubPhase?: string | null;
  privateState?: Record<string, unknown> | null;
  rngState?: number | null;
  /** A rules patch that was staged when the process died — still pending. */
  stagedRulesPatch?: Record<string, unknown> | null;
  /** The persisted input epoch; see {@link SessionRuntime.inputEpoch}. */
  inputEpoch?: number | null;
}

/** External dependencies injected by the plugin closure. */
export interface SessionRuntimeDeps {
  publish: (
    room: string,
    message: unknown,
    options?: { exclude?: ReadonlySet<string>; volatile?: boolean; trackDelivery?: boolean },
  ) => void;
  replayStore: ReplayStore;
  log: SessionRuntime['log'];
  activeRuntimes: Map<string, SessionRuntime>;
  /**
   * Accessor for framework {@link HookServices} — the documented route from a game
   * handler to a framework capability (`ctx.services.capabilities.require(...)`).
   *
   * ## This was declared and never wired, and it broke a shipped game
   *
   * `ProcessHandlerContext.services` is a getter over this function. The type
   * existed, the getter existed, the docs existed — and **nothing ever supplied
   * it**, so `ctx.services` was `undefined` for every game, always. No game on
   * this platform could reach a framework capability from a handler.
   *
   * That is why hotseat's LLM never generated a single card in production: the AI
   * client was registered, booted and pre-warmed, and the handler that had to
   * *find* it looked into an empty socket and quietly dealt from the house deck
   * instead. Hundreds of tests were green, because every test called the deck
   * function directly and none drove the handler that has to resolve the client.
   *
   * The plugin supplies this on the real runtime. `TestGameHarness` deliberately
   * does NOT — leaving `ctx.services` undefined there, which is what keeps the
   * engine sims hermetic and lets games take a no-credentials fallback path in
   * tests. That was always the intent; it had merely become true *everywhere*.
   */
  getHookServices?: () => HookServices | undefined;
  /**
   * Persisted session gameState to hydrate into the runtime (e.g. state
   * written at session creation, or surviving a restart). Cloned on use;
   * `onGameStart` hooks run after hydration and may still reset it.
   */
  initialGameState?: Record<string, unknown> | null;
  /**
   * STAGED per-player private state to hydrate on a FRESH start, keyed like
   * the private-state manager (user id → value).
   *
   * A lobby has no runtime, and the lobby is exactly where a player tells the
   * game about themselves (a hotseat dossier: facts, no-go topics, pronouns) —
   * so the app stages those entries on the session row's `privateState`
   * before the game starts. Without this hydration, everything the room typed
   * while waiting evaporates at the precise moment the game starts reading it:
   * deck-prep builds the FIRST prompt from private state.
   *
   * Applied BEFORE role assignment: in a role game, the engine's role entry
   * for a player overwrites that player's staged value — roles own their
   * players' initial private state. (The resume path has its own hydration,
   * from the persisted snapshot.)
   */
  initialPrivateState?: Record<string, unknown> | null;
  /**
   * Invoked after natural game completion is broadcast, so the owning plugin
   * can persist the terminal session state and emit the app-bus
   * `game:session.completed` event. Without this, natural completion is only
   * observable over the WS room — server-side listeners never hear it.
   */
  onCompleted?: SessionRuntime['onCompleted'];

  /**
   * Invoked whenever a rules patch is APPLIED to the live rules — staged
   * patches landing at a boundary and instant `applyRulesPatch` calls alike
   * (including silent ones: `silent` only suppresses the room broadcast, never
   * the server-side signal). The owning plugin surfaces this on the app bus so
   * app code that mirrors rules onto its own records (a "match" row whose
   * judging path reads a rules snapshot per-request) can stay in sync. Without
   * it, a rules change applied by the engine is only observable over the WS
   * room — the same silent gap natural completion had.
   */
  onRulesApplied?: SessionRuntime['onRulesApplied'];

  /**
   * Persist the session's durable footprint. Called (fire-and-forget) after
   * every settled phase transition with the POST-transition snapshot.
   *
   * ## Why this exists
   *
   * The engine kept a live session's gameState, phase and private state in
   * memory ONLY: the session row was written at creation and completion, and
   * nothing in between. A process restart — every deploy — therefore destroyed
   * every in-flight game on the instance: the row said `playing`, the state was
   * the creation snapshot, and no runtime ever came back. Three real parties
   * died to that in one night before this landed.
   *
   * A failure here is logged LOUDLY and never breaks the transition — the room
   * keeps playing on the in-memory state; durability degrades, gameplay does
   * not. But it must never fail silently: a quiet persist failure is how "the
   * state is safe" stays believed right up until the restart that proves it
   * was not.
   */
  persistState?: (snapshot: PersistedRuntimeState) => Promise<void>;

  /**
   * Resume a previously persisted session instead of starting a fresh one.
   *
   * The resume path deliberately does NOT:
   *  - run `onGameStart` — games initialize (and often WIPE) their state there;
   *    a respawn that re-runs it erases the very progress it came to restore;
   *  - re-run the resumed phase's `onEnter` — its mutations are already inside
   *    the persisted gameState (the snapshot is taken post-transition), and
   *    running them again double-applies them;
   *  - re-assign roles or teams — they were dealt once, live on the player
   *    rows, and re-rolling them mid-game would hand people new identities.
   *
   * It DOES re-open the phase's channels, re-arm its timer at full duration
   * (the original deadline died with the process; a fresh window beats a
   * phase that can never end), restore private state and the RNG, and publish
   * `game:phase.entered` so every client wakes up.
   */
  resume?: RuntimeResumeState;
}

// ── Helpers ──────────────────────────────────────────────────────

function toGamePlayerState(p: MutablePlayer): GamePlayerState {
  return {
    userId: p.userId,
    displayName: p.displayName,
    role: p.role,
    team: p.team,
    playerState: p.playerState,
    score: p.score,
    connected: p.connected,
    isHost: p.isHost,
    isSpectator: p.isSpectator,
    joinOrder: p.joinOrder,
  };
}

function buildHandlerDeps(runtime: SessionRuntime): HandlerContextDeps {
  return {
    // THE missing link. `ProcessHandlerContext.services` is a getter over this,
    // and until now nothing passed it — so `ctx.services` was undefined in every
    // game, forever. See SessionRuntimeDeps.getHookServices.
    getHookServices: runtime.getHookServices,
    sessionId: runtime.sessionId,
    gameType: runtime.gameType,
    rules: runtime.rules,
    phaseState: runtime.phaseState,
    currentRound: runtime.currentRound,
    gameState: runtime.gameState,
    privateState: runtime.privateStateManager.getAll() as Map<string, unknown>,
    players: runtime.players,
    turnState: runtime.turnState,
    scoreState: runtime.scoreState,
    channels: runtime.channels,
    timerState: runtime.timerState,
    gameLoopState: runtime.gameLoopState,
    rng: runtime.rng,
    publish: runtime.publish,
    requestAdvancePhase: () => {
      advancePhase(runtime, 'handler').catch((e: unknown) =>
        runtime.log.error('advancePhase error', e),
      );
    },
    requestEndGame: (result: WinResult) => {
      endGameFlow(runtime, result).catch((e: unknown) => runtime.log.error('endGameFlow error', e));
    },
    setCurrentRound: (r: number) => {
      runtime.currentRound = r;
    },
    setNextPhase: (p: string) => {
      runtime.phaseState.resolvedNext = p;
    },
    updatePlayerState: (userId: string, state: string) => {
      const player = runtime.players.get(userId);
      if (player) {
        player.playerState = state;
      }
    },
    createChildSession: () => {
      throw new Error(
        '[slingshot-game-engine] createChildSession is not yet implemented. ' +
          'Child session support requires sessionAdapter and gameRegistry in SessionRuntimeDeps.',
      );
    },
    getChildSessionResult: (id: string) =>
      Promise.resolve(getChildSessionResult(runtime.childSessionState, id) ?? null),
    log: runtime.log,
  };
}

function rebuildHandlerContext(runtime: SessionRuntime): void {
  const deps = buildHandlerDeps(runtime);
  runtime.handlerContext = buildProcessHandlerContext(deps);
}

/**
 * Refresh and return the live handler context for a runtime.
 *
 * Session controls use this to expose the same sanctioned mutation surface
 * that game handlers receive, without leaking the underlying runtime object.
 */
export function refreshHandlerContext(runtime: SessionRuntime): SessionRuntime['handlerContext'] {
  rebuildHandlerContext(runtime);
  return runtime.handlerContext;
}

function appendReplay(runtime: SessionRuntime, entry: ReplayEntry): void {
  runtime.pendingReplayEntries.push(entry);
  scheduleReplayFlush(runtime);
}

/**
 * Queue a replay flush for the end of the current microtask turn.
 *
 * Entries used to accumulate for the ENTIRE session and flush exactly once, in
 * `endGameFlow`. That made the log a liability rather than a record: a crash or
 * redeploy mid-session lost every entry, a session that was abandoned (and so
 * never reached `endGameFlow`) was never written at all, and a long session grew
 * the buffer without bound. It also quietly broke the `ReplayStore` contract,
 * which states that entries must be persisted durably before an input is
 * considered committed.
 *
 * Coalescing on the microtask queue keeps the batching that made the old
 * approach cheap — all entries emitted by one processing cycle land in a single
 * `appendReplayEntries` call — without deferring durability to the end of the game.
 */
function scheduleReplayFlush(runtime: SessionRuntime): void {
  if (runtime.replayFlushScheduled) return;
  runtime.replayFlushScheduled = true;
  queueMicrotask(() => {
    runtime.replayFlushScheduled = false;
    void flushReplayEntries(runtime);
  });
}

/**
 * Flush buffered replay entries to the store, in order.
 *
 * Safe to call at any time and safe to call concurrently: writes are serialized
 * through `runtime.replayFlushChain` so batches reach the store in sequence
 * order. Awaiting the returned promise guarantees everything buffered *at call
 * time* has been handed to the store.
 *
 * A store failure is logged and swallowed — a persistence problem must not take
 * the live game down with it — but the entries are dropped rather than retried,
 * so a store that throws will leave gaps in the log.
 */
export function flushReplayEntries(runtime: SessionRuntime): Promise<void> {
  runtime.replayFlushChain = runtime.replayFlushChain.then(async () => {
    if (runtime.pendingReplayEntries.length === 0) return;
    // Take the buffer, so entries produced while this write is in flight queue
    // up for the next flush instead of being dropped by a blanket reset.
    const batch = runtime.pendingReplayEntries.splice(0, runtime.pendingReplayEntries.length);
    try {
      await runtime.replayStore.appendReplayEntries(runtime.sessionId, batch);
    } catch (e: unknown) {
      runtime.log.error('Failed to flush replay entries', e);
    }
  });
  return runtime.replayFlushChain;
}

/** Stable key for a player's input-sequence dedup cache. */
function sequenceCacheKey(sessionId: string, userId: string): string {
  return `${sessionId}:${userId}`;
}

/**
 * Reset a player's input-sequence dedup cache (#1).
 *
 * The `game:input` sequence contract is "monotonic PER CONNECTION": the client
 * restarts its counter at 1 on every reconnect / page refresh. The dedup cache
 * therefore must be bound to the connection, not the session lifetime —
 * otherwise a fresh seq 1..N collides with acks cached from the previous
 * socket and inputs are silently dropped (the server returns the stale
 * accepted:true). Clearing the cache whenever a (re)subscribe establishes a new
 * connection makes a fresh seq 1 process normally, while genuine in-connection
 * replays (same socket resending the same seq) are still deduped.
 */
function resetSequenceCache(runtime: SessionRuntime, userId: string): void {
  runtime.sequenceCache.delete(sequenceCacheKey(runtime.sessionId, userId));
}

function playerIds(runtime: SessionRuntime): string[] {
  return [...runtime.players.keys()];
}

// ── §5.10.2 Initialization — Game Start Sequence ─────────────────

export async function createSessionRuntime(
  sessionId: string,
  gameDef: Readonly<GameDefinition>,
  rules: Readonly<Record<string, unknown>>,
  playerRecords: GamePlayerState[],
  rngSeed: number,
  deps: SessionRuntimeDeps,
): Promise<SessionRuntime | null> {
  // Step 1: Create mutable state containers
  const phaseState = createPhaseState();
  const turnState = createTurnState(playerRecords.map(p => p.userId));
  const scoreState = createScoreState();
  const timerState = createTimerState();
  const gameLoopState = gameDef.loop ? createGameLoopState(gameDef.loop.tickRate) : null;
  const disconnectState = createDisconnectState();
  const afkState = createAfkState();
  const childSessionState = createChildSessionState();
  const replaySeq = createReplaySequence();
  const rng = createSeededRng(rngSeed);
  const privateStateManager = createPrivateStateManager();
  const rateLimiter = createInMemoryRateLimiter();
  const gameState: Record<string, unknown> = deps.initialGameState
    ? structuredClone(deps.initialGameState)
    : {};
  const channels = new Map<string, MutableChannelState>();
  const players = new Map<string, MutablePlayer>(
    playerRecords.map(p => [
      p.userId,
      {
        userId: p.userId,
        displayName: p.displayName,
        role: p.role,
        team: p.team,
        playerState: p.playerState,
        score: p.score,
        connected: p.connected,
        isHost: p.isHost,
        isSpectator: p.isSpectator,
        joinOrder: p.joinOrder,
        disconnectedAt: null,
        disconnectCount: 0,
      },
    ]),
  );
  const resume = deps.resume ?? null;
  const currentRound = resume ? Math.max(1, resume.currentRound) : 1;
  const initialInputEpoch =
    resume && typeof resume.inputEpoch === 'number' && resume.inputEpoch >= 0
      ? resume.inputEpoch
      : 0;

  // Step 2: Initialize player scores
  for (const p of players.values()) {
    initializePlayerScore(scoreState, p.userId);
    if (p.team) {
      registerPlayerTeam(scoreState, p.userId, p.team);
    }
  }

  // Steps 3 & 4 are for a FRESH game only. On resume, roles and teams were
  // dealt once and live on the player rows (already copied into `players`
  // above); re-rolling them would hand people new identities mid-game.
  if (!resume) {
    // STAGED private state (e.g. a dossier typed in the lobby, where no
    // runtime exists) hydrates FIRST, so role assignment below wins for its
    // players — roles own their players' initial private state.
    if (deps.initialPrivateState) {
      for (const [key, value] of Object.entries(deps.initialPrivateState)) {
        privateStateManager.set(key, structuredClone(value));
      }
    }

    // Step 3: Assign roles
    if (Object.keys(gameDef.roles).length > 0) {
      const assignments = assignRoles(gameDef, playerRecords, rng);
      for (const assignment of assignments) {
        const player = players.get(assignment.userId);
        if (player) {
          player.role = assignment.role;
          privateStateManager.set(assignment.userId, {
            role: assignment.role,
            visiblePlayers: assignment.visiblePlayers,
          });
        }
      }
    }

    // Step 4: Assign teams
    if (gameDef.teams) {
      const teamMap = assignTeams(gameDef, playerRecords, rng);
      for (const [userId, team] of teamMap) {
        const player = players.get(userId);
        if (player) {
          player.team = team;
          registerPlayerTeam(scoreState, userId, team);
        }
      }
    }
  }

  // Resume: hydrate what the persist path saved. Private state first (a
  // dossier must survive a deploy), then the RNG's live position — resuming
  // with a reseeded RNG would replay the shuffles the game already dealt.
  if (resume) {
    if (resume.privateState) {
      for (const [key, value] of Object.entries(resume.privateState)) {
        privateStateManager.set(key, value);
      }
    }
    if (typeof resume.rngState === 'number') {
      (rng as unknown as { setState(s: number): void }).setState(resume.rngState);
    }
  }

  // Declare runtime first so closure-based deps (requestAdvancePhase, etc.)
  // can capture it by reference. The closures are only called after runtime
  // is fully assigned below, so the forward reference is safe.
  const runtimeRef: { current: SessionRuntime | null } = { current: null };

  // Stamp the CURRENT input epoch onto every frame this runtime publishes for
  // its own session, so clients always hold a fresh value to echo back on
  // `game:input`. One wrapper instead of a stamp at each publish site — a
  // session-room frame that skipped the stamp would leave clients echoing an
  // old epoch and getting rejected for it. Frames that already carry an
  // `epoch` (none today) are left alone.
  const publish: SessionRuntimeDeps['publish'] = (room, message, options) => {
    if (
      message !== null &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).sessionId === sessionId &&
      (message as Record<string, unknown>).epoch === undefined
    ) {
      message = {
        ...(message as Record<string, unknown>),
        epoch: runtimeRef.current?.inputEpoch ?? initialInputEpoch,
      };
    }
    deps.publish(room, message, options);
  };

  // Step 5: Build handler deps and context. The closures in buildHandlerDeps
  // read from the `runtime` variable — they resolve at call time, not capture
  // time, so this works despite runtime not being assigned yet.
  const initialDeps: HandlerContextDeps = {
    // The runtime object does not exist yet, but `deps` does — and `onGameStart`
    // fires against THIS context. Omitting it here would leave the very first
    // hook of every game unable to see a capability.
    getHookServices: deps.getHookServices,
    sessionId,
    gameType: gameDef.name,
    rules,
    phaseState,
    currentRound,
    gameState,
    privateState: privateStateManager.getAll() as Map<string, unknown>,
    players,
    turnState,
    scoreState,
    channels,
    timerState,
    gameLoopState,
    rng,
    publish,
    requestAdvancePhase: () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      advancePhase(runtime, 'handler').catch((e: unknown) =>
        deps.log.error('advancePhase error', e),
      );
    },
    requestEndGame: (result: WinResult) => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      endGameFlow(runtime, result).catch((e: unknown) => deps.log.error('endGameFlow error', e));
    },
    setCurrentRound: (r: number) => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.currentRound = r;
    },
    setNextPhase: (p: string) => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.phaseState.resolvedNext = p;
    },
    updatePlayerState: (userId: string, state: string) => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      const player = runtime.players.get(userId);
      if (player) {
        player.playerState = state;
      }
    },
    createChildSession: () => Promise.resolve({ sessionId: '' }),
    getChildSessionResult: (id: string) =>
      Promise.resolve(getChildSessionResult(childSessionState, id) ?? null),
    log: deps.log,
  };
  const handlerContext = buildProcessHandlerContext(initialDeps);

  // Step 6: Assemble the full runtime with a real handlerContext (no null cast).
  const runtime: SessionRuntime = {
    sessionId,
    gameType: gameDef.name,
    gameDef,
    rules,
    phaseState,
    turnState,
    scoreState,
    timerState,
    gameLoopState,
    disconnectState,
    afkState,
    childSessionState,
    replaySeq,
    rng,
    privateStateManager,
    rateLimiter,
    gameState,
    players,
    channels,
    currentRound,
    inputEpoch: initialInputEpoch,
    stagedRulesPatch: resume?.stagedRulesPatch ? structuredClone(resume.stagedRulesPatch) : null,
    paused: false,
    advancing: false,
    inOnEnter: false,
    pendingSelfAdvance: false,
    selfAdvanceChain: [],
    publish,
    replayStore: deps.replayStore,
    log: deps.log,
    onCompleted: deps.onCompleted,
    onRulesApplied: deps.onRulesApplied,
    getHookServices: deps.getHookServices,
    handlerContext,
    sequenceCache: new Map(),
    pendingReplayEntries: [],
    replayFlushScheduled: false,
    replayFlushChain: Promise.resolve(),
    persistState: deps.persistState,
    persistenceTail: Promise.resolve(),
  };
  runtimeRef.current = runtime;

  if (resume) {
    // ── THE RESUME PATH ────────────────────────────────────────────────────
    // No onGameStart (it wipes and rebuilds state — the one thing a respawn
    // must never do), no first-phase resolution, no onEnter. The persisted
    // snapshot was taken AFTER the transition into `resume.currentPhase`
    // settled, so every mutation those hooks would make is already in it.
    appendReplay(
      runtime,
      logSessionStarted(sessionId, replaySeq, {
        playerCount: players.size,
        firstPhase: resume.currentPhase,
        resumed: true,
      }),
    );

    if (resume.currentPhase) {
      await resumePhaseFlow(runtime, resume.currentPhase, resume.currentSubPhase ?? null);
    }

    deps.activeRuntimes.set(sessionId, runtime);
    return runtime;
  }

  // Step 7: Invoke onGameStart hook
  const hookError = createHookErrorHandler(sessionId, deps.log);
  const startResult = await invokeOnGameStart(gameDef.hooks, runtime.handlerContext, hookError);
  if (startResult.cancelled) {
    cancelAllTimers(timerState);
    return null;
  }

  // Step 8: Log to replay
  const firstPhaseForLog = resolveFirstPhase(
    gameDef,
    buildReadonlyHandlerContext(buildHandlerDeps(runtime)),
  );
  appendReplay(
    runtime,
    logSessionStarted(sessionId, replaySeq, {
      playerCount: players.size,
      firstPhase: firstPhaseForLog,
    }),
  );

  // Step 9: Enter first phase
  if (firstPhaseForLog) {
    await enterInitialPhase(runtime, firstPhaseForLog);
  }

  // Step 10: Store runtime
  deps.activeRuntimes.set(sessionId, runtime);

  // Step 11: Return
  return runtime;
}

// ── §5.10.3 Enter Phase Flow ─────────────────────────────────────

/**
 * Enter the session's first phase under the same transition guard `advancePhase`
 * uses.
 *
 * Without the guard, `advancing` is false here, so a first phase that
 * self-advances from its own `onEnter` would recurse into `doAdvancePhase` from
 * *inside* the enter that has not finished — and the outer `enterPhaseFlow`
 * would then go on to publish `game:phase.entered` for a phase the session had
 * already left. Holding the guard turns that into the same deferred replay every
 * other self-advance gets.
 */
async function enterInitialPhase(runtime: SessionRuntime, phaseName: string): Promise<void> {
  runtime.advancing = true;
  try {
    await enterPhaseFlow(runtime, phaseName);
    await drainSelfAdvances(runtime);
  } finally {
    runtime.advancing = false;
    runtime.pendingSelfAdvance = false;
    runtime.selfAdvanceChain.length = 0;
    // The very first durable footprint. Without it, a session that crashed
    // between start and its first advance would resume into nothing.
    persistRuntimeState(runtime);
  }
}

export async function enterPhaseFlow(runtime: SessionRuntime, phaseName: string): Promise<void> {
  const { gameDef, phaseState, timerState, replaySeq, sessionId } = runtime;
  const hookError = createHookErrorHandler(sessionId, runtime.log);

  // Step 1: Update phase state. Entering a phase opens a new INPUT EPOCH:
  // anything a client composed against the previous phase's frames is now
  // stale, even if a channel of the same name reopens here.
  runtime.inputEpoch += 1;
  phaseState.currentPhase = phaseName;
  phaseState.phaseStartedAt = Date.now();
  phaseState.subPhaseIndex = -1;
  phaseState.currentSubPhase = null;
  phaseState.activeChannels.clear();

  // Step 2: Resolve phase definition
  if (!Object.hasOwn(gameDef.phases, phaseName)) {
    runtime.log.error(`Phase '${phaseName}' not found in game definition`);
    return;
  }
  const phaseDef = gameDef.phases[phaseName];

  // Step 2.5: Staged rules land HERE, at a declared boundary — before the
  // handler context, channels, and the phase timer resolve, so the phase being
  // entered runs entirely on the new rules. `persist: false` because the
  // settled transition persists the footprint moments later (a mid-transition
  // persist would write a half-entered phase).
  if (runtime.stagedRulesPatch && gameDef.applyStagedRules.includes(phaseName)) {
    applyStagedRules(runtime, { persist: false });
  }

  rebuildHandlerContext(runtime);
  const readonlyCtx = buildReadonlyHandlerContext(buildHandlerDeps(runtime));

  // Step 3: Apply delay
  const delay = resolveDelay(phaseDef, readonlyCtx);
  if (delay > 0) {
    runtime.publish(sessionRoom(sessionId), {
      type: 'game:phase.pending',
      sessionId,
      phase: phaseName,
      delayMs: delay,
    });
    await new Promise<void>(resolve => setTimeout(resolve, delay));
  }

  // Step 4: Create channels
  if (phaseDef.channels) {
    for (const [channelName, channelDef] of Object.entries(phaseDef.channels)) {
      const channelState = createChannelState(channelName, channelDef, readonlyCtx);
      runtime.channels.set(channelName, channelState);
      phaseState.activeChannels.add(channelName);

      appendReplay(
        runtime,
        logChannelOpened(sessionId, replaySeq, {
          channel: channelName,
          mode: channelDef.mode,
          timeout: channelState.endsAt ? channelState.endsAt - Date.now() : null,
        }),
      );

      runtime.publish(sessionRoom(sessionId), {
        type: 'game:channel.opened',
        sessionId,
        channel: channelName,
        mode: channelDef.mode,
      });
    }
  }

  // Step 5: Phase timer
  const timeout = resolveTimeout(phaseDef, readonlyCtx);
  if (timeout) {
    const timerId = createTimer(timerState, sessionId, 'phase', timeout, 'phaseTimeout', () => {
      onPhaseTimeout(runtime);
    });
    phaseState.phaseTimerId = timerId;
    appendReplay(
      runtime,
      logTimerStarted(sessionId, replaySeq, {
        timerId,
        type: 'phase',
        durationMs: timeout,
      }),
    );
  }

  // Step 6: Start game loop
  if (phaseDef.loop && runtime.gameLoopState) {
    startGameLoop(
      runtime.gameLoopState,
      () => {
        rebuildHandlerContext(runtime);
      },
      runtime.gameState,
      gameDef.sync,
    );
  }

  // Step 7: Set up turn order for turn channels
  if (phaseDef.channels) {
    for (const [, channelDef] of Object.entries(phaseDef.channels)) {
      if (channelDef.mode === 'turn') {
        const nextPlayer = advanceTurn(runtime.turnState);
        if (nextPlayer) {
          appendReplay(
            runtime,
            logTurnAdvanced(sessionId, replaySeq, {
              previousPlayer: null,
              nextPlayer,
              turnNumber: runtime.turnState.cycleCount,
            }),
          );
          runtime.publish(sessionRoom(sessionId), {
            type: 'game:turn.advanced',
            sessionId,
            previousPlayer: null,
            nextPlayer,
          });
        }
        break;
      }
    }
  }

  // Step 8: Enter first sub-phase
  if (phaseDef.subPhases) {
    const nextSub = getNextSubPhase(phaseDef, -1, readonlyCtx);
    if (nextSub) {
      phaseState.subPhaseIndex = nextSub.index;
      phaseState.currentSubPhase = nextSub.name;
    }
  }

  // Step 9: Invoke onPhaseEnter hook
  //
  // `inOnEnter` marks the window in which a `ctx.advancePhase()` call means "this
  // phase is a computation, not a wait" — see `advancePhase`. The phase is still
  // fully entered (timer armed, channels open, `game:phase.entered` published)
  // even when it self-advances: it genuinely was entered, just briefly, and the
  // replayed advance cancels its timer on the way out.
  rebuildHandlerContext(runtime);
  runtime.inOnEnter = true;
  try {
    if (phaseDef.onEnter && Object.hasOwn(gameDef.handlers, phaseDef.onEnter)) {
      const handler = gameDef.handlers[phaseDef.onEnter];
      await handler(runtime.handlerContext);
    }
    await invokeOnPhaseEnter(gameDef.hooks, runtime.handlerContext, phaseName, hookError);
  } finally {
    runtime.inOnEnter = false;
  }

  const channelNames = [...phaseState.activeChannels];
  appendReplay(
    runtime,
    logPhaseEntered(sessionId, replaySeq, {
      phase: phaseName,
      timeout,
      channels: channelNames,
    }),
  );

  // Step 10: Publish phase entered
  const phaseEndsAt = timeout ? Date.now() + timeout : null;
  runtime.publish(sessionRoom(sessionId), {
    type: 'game:phase.entered',
    sessionId,
    phase: phaseName,
    subPhase: phaseState.currentSubPhase,
    timeout,
    phaseEndsAt,
  });
}

/**
 * Re-arm a persisted phase on a resumed runtime — `enterPhaseFlow` minus every
 * side effect that already happened before the crash.
 *
 * What runs: phase state, channel creation, the phase timer (full duration —
 * the original deadline died with the old process, and a fresh window beats a
 * phase that can never end), sub-phase restore, and the `game:phase.entered`
 * publish that wakes every client.
 *
 * What deliberately does NOT run:
 *  - the phase's `onEnter` handler and `onPhaseEnter` hooks — the persisted
 *    snapshot was taken after they ran; running them again double-applies
 *    their mutations (a round counter incremented twice, a deck re-generated);
 *  - turn-channel auto-advance — the turn was already taken once;
 *  - the enter delay — the room has waited long enough.
 */
async function resumePhaseFlow(
  runtime: SessionRuntime,
  phaseName: string,
  subPhase: string | null,
): Promise<void> {
  const { gameDef, phaseState, timerState, replaySeq, sessionId } = runtime;

  if (!Object.hasOwn(gameDef.phases, phaseName)) {
    runtime.log.error(
      `[slingshot-game-engine] Cannot resume session ${sessionId}: persisted phase '${phaseName}' ` +
        `is not in the '${runtime.gameType}' game definition.`,
    );
    return;
  }
  const phaseDef = gameDef.phases[phaseName];

  phaseState.currentPhase = phaseName;
  phaseState.phaseStartedAt = Date.now();
  phaseState.subPhaseIndex = -1;
  phaseState.currentSubPhase = subPhase;
  phaseState.activeChannels.clear();

  rebuildHandlerContext(runtime);
  const readonlyCtx = buildReadonlyHandlerContext(buildHandlerDeps(runtime));

  if (phaseDef.channels) {
    for (const [channelName, channelDef] of Object.entries(phaseDef.channels)) {
      const channelState = createChannelState(channelName, channelDef, readonlyCtx);
      runtime.channels.set(channelName, channelState);
      phaseState.activeChannels.add(channelName);
      runtime.publish(sessionRoom(sessionId), {
        type: 'game:channel.opened',
        sessionId,
        channel: channelName,
        mode: channelDef.mode,
      });
    }
  }

  const timeout = resolveTimeout(phaseDef, readonlyCtx);
  if (timeout) {
    const timerId = createTimer(timerState, sessionId, 'phase', timeout, 'phaseTimeout', () => {
      onPhaseTimeout(runtime);
    });
    phaseState.phaseTimerId = timerId;
  }

  if (phaseDef.loop && runtime.gameLoopState) {
    startGameLoop(
      runtime.gameLoopState,
      () => {
        rebuildHandlerContext(runtime);
      },
      runtime.gameState,
      gameDef.sync,
    );
  }

  rebuildHandlerContext(runtime);
  appendReplay(
    runtime,
    logPhaseEntered(sessionId, replaySeq, {
      phase: phaseName,
      timeout,
      channels: [...phaseState.activeChannels],
    }),
  );

  const phaseEndsAt = timeout ? Date.now() + timeout : null;
  runtime.publish(sessionRoom(sessionId), {
    type: 'game:phase.entered',
    sessionId,
    phase: phaseName,
    subPhase: phaseState.currentSubPhase,
    timeout,
    phaseEndsAt,
  });
}

/**
 * Hand the durable footprint to the owner's `persistState`, fire-and-forget.
 *
 * Called after every settled phase transition. Never awaited by gameplay and
 * never able to break it — but a failure is SCREAMED, because a silent persist
 * failure is how "the state is safe" stays believed right up until the restart
 * that proves it was not.
 */
function persistRuntimeState(runtime: SessionRuntime): void {
  const persistState = runtime.persistState;
  if (!persistState) return;
  const snapshot = structuredClone<PersistedRuntimeState>({
    gameState: runtime.gameState,
    currentPhase: runtime.phaseState.currentPhase,
    currentSubPhase: runtime.phaseState.currentSubPhase,
    currentRound: runtime.currentRound,
    privateState: serializeMap(runtime.privateStateManager.getAll() as Map<string, unknown>),
    rngState: (runtime.rng as unknown as { getState(): number }).getState(),
    rules: runtime.rules as Record<string, unknown>,
    stagedRulesPatch: runtime.stagedRulesPatch,
    inputEpoch: runtime.inputEpoch,
  });
  runtime.persistenceTail = runtime.persistenceTail
    .then(() => persistState(snapshot))
    .catch((error: unknown) => {
      runtime.log.error(
        `[slingshot-game-engine] PERSIST FAILED for session ${runtime.sessionId} — a restart will ` +
          `LOSE this game's live state. Gameplay continues on memory only.`,
        { error: String(error) },
      );
    });
}

/** Wait for every persistence write already queued for this runtime. */
export async function flushSessionRuntimePersistence(runtime: SessionRuntime): Promise<void> {
  await runtime.persistenceTail;
}

// ── Staged rules ─────────────────────────────────────────────────
//
// "Rules can only be changed between turns" is unusable in a timed game — the
// between-turns window is seconds long, so every rules sheet was functionally
// read-only. The engine therefore accepts a rules patch at ANY time, stages
// it, and applies it at the next boundary the game declares safe
// (`GameDefinition.applyStagedRules`), telling every client at both moments.

/**
 * Stage a rules patch to apply at the game's next declared boundary.
 *
 * Validates the patch NOW (merged over live rules against the game's schema) —
 * an invalid patch throws `RULES_VALIDATION_FAILED` immediately rather than
 * failing silently at the boundary. Merges over any already-staged patch
 * (top-level shallow, same semantics as `mergeRules`), broadcasts
 * `game:rules.staged`, and persists the durable footprint immediately: a
 * saved-but-pending edit must survive a restart.
 *
 * @returns The full staged patch now pending.
 */
export function stageRulesPatch(
  runtime: SessionRuntime,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const combined = { ...(runtime.stagedRulesPatch ?? {}), ...structuredClone(patch) };
  // Throws GameError(RULES_VALIDATION_FAILED, 400) on an invalid result.
  mergeRules(runtime.gameDef, runtime.rules, combined);

  runtime.stagedRulesPatch = combined;
  runtime.publish(sessionRoom(runtime.sessionId), {
    type: 'game:rules.staged',
    sessionId: runtime.sessionId,
    patch: structuredClone(combined),
    appliesAtPhases: [...runtime.gameDef.applyStagedRules],
  });
  persistRuntimeState(runtime);
  return combined;
}

/**
 * Apply a rules patch to the LIVE rules immediately.
 *
 * For the fields a game deliberately keeps instant (hotseat's dial-LOWERING
 * kill switch), and the shared apply step for staged patches. Swaps in a
 * freshly-validated frozen rules object, rebuilds the handler context so every
 * subsequent handler/timeout/channel read sees the new rules, broadcasts
 * `game:rules.applied` (unless `silent` — the kill-switch path announces
 * nothing), and persists (unless `persist: false` — the mid-transition caller
 * relies on the settled transition's own persist).
 *
 * @returns The new live rules.
 */
export function applyRulesPatch(
  runtime: SessionRuntime,
  patch: Record<string, unknown>,
  options: { silent?: boolean; persist?: boolean } = {},
): Readonly<Record<string, unknown>> {
  // Throws GameError(RULES_VALIDATION_FAILED, 400) — live rules untouched.
  const next = mergeRules(runtime.gameDef, runtime.rules, patch);
  runtime.rules = next;
  rebuildHandlerContext(runtime);

  if (!options.silent) {
    runtime.publish(sessionRoom(runtime.sessionId), {
      type: 'game:rules.applied',
      sessionId: runtime.sessionId,
      patch: structuredClone(patch),
      rules: structuredClone(next) as Record<string, unknown>,
      phase: runtime.phaseState.currentPhase,
    });
  }
  // The server-side signal fires even for silent applies: `silent` is about
  // what the ROOM hears, not about whether the app's durable mirrors update.
  if (runtime.onRulesApplied) {
    void Promise.resolve(runtime.onRulesApplied(structuredClone(patch), next)).catch(
      (error: unknown) => runtime.log.error('onRulesApplied error', { error: String(error) }),
    );
  }
  if (options.persist !== false) {
    persistRuntimeState(runtime);
  }
  return next;
}

/**
 * Apply the staged patch (if any) to the live rules.
 *
 * Called by the engine on entry to a declared boundary phase, and exposed
 * through session controls for games whose safe boundary is an explicit call
 * in app code rather than a phase entry.
 *
 * A staged patch that no longer validates (an instant change landed after it
 * was staged and now conflicts) is dropped LOUDLY: error log + a
 * `game:rules.stage-discarded` broadcast, so no client is left rendering
 * "pending" forever.
 *
 * @returns The new live rules, or `null` when nothing was staged (or the
 *   staged patch had to be discarded).
 */
export function applyStagedRules(
  runtime: SessionRuntime,
  options: { persist?: boolean } = {},
): Readonly<Record<string, unknown>> | null {
  const patch = runtime.stagedRulesPatch;
  if (!patch) return null;
  runtime.stagedRulesPatch = null;

  try {
    return applyRulesPatch(runtime, patch, options);
  } catch (error) {
    runtime.log.error(
      `[slingshot-game-engine] Staged rules patch for session ${runtime.sessionId} no longer ` +
        `validates and was DISCARDED. The rules on screen may not match what the host saved.`,
      { error: String(error), patch },
    );
    runtime.publish(sessionRoom(runtime.sessionId), {
      type: 'game:rules.stage-discarded',
      sessionId: runtime.sessionId,
      patch: structuredClone(patch),
    });
    if (options.persist !== false) persistRuntimeState(runtime);
    return null;
  }
}

// ── §5.10.4 Phase Advance Flow ───────────────────────────────────

/**
 * Where an advance request came from.
 *
 * - `'handler'` — a game handler called `ctx.advancePhase()`.
 * - `'external'` — a phase timeout, a host control, or channel completion.
 *
 * The distinction only matters while a transition is already in flight; see
 * {@link advancePhase}.
 */
export type AdvanceSource = 'handler' | 'external';

/**
 * Maximum number of phases that may self-advance from their own `onEnter` in a
 * single transition before the engine declares a cycle and fails loudly.
 *
 * A legitimate chain is short (a computed phase falling through a skip into a
 * terminal check). Anything past this is a `A.onEnter → B, B.onEnter → A` loop,
 * which would otherwise spin forever and take the event loop with it.
 */
export const MAX_SELF_ADVANCE_CHAIN = 16;

/**
 * Replay any advance a phase requested from its own `onEnter`.
 *
 * Must only be called by the owner of the `advancing` flag, once the in-flight
 * transition has fully settled.
 */
async function drainSelfAdvances(runtime: SessionRuntime): Promise<void> {
  while (runtime.pendingSelfAdvance) {
    runtime.pendingSelfAdvance = false;

    const from = runtime.phaseState.currentPhase;
    // The game ended during the transition — there is nothing left to leave.
    if (!from) return;

    runtime.selfAdvanceChain.push(from);
    if (runtime.selfAdvanceChain.length > MAX_SELF_ADVANCE_CHAIN) {
      const chain = runtime.selfAdvanceChain.join(' → ');
      runtime.selfAdvanceChain.length = 0;
      throw new GameError(
        GameErrorCode.INTERNAL_ERROR,
        `[slingshot-game-engine] Phase self-advance cycle in game '${runtime.gameType}': more than ` +
          `${MAX_SELF_ADVANCE_CHAIN} phases advanced from their own onEnter handler without the ` +
          `session settling. Chain: ${chain}. A phase whose onEnter calls ctx.advancePhase() must ` +
          `eventually reach a phase that does not.`,
      );
    }

    const ended = await doAdvancePhase(runtime);
    if (ended) return;
  }
}

export async function advancePhase(
  runtime: SessionRuntime,
  source: AdvanceSource = 'external',
): Promise<void> {
  // Reentrancy guard (#7): if an advance is already in flight, drop this call.
  // A phase-timeout can fire while a host action / handler-driven advance is
  // mid-flight; without this both would read the same `currentPhase` and
  // double-advance (running exit/enter hooks twice, skipping a phase). Dropping
  // the stale call is safe: the in-flight advance already leaves the current
  // phase, which is exactly what the second caller wanted. It never awaits
  // another advance, so handler-driven advances cannot deadlock.
  //
  // The one call that must NOT be dropped is a phase self-advancing from its own
  // `onEnter` — "this phase is a computation, not a wait" (deck prep, skip-if-
  // not-applicable, terminal-condition checks). `onEnter` runs *inside*
  // `doAdvancePhase`, so `advancing` is necessarily still true and the guard used
  // to swallow it silently: no throw, no log, the phase just sat there until its
  // timeout fired. Record it and replay it once this transition settles.
  //
  // Only a `'handler'`-sourced request inside the `onEnter` window is replayed.
  // An external advance (host control, phase timeout, channel completion) that
  // merely lands in the same window is still dropped, exactly as before — it is
  // aimed at the phase we are already leaving, and honoring it would skip the
  // phase being entered. That is the double-advance the guard exists to prevent.
  if (runtime.advancing) {
    if (source === 'handler' && runtime.inOnEnter) {
      runtime.pendingSelfAdvance = true;
    }
    return;
  }

  runtime.advancing = true;
  try {
    const ended = await doAdvancePhase(runtime);
    if (!ended) await drainSelfAdvances(runtime);
  } finally {
    runtime.advancing = false;
    runtime.pendingSelfAdvance = false;
    runtime.selfAdvanceChain.length = 0;
    // The transition (and any self-advance chain it triggered) has settled —
    // write the durable footprint. AFTER the finally-reset so a persist error
    // can never leave `advancing` latched; fire-and-forget so it can never
    // slow a turn.
    persistRuntimeState(runtime);
  }
}

/**
 * Run one phase transition.
 *
 * @returns `true` when the session ended (or had no phase to leave), meaning no
 *   further advance should be attempted.
 */
async function doAdvancePhase(runtime: SessionRuntime): Promise<boolean> {
  const { gameDef, phaseState, timerState, replaySeq, sessionId } = runtime;
  const hookError = createHookErrorHandler(sessionId, runtime.log);
  const currentPhase = phaseState.currentPhase;

  if (!currentPhase) return true;

  // Step 1: Cancel phase timer
  if (phaseState.phaseTimerId) {
    cancelTimer(timerState, phaseState.phaseTimerId);
    phaseState.phaseTimerId = null;
  }

  // Step 2: Stop game loop
  if (runtime.gameLoopState?.running) {
    stopGameLoop(runtime.gameLoopState);
  }

  // Step 3: Close all open channels
  for (const [channelName, channel] of runtime.channels) {
    if (channel.open) {
      closeChannel(channel);
      appendReplay(
        runtime,
        logChannelClosed(sessionId, replaySeq, {
          channel: channelName,
          reason: 'phase-advance',
          submissionCount: channel.submissions.size,
        }),
      );
      runtime.publish(sessionRoom(sessionId), {
        type: 'game:channel.closed',
        sessionId,
        channel: channelName,
        reason: 'phase-advance',
      });
    }
  }

  // Step 4: Invoke onPhaseExit
  rebuildHandlerContext(runtime);
  if (Object.hasOwn(gameDef.phases, currentPhase)) {
    const phaseDef = gameDef.phases[currentPhase];
    if (phaseDef.onExit && Object.hasOwn(gameDef.handlers, phaseDef.onExit)) {
      const handler = gameDef.handlers[phaseDef.onExit];
      await handler(runtime.handlerContext);
    }
  }
  await invokeOnPhaseExit(gameDef.hooks, runtime.handlerContext, currentPhase, hookError);

  const duration = phaseState.phaseStartedAt ? Date.now() - phaseState.phaseStartedAt : 0;
  appendReplay(
    runtime,
    logPhaseExited(sessionId, replaySeq, {
      phase: currentPhase,
      reason: 'advance',
      duration,
    }),
  );

  // Step 5: Resolve next phase
  const readonlyCtx = buildReadonlyHandlerContext(buildHandlerDeps(runtime));
  const nextPhase = resolveNextPhase(gameDef, currentPhase, readonlyCtx, phaseState.resolvedNext);
  phaseState.resolvedNext = null;

  // Step 6: If no next phase → game over
  if (!nextPhase) {
    await endGameFlow(runtime, { reason: 'All phases completed' });
    return true;
  }

  // Step 7: Clear channel map
  runtime.channels.clear();

  // Step 8: Enter next phase
  await enterPhaseFlow(runtime, nextPhase);
  return false;
}

// ── Phase timeout handler ────────────────────────────────────────

function onPhaseTimeout(runtime: SessionRuntime): void {
  advancePhase(runtime).catch((e: unknown) => runtime.log.error('Phase timeout advance error', e));
}

// ── §5.10.5 Input Processing Pipeline ────────────────────────────

export async function processInputPipeline(
  runtime: SessionRuntime,
  channelName: string,
  userId: string,
  data: unknown,
  sequence: number,
  epoch?: number,
): Promise<InputAck> {
  const { sessionId, gameDef, replaySeq } = runtime;
  const hookError = createHookErrorHandler(sessionId, runtime.log);

  // Step 0: Reject while paused (#3). Not cached against the sequence — the
  // client should retry the same sequence once the session resumes.
  if (runtime.paused) {
    return rejectInput('SESSION_PAUSED', 'Session is paused.', sequence);
  }

  // Step 1: Get channel state
  const channel = runtime.channels.get(channelName);
  if (!channel || !channel.open) {
    return rejectInput('CHANNEL_NOT_OPEN', `Channel '${channelName}' is not open.`, sequence);
  }

  // Step 2: Sequence dedup (per connection — see resetSequenceCache). The cache
  // is cleared on every (re)subscribe so a reconnecting client's fresh seq 1 is
  // processed instead of colliding with acks from its previous socket.
  const playerKey = sequenceCacheKey(sessionId, userId);
  let playerSeqCache = runtime.sequenceCache.get(playerKey);
  if (!playerSeqCache) {
    playerSeqCache = new Map();
    runtime.sequenceCache.set(playerKey, playerSeqCache);
  }
  const cachedAck = playerSeqCache.get(sequence);
  if (cachedAck) {
    return cachedAck;
  }

  // Step 2.5: Epoch guard. A stale input is one composed against an EARLIER
  // phase's frames — after a reconnect the sequence cache above is reset and
  // the client's outbound queue flushes, so without this a stale input lands
  // under a fresh sequence in a same-named channel reopened for a new phase
  // (the cross-turn wrong-phase-completion class; see SessionRuntime.inputEpoch).
  // Runs AFTER the dedup so an exact resend of an already-accepted input still
  // gets its cached ack. Unstamped inputs pass; inputs stamped AHEAD pass too
  // (a restart may resume the epoch slightly behind the last broadcast).
  if (epoch !== undefined && epoch < runtime.inputEpoch) {
    return rejectInput(
      GameErrorCode.INPUT_STALE_EPOCH,
      `Input was composed for epoch ${epoch}; the session is at ${runtime.inputEpoch}.`,
      sequence,
      { currentEpoch: runtime.inputEpoch },
    );
  }

  // Step 3: Authorize
  const player = runtime.players.get(userId);
  if (!player) {
    return rejectInput('PLAYER_NOT_IN_SESSION', 'Player not in session.', sequence);
  }

  const readonlyCtx = buildReadonlyHandlerContext(buildHandlerDeps(runtime));
  const authorized = isAuthorizedForChannel(
    channel.definition.from,
    userId,
    toGamePlayerState(player),
    runtime.turnState.activePlayer,
    readonlyCtx,
  );
  if (!authorized) {
    return rejectInput('NOT_AUTHORIZED', 'Not authorized for this channel.', sequence);
  }

  // Step 4: Validate
  const validation = validateInput(channel.definition, data, sequence);
  if (!validation.valid) {
    return (validation as { valid: false; ack: InputAck }).ack;
  }
  // Everything downstream — the game-loop buffer, recordSubmission, the onInput
  // hook, the channel process handler, the replay log, and the relay — must see
  // the schema's PARSED output, not the raw wire object. `validateInput` runs a
  // full `safeParse`, so `validation.parsed` has every `.default()` applied; the
  // original `data` does not. Forwarding the raw object meant a channel field
  // declared `optional().default([])` arrived `undefined` at a handler that read
  // it, the handler threw, and (see Step 9) that throw was swallowed with no ack
  // and no log — the player tapped the button and the phase sat there until it
  // timed out. Re-point `data` at the parsed value here, once, so no consumer
  // can diverge.
  data = validation.parsed;

  // Step 5: Rate limit
  const rlKey = channelRateLimitKey(sessionId, channelName, userId);
  const channelRateLimit = channel.definition.rateLimit;
  if (channelRateLimit) {
    const rlResult = await runtime.rateLimiter.check(
      rlKey,
      channelRateLimit.per,
      channelRateLimit.max,
    );
    if (!rlResult.allowed) {
      return rejectInput('RATE_LIMITED', 'Rate limited.', sequence);
    }
  }

  // Step 6: Buffer (game loop phase)
  if (runtime.gameLoopState?.running && channel.definition.buffer) {
    bufferInput(runtime.gameLoopState, channelName, userId, data, Date.now());
    const ack = acceptInput(sequence);
    playerSeqCache.set(sequence, ack);
    return ack;
  }

  // Step 7: Record submission. Completion eligibility must mirror the
  // channel's `from` authorization — counting every session player would keep
  // single-responder collect channels (e.g. one contestant answering) from
  // ever completing in multi-player sessions.
  const eligiblePlayerIds = playerIds(runtime).filter(candidateId => {
    const candidate = runtime.players.get(candidateId);
    if (!candidate) return false;
    try {
      return isAuthorizedForChannel(
        channel.definition.from,
        candidateId,
        toGamePlayerState(candidate),
        runtime.turnState.activePlayer,
        readonlyCtx,
      );
    } catch {
      return false;
    }
  });
  const result = recordSubmission(channel, userId, data, eligiblePlayerIds);
  if (!result.accepted) {
    return rejectInput(result.code ?? 'INPUT_REJECTED', 'Submission rejected.', sequence);
  }

  // Step 8: Invoke onInput hook
  rebuildHandlerContext(runtime);
  await invokeOnInput(gameDef.hooks, runtime.handlerContext, channelName, userId, data, hookError);

  // Step 9: Invoke channel process handler.
  //
  // A throwing handler must never be silent. Previously the error propagated out
  // of the pipeline and rejected the promise the WS layer awaited: no ack was
  // returned or cached, nothing was logged, and the input simply vanished — the
  // hardest possible failure to diagnose from the outside (the phase just hangs).
  // Isolate it the same way lifecycle hooks are already isolated: log loudly with
  // the channel, session, user, and stack, and return an explicit rejection so
  // the client is nacked rather than left waiting. On a handler failure we do NOT
  // fall through to replay/relay/turn/phase-advance — a half-processed input must
  // not advance the game.
  if (channel.definition.process && Object.hasOwn(gameDef.handlers, channel.definition.process)) {
    const handler = gameDef.handlers[channel.definition.process];
    try {
      await handler(runtime.handlerContext, userId, data);
    } catch (err) {
      runtime.log.error(
        `Channel process handler '${channel.definition.process}' threw for channel '${channelName}' in session ${sessionId} (user ${userId})`,
        err,
      );
      return rejectInput('HANDLER_ERROR', 'Input could not be processed.', sequence);
    }
  }

  // Step 10: Log to replay
  appendReplay(
    runtime,
    logChannelInput(sessionId, replaySeq, {
      channel: channelName,
      userId,
      input: data,
    }),
  );

  // Step 11: Relay to other players
  if (result.shouldRelay) {
    const targets = resolveRelayTargetsFull(
      channel.definition.relay,
      sessionId,
      toGamePlayerState(player),
      [...runtime.players.values()].map(toGamePlayerState),
      channelName,
      gameDef.relayFilters,
      readonlyCtx,
      data,
    );
    for (const room of targets.rooms) {
      runtime.publish(room, {
        type: 'game:channel.input',
        sessionId,
        channel: channelName,
        userId,
        data,
      });
    }
  }

  // Step 12: Turn completion
  if (channel.mode === 'turn') {
    rebuildHandlerContext(runtime);
    await invokeOnTurnEnd(gameDef.hooks, runtime.handlerContext, userId, hookError);
    const nextPlayer = advanceTurn(runtime.turnState);
    if (nextPlayer) {
      await invokeOnTurnStart(gameDef.hooks, runtime.handlerContext, nextPlayer, hookError);
      runtime.publish(sessionRoom(sessionId), {
        type: 'game:turn.advanced',
        sessionId,
        previousPlayer: userId,
        nextPlayer,
      });
      appendReplay(
        runtime,
        logTurnAdvanced(sessionId, replaySeq, {
          previousPlayer: userId,
          nextPlayer,
          turnNumber: runtime.turnState.cycleCount,
        }),
      );
    } else {
      completeTurnCycle(runtime.turnState);
    }
  }

  // Step 13: Check channel completion
  if (result.shouldComplete) {
    closeChannel(channel);
    runtime.publish(sessionRoom(sessionId), {
      type: 'game:channel.closed',
      sessionId,
      channel: channelName,
      reason: 'complete',
    });
    appendReplay(
      runtime,
      logChannelClosed(sessionId, replaySeq, {
        channel: channelName,
        reason: 'complete',
        submissionCount: channel.submissions.size,
      }),
    );
  }

  // Step 14: Check phase advance trigger
  const currentPhaseName = runtime.phaseState.currentPhase ?? '';
  if (Object.hasOwn(gameDef.phases, currentPhaseName)) {
    const phaseDef = gameDef.phases[currentPhaseName];
    const trigger = getAdvanceTrigger(phaseDef);
    if (trigger === 'all-channels-complete') {
      if (areAllChannelsComplete(runtime.phaseState.activeChannels, runtime.channels)) {
        await advancePhase(runtime);
      }
    } else if (trigger === 'any-channel-complete' && result.shouldComplete) {
      if (isAnyChannelComplete(runtime.phaseState.activeChannels, runtime.channels)) {
        await advancePhase(runtime);
      }
    }
  }

  // Step 15: Broadcast state update (event sync mode)
  if (gameDef.sync.mode === 'event') {
    runtime.publish(sessionRoom(sessionId), {
      type: 'game:state.updated',
      sessionId,
    });
  }

  // Step 16: Cache and return ack
  const ack = acceptInput(sequence);
  playerSeqCache.set(sequence, ack);
  return ack;
}

// ── §5.10.6 Disconnect Flow ──────────────────────────────────────

export async function handleDisconnect(runtime: SessionRuntime, userId: string): Promise<void> {
  const { sessionId, gameDef, timerState, disconnectState, phaseState, replaySeq } = runtime;
  const hookError = createHookErrorHandler(sessionId, runtime.log);

  // Step 1: Mark player disconnected
  const player = runtime.players.get(userId);
  if (!player) return;

  player.connected = false;
  player.disconnectedAt = new Date();
  player.disconnectCount++;

  // Step 2: Record disconnect snapshot
  const phaseTimerId = phaseState.phaseTimerId;
  const turnTimeRemaining = phaseTimerId ? getTimeRemaining(timerState, phaseTimerId) : null;
  recordDisconnect(
    disconnectState,
    toGamePlayerState(player),
    runtime.turnState.activePlayer,
    turnTimeRemaining,
  );

  // Step 3: Invoke onPlayerDisconnected hook
  rebuildHandlerContext(runtime);
  await invokeOnPlayerDisconnected(
    gameDef.hooks,
    runtime.handlerContext,
    toGamePlayerState(player),
    hookError,
  );

  // Step 4: Broadcast
  runtime.publish(sessionRoom(sessionId), {
    type: 'game:player.disconnected',
    sessionId,
    userId,
  });
  const rawGracePeriod = gameDef.disconnect?.gracePeriodMs;
  const gracePeriodMs =
    typeof rawGracePeriod === 'function'
      ? rawGracePeriod(buildReadonlyHandlerContext(buildHandlerDeps(runtime)))
      : (rawGracePeriod ?? 30_000);
  appendReplay(
    runtime,
    logPlayerDisconnected(sessionId, replaySeq, {
      userId,
      wasActivePlayer: runtime.turnState.activePlayer === userId,
      gracePeriodMs,
    }),
  );

  // Step 5: Check all disconnected
  const allPlayers = [...runtime.players.values()].map(toGamePlayerState);
  if (areAllPlayersDisconnected(allPlayers)) {
    rebuildHandlerContext(runtime);
    const result = await invokeOnAllPlayersDisconnected(
      gameDef.hooks,
      runtime.handlerContext,
      hookError,
    );
    if (result.abandon) {
      await endGameFlow(runtime, { reason: 'All players disconnected' });
    }
    return;
  }

  // Step 6: Handle turn behavior
  if (userId === runtime.turnState.activePlayer && gameDef.disconnect) {
    const resolvedConfig = resolveDisconnectConfig({}, gameDef.disconnect);
    const behavior = resolveTurnBehavior(resolvedConfig);
    if (behavior === 'skip') {
      const nextPlayer = advanceTurn(runtime.turnState);
      if (nextPlayer) {
        runtime.publish(sessionRoom(sessionId), {
          type: 'game:turn.advanced',
          sessionId,
          previousPlayer: userId,
          nextPlayer,
        });
      }
    }
  }

  // Step 7: Handle channel disconnect behavior
  for (const [, channel] of runtime.channels) {
    if (channel.open) {
      const isActivePlayer = runtime.turnState.activePlayer === userId;
      const action = getChannelDisconnectBehavior(channel.mode, isActivePlayer);
      if (action.action === 'abstain') {
        const eligibleIds = playerIds(runtime);
        recordSubmission(channel, userId, null, eligibleIds);
      }
    }
  }

  // Step 8: Start grace period timer
  const graceTimerHandle = createTimer(
    timerState,
    sessionId,
    'custom',
    gracePeriodMs,
    'graceExpiry',
    () => {
      onGraceExpiry(runtime, userId);
    },
  );
  setGraceTimer(disconnectState, userId, graceTimerHandle);

  // Step 9: Host role is intentionally NOT auto-transferred on a mere socket
  // close (#5). Previously any host disconnect handed isHost to the
  // lowest-joinOrder contestant with no restore path, which corrupted the
  // roster (a contestant left permanently flagged host and unable to play).
  // The host keeps their role across a transient disconnect and reclaims their
  // socket via the (re)subscribe reconnect flow. An intentional handoff still
  // goes through the explicit REST leave/transfer path (playerLeaveGuard).
}

function onGraceExpiry(runtime: SessionRuntime, userId: string): void {
  runtime.log.info(`Grace period expired for player ${userId} in session ${runtime.sessionId}`);
}

// ── §5.10.7 Reconnection Flow ────────────────────────────────────

export async function handleReconnectFlow(
  runtime: SessionRuntime,
  userId: string,
  subscribe: (room: string) => void,
  ack: (data: unknown) => void,
  publish: (room: string, data: unknown) => void,
): Promise<void> {
  const { sessionId, gameDef, disconnectState, timerState, afkState, replaySeq } = runtime;
  const hookError = createHookErrorHandler(sessionId, runtime.log);

  // Step 1: Mark player reconnected
  const player = runtime.players.get(userId);
  if (!player) return;

  const wasDisconnected = !player.connected || player.disconnectedAt !== null;
  const disconnectedForMs = player.disconnectedAt
    ? Date.now() - player.disconnectedAt.getTime()
    : 0;
  player.connected = true;
  player.disconnectedAt = null;

  // A reconnect means a new socket, whose input sequence restarts at 1 (#1).
  resetSequenceCache(runtime, userId);

  // Step 2: Cancel grace period
  const graceTimerId = getGraceTimerId(disconnectState, userId);
  if (graceTimerId) {
    cancelTimer(timerState, graceTimerId);
  }
  clearDisconnect(disconnectState, userId);

  // Step 3: Re-subscribe to WS rooms
  const rooms = getPlayerRooms(sessionId, toGamePlayerState(player));
  for (const room of rooms) {
    subscribe(room);
  }

  // Step 4: Build reconnection snapshot
  const channelEntries = new Map<
    string,
    { name: string; mode: string; open: boolean; endsAt: number | null }
  >();
  for (const [name, ch] of runtime.channels) {
    channelEntries.set(name, { name, mode: ch.mode, open: ch.open, endsAt: ch.endsAt });
  }

  const scores = new Map<string, number>();
  for (const [uid, p] of runtime.players) {
    scores.set(uid, p.score);
  }

  const phaseTimerId = runtime.phaseState.phaseTimerId;
  const phaseEndsAt = phaseTimerId ? getTimeRemaining(timerState, phaseTimerId) + Date.now() : null;

  const session = {
    status: runtime.phaseState.currentPhase ? 'playing' : 'lobby',
    currentPhase: runtime.phaseState.currentPhase,
    currentSubPhase: runtime.phaseState.currentSubPhase,
    rules: runtime.rules as Record<string, unknown>,
  };

  const snapshot = buildReconnectionSnapshot(
    sessionId,
    session,
    [...runtime.players.values()].map(toGamePlayerState),
    runtime.gameState,
    runtime.privateStateManager.get(userId),
    runtime.turnState.activePlayer,
    channelEntries,
    scores,
    phaseEndsAt,
  );

  // Step 5: Send snapshot
  ack({ type: 'game:state.snapshot', ...snapshot });

  // Steps 6 & 7: Fire the reconnected hook + broadcast only when the player was
  // actually disconnected. A first-time subscribe (never disconnected) still
  // receives a fresh snapshot above but must not emit a spurious "reconnected"
  // event to the rest of the table.
  if (wasDisconnected) {
    // Step 6: Invoke onPlayerReconnected hook
    rebuildHandlerContext(runtime);
    await invokeOnPlayerReconnected(
      gameDef.hooks,
      runtime.handlerContext,
      toGamePlayerState(player),
      hookError,
    );

    // Step 7: Broadcast
    publish(sessionRoom(sessionId), {
      type: 'game:player.reconnected',
      sessionId,
      userId,
    });
    appendReplay(
      runtime,
      logPlayerReconnected(sessionId, replaySeq, {
        userId,
        disconnectedForMs,
      }),
    );
  }

  // Step 8: Record activity
  recordPlayerActivity(afkState, userId);
}

/**
 * Restore a player's live connection when they (re)subscribe to an active
 * session (#4).
 *
 * The jeopardy client (and others) only ever send `game:subscribe`, never
 * `game:reconnect`, so without this every socket close would leave
 * `connected=false` forever. This reuses the reconnect bookkeeping —
 * restore `connected`, clear `disconnectedAt`, cancel the grace timer, drop the
 * disconnect snapshot, reset the per-connection input sequence cache (#1), and
 * broadcast `game:player.reconnected` — but does NOT send a state snapshot: the
 * `game:subscribe` handler already delivers one.
 *
 * Returns `true` when an active runtime handled the (re)subscribe (so the caller
 * knows a live session exists). Broadcast/hook only fire when the player was
 * actually disconnected, keeping a first-time subscribe side-effect free.
 */
export async function handleSubscribeConnection(
  runtime: SessionRuntime,
  userId: string,
  publish: (room: string, data: unknown) => void,
): Promise<boolean> {
  const { sessionId, gameDef, disconnectState, timerState, afkState, replaySeq } = runtime;
  const player = runtime.players.get(userId);
  if (!player) return false;

  // A (re)subscribe is a new socket whose input sequence restarts at 1 (#1).
  resetSequenceCache(runtime, userId);

  const wasDisconnected = !player.connected || player.disconnectedAt !== null;
  if (!wasDisconnected) return true;

  player.connected = true;
  const disconnectedForMs = player.disconnectedAt
    ? Date.now() - player.disconnectedAt.getTime()
    : 0;
  player.disconnectedAt = null;

  const graceTimerId = getGraceTimerId(disconnectState, userId);
  if (graceTimerId) {
    cancelTimer(timerState, graceTimerId);
  }
  clearDisconnect(disconnectState, userId);

  const hookError = createHookErrorHandler(sessionId, runtime.log);
  rebuildHandlerContext(runtime);
  await invokeOnPlayerReconnected(
    gameDef.hooks,
    runtime.handlerContext,
    toGamePlayerState(player),
    hookError,
  );

  publish(sessionRoom(sessionId), {
    type: 'game:player.reconnected',
    sessionId,
    userId,
  });
  appendReplay(
    runtime,
    logPlayerReconnected(sessionId, replaySeq, {
      userId,
      disconnectedForMs,
    }),
  );
  recordPlayerActivity(afkState, userId);
  return true;
}

// ── §5.10.8 Game End Flow ────────────────────────────────────────

export async function endGameFlow(runtime: SessionRuntime, winResult: WinResult): Promise<void> {
  const { sessionId, gameDef, timerState, scoreState, replaySeq } = runtime;
  const hookError = createHookErrorHandler(sessionId, runtime.log);

  // Step 1: Stop game loop
  if (runtime.gameLoopState?.running) {
    stopGameLoop(runtime.gameLoopState);
  }

  // Step 2: Cancel all timers
  cancelAllTimers(timerState);

  // Step 3: Close all channels
  for (const [, channel] of runtime.channels) {
    if (channel.open) {
      closeChannel(channel);
    }
  }

  // Step 4: Invoke onGameEnd hook
  rebuildHandlerContext(runtime);
  await invokeOnGameEnd(gameDef.hooks, runtime.handlerContext, winResult, hookError);

  // Step 5: Build final leaderboard
  const leaderboard = buildLeaderboard(scoreState, gameDef.scoring);

  // Step 6: Log to replay
  appendReplay(
    runtime,
    logSessionCompleted(sessionId, replaySeq, {
      result: {
        type: winResult.draw ? 'draw' : winResult.winners?.length ? 'winner' : 'complete',
        winners: winResult.winners,
        reason: winResult.reason,
      },
    }),
  );

  // Step 7: Flush replay.
  //
  // Entries are already being flushed continuously as they are produced (see
  // `scheduleReplayFlush`); this awaits the tail so the session is not
  // broadcast as completed while its own completion entry is still unwritten.
  // It is no longer the only time the log reaches the store.
  await flushReplayEntries(runtime);

  // Step 8: Broadcast
  runtime.publish(sessionRoom(sessionId), {
    type: 'game:session.completed',
    sessionId,
    winResult,
    leaderboard,
  });

  // Step 8.5: Notify the owning plugin (persist terminal state, app bus).
  // Error-isolated: completion must finish even if the callback fails.
  if (runtime.onCompleted) {
    try {
      await runtime.onCompleted(winResult, leaderboard, runtime.gameState);
    } catch (e: unknown) {
      runtime.log.error('onCompleted callback failed', e);
    }
  }

  // Step 9: Clean up — remove from active runtimes
  // The plugin closure's activeRuntimes map holds the reference.
  // We search for our runtime by sessionId. The caller (plugin.ts) passes
  // activeRuntimes as a dep in SessionRuntimeDeps. We stored it during
  // createSessionRuntime. For cleanup, the plugin can remove it.
  // Since we don't hold a direct reference to the map here, the caller
  // is responsible for cleanup after endGameFlow returns.
}

/** Destroy a session runtime, cleaning up all resources. */
export function destroySessionRuntime(
  activeRuntimes: Map<string, SessionRuntime>,
  sessionId: string,
): void {
  const runtime = activeRuntimes.get(sessionId);
  if (!runtime) return;

  if (runtime.gameLoopState?.running) {
    stopGameLoop(runtime.gameLoopState);
  }
  cancelAllTimers(runtime.timerState);
  activeRuntimes.delete(sessionId);
}
