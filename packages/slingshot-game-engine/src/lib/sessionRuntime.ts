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
  selectNewHost,
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
import type { MutablePlayer } from './runtimeTypes';
import type { MutableScoreState } from './scoring';
import {
  buildLeaderboard,
  createScoreState,
  initializePlayerScore,
  registerPlayerTeam,
} from './scoring';
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
  readonly rules: Readonly<Record<string, unknown>>;

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

  handlerContext: ReturnType<typeof buildProcessHandlerContext>;

  /** Per-session per-player sequence dedup cache. */
  readonly sequenceCache: Map<string, Map<number, InputAck>>;

  /** Pending replay entries not yet flushed. */
  readonly pendingReplayEntries: ReplayEntry[];
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
      advancePhase(runtime).catch((e: unknown) => runtime.log.error('advancePhase error', e));
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
    // TODO(child-sessions): Stub — returns empty sessionId. Full implementation
    // requires sessionAdapter and gameRegistry in SessionRuntimeDeps to create
    // real child session entities and spawn child runtimes. Games that call
    // createChildSession will receive { sessionId: '' } until this is wired.
    createChildSession: () => Promise.resolve({ sessionId: '' }),
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
  const gameState: Record<string, unknown> = {};
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
  const currentRound = 1;

  // Step 2: Initialize player scores
  for (const p of players.values()) {
    initializePlayerScore(scoreState, p.userId);
    if (p.team) {
      registerPlayerTeam(scoreState, p.userId, p.team);
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

  // Declare runtime first so closure-based deps (requestAdvancePhase, etc.)
  // can capture it by reference. The closures are only called after runtime
  // is fully assigned below, so the forward reference is safe.
  const runtimeRef: { current: SessionRuntime | null } = { current: null };

  // Step 5: Build handler deps and context. The closures in buildHandlerDeps
  // read from the `runtime` variable — they resolve at call time, not capture
  // time, so this works despite runtime not being assigned yet.
  const initialDeps: HandlerContextDeps = {
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
    publish: deps.publish,
    requestAdvancePhase: () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      advancePhase(runtime).catch((e: unknown) => deps.log.error('advancePhase error', e));
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
    publish: deps.publish,
    replayStore: deps.replayStore,
    log: deps.log,
    handlerContext,
    sequenceCache: new Map(),
    pendingReplayEntries: [],
  };
  runtimeRef.current = runtime;

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
    await enterPhaseFlow(runtime, firstPhaseForLog);
  }

  // Step 10: Store runtime
  deps.activeRuntimes.set(sessionId, runtime);

  // Step 11: Return
  return runtime;
}

// ── §5.10.3 Enter Phase Flow ─────────────────────────────────────

export async function enterPhaseFlow(runtime: SessionRuntime, phaseName: string): Promise<void> {
  const { gameDef, phaseState, timerState, replaySeq, sessionId } = runtime;
  const hookError = createHookErrorHandler(sessionId, runtime.log);

  // Step 1: Update phase state
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
  rebuildHandlerContext(runtime);
  if (phaseDef.onEnter && Object.hasOwn(gameDef.handlers, phaseDef.onEnter)) {
    const handler = gameDef.handlers[phaseDef.onEnter];
    await handler(runtime.handlerContext);
  }
  await invokeOnPhaseEnter(gameDef.hooks, runtime.handlerContext, phaseName, hookError);

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

// ── §5.10.4 Phase Advance Flow ───────────────────────────────────

export async function advancePhase(runtime: SessionRuntime): Promise<void> {
  const { gameDef, phaseState, timerState, replaySeq, sessionId } = runtime;
  const hookError = createHookErrorHandler(sessionId, runtime.log);
  const currentPhase = phaseState.currentPhase;

  if (!currentPhase) return;

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
    return;
  }

  // Step 7: Clear channel map
  runtime.channels.clear();

  // Step 8: Enter next phase
  await enterPhaseFlow(runtime, nextPhase);
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
): Promise<InputAck> {
  const { sessionId, gameDef, replaySeq } = runtime;
  const hookError = createHookErrorHandler(sessionId, runtime.log);

  // Step 1: Get channel state
  const channel = runtime.channels.get(channelName);
  if (!channel || !channel.open) {
    return rejectInput('CHANNEL_NOT_OPEN', `Channel '${channelName}' is not open.`, sequence);
  }

  // Step 2: Sequence dedup
  const playerKey = `${sessionId}:${userId}`;
  let playerSeqCache = runtime.sequenceCache.get(playerKey);
  if (!playerSeqCache) {
    playerSeqCache = new Map();
    runtime.sequenceCache.set(playerKey, playerSeqCache);
  }
  const cachedAck = playerSeqCache.get(sequence);
  if (cachedAck) {
    return cachedAck;
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

  // Step 7: Record submission
  const eligiblePlayerIds = playerIds(runtime);
  const result = recordSubmission(channel, userId, data, eligiblePlayerIds);
  if (!result.accepted) {
    return rejectInput(result.code ?? 'INPUT_REJECTED', 'Submission rejected.', sequence);
  }

  // Step 8: Invoke onInput hook
  rebuildHandlerContext(runtime);
  await invokeOnInput(gameDef.hooks, runtime.handlerContext, channelName, userId, data, hookError);

  // Step 9: Invoke channel process handler
  if (channel.definition.process && Object.hasOwn(gameDef.handlers, channel.definition.process)) {
    const handler = gameDef.handlers[channel.definition.process];
    await handler(runtime.handlerContext, userId, data);
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

  // Step 9: Host transfer
  if (player.isHost) {
    const newHostId = selectNewHost(allPlayers, userId);
    if (newHostId) {
      player.isHost = false;
      const newHost = runtime.players.get(newHostId);
      if (newHost) {
        newHost.isHost = true;
        runtime.publish(sessionRoom(sessionId), {
          type: 'game:host.transferred',
          sessionId,
          previousHost: userId,
          newHost: newHostId,
        });
      }
    }
  }
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

  const disconnectedForMs = player.disconnectedAt
    ? Date.now() - player.disconnectedAt.getTime()
    : 0;
  player.connected = true;

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

  // Step 8: Record activity
  recordPlayerActivity(afkState, userId);
}

// ── §5.10.8 Game End Flow ────────────────────────────────────────

export async function endGameFlow(runtime: SessionRuntime, winResult: WinResult): Promise<void> {
  const { sessionId, gameDef, timerState, scoreState, replaySeq, replayStore } = runtime;
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

  // Step 7: Flush replay
  if (runtime.pendingReplayEntries.length > 0) {
    await replayStore
      .appendReplayEntries(sessionId, runtime.pendingReplayEntries)
      .catch((e: unknown) => {
        runtime.log.error('Failed to flush replay entries', e);
      });
    runtime.pendingReplayEntries.length = 0;
  }

  // Step 8: Broadcast
  runtime.publish(sessionRoom(sessionId), {
    type: 'game:session.completed',
    sessionId,
    winResult,
    leaderboard,
  });

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
