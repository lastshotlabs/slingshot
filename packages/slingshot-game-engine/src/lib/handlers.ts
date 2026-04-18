/**
 * Handler context factory.
 *
 * Builds the `ProcessHandlerContext` and `ReadonlyHandlerContext` objects
 * that are passed to ALL game handlers (process, onEnter, onExit, onTick,
 * lifecycle hooks, win condition checks).
 *
 * The context wraps mutable session internals (turns, scoring, channels,
 * timers, game loop, RNG) into the public API surface defined in §12.3.
 *
 * See spec §12.3 for the full ProcessHandlerContext contract.
 */
import type {
  BufferedInput,
  ChannelRuntimeState,
  GamePlayerState,
  ProcessHandlerContext,
  ReadonlyHandlerContext,
  ScheduledEvent,
  SeededRng,
  WinResult,
} from '../types/models';
import type { MutableChannelState } from './channels';
import { closeChannel as closeChannelState, freezeChannelState } from './channels';
import { hostRoom, playerRoom, sessionRoom } from './display';
import type { MutableGameLoopState } from './gameLoop';
import {
  cancelScheduledEvent,
  consumeBufferedInputs,
  consumeScheduledEvents,
  getScheduledEvents,
  scheduleEvent,
} from './gameLoop';
import type { MutablePhaseState } from './phases';
import type { MutablePlayer } from './runtimeTypes';
import type { MutableScoreState } from './scoring';
import {
  addScore,
  computeLeaderboard,
  computeTeamScores,
  getPlayerStreak,
  getScore,
  setScore,
} from './scoring';
import type { MutableTimerState } from './timers';
import { extendTimer, getTimeRemaining, getTimersByType, resetTimer } from './timers';
import type { MutableTurnState } from './turns';
import {
  completeTurnCycle,
  freezeTurnState,
  getActedPlayers,
  getRemainingPlayers,
  insertNextPlayer,
  reverseTurnOrder,
  rotateTurnStart,
  setActivePlayer,
  setTurnOrder,
  skipNextPlayer,
  skipPlayer,
} from './turns';

/** Dependencies needed to build a ProcessHandlerContext. */
export interface HandlerContextDeps {
  sessionId: string;
  gameType: string;
  rules: Readonly<Record<string, unknown>>;
  phaseState: MutablePhaseState;
  currentRound: number;
  gameState: Record<string, unknown>;
  privateState: Map<string, unknown>;
  players: Map<string, MutablePlayer>;
  turnState: MutableTurnState;
  scoreState: MutableScoreState;
  channels: Map<string, MutableChannelState>;
  timerState: MutableTimerState;
  gameLoopState: MutableGameLoopState | null;
  rng: SeededRng;

  /** Publish a WS message to a room. */
  publish: (
    room: string,
    message: unknown,
    options?: { exclude?: ReadonlySet<string>; volatile?: boolean; trackDelivery?: boolean },
  ) => void;

  /** Set to signal that the current phase should advance. */
  requestAdvancePhase: () => void;

  /** Set to signal that the game should end. */
  requestEndGame: (result: WinResult) => void;

  /** Set to update the current round. */
  setCurrentRound: (round: number) => void;

  /** Set a manual next phase override. */
  setNextPhase: (phase: string) => void;

  /** Set a player's state. */
  updatePlayerState: (userId: string, state: string) => void;

  /** Create a child session. */
  createChildSession: (
    gameType: string,
    players: string[],
    rules?: Record<string, unknown>,
  ) => Promise<{ sessionId: string }>;

  /** Get a child session result. */
  getChildSessionResult: (sessionId: string) => Promise<WinResult | null>;

  /** Logger. */
  log: {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
}

/**
 * Build a full ProcessHandlerContext from session internals.
 *
 * This is the primary mutation API exposed to game handlers.
 */
export function buildProcessHandlerContext(deps: HandlerContextDeps): ProcessHandlerContext {
  const {
    sessionId,
    gameType,
    rules,
    phaseState,
    currentRound,
    gameState,
    privateState,
    players,
    turnState,
    scoreState,
    channels,
    timerState,
    gameLoopState,
    rng,
    publish,
    requestAdvancePhase,
    requestEndGame,
    setCurrentRound,
    setNextPhase,
    updatePlayerState,
    createChildSession,
    getChildSessionResult,
    log,
  } = deps;

  const getPlayersArray = (): readonly Readonly<GamePlayerState>[] => [...players.values()];
  let liveCurrentRound = currentRound;

  const ctx: ProcessHandlerContext = {
    // Session info (read-only)
    sessionId,
    gameType,
    rules,
    get currentPhase() {
      return phaseState.currentPhase ?? '';
    },
    get currentSubPhase() {
      return phaseState.currentSubPhase;
    },
    get currentRound() {
      return liveCurrentRound;
    },

    // Game state (mutable)
    gameState,

    // Private state
    getPrivateState(userId: string): unknown {
      return privateState.get(userId) ?? null;
    },
    setPrivateState(userId: string, data: unknown): void {
      privateState.set(userId, data);
      publish(
        playerRoom(sessionId, userId),
        {
          type: 'game:privateState.updated',
          sessionId,
          data,
        },
        { trackDelivery: true },
      );
    },
    updatePrivateState(userId: string, updater: (current: unknown) => unknown): void {
      const current = privateState.get(userId) ?? null;
      const updated = updater(current);
      ctx.setPrivateState(userId, updated);
    },

    // Player queries
    getPlayer(userId: string): Readonly<GamePlayerState> {
      const p = players.get(userId);
      if (!p) throw new Error(`Player ${userId} not found in session ${sessionId}`);
      return p;
    },
    getPlayers: getPlayersArray,
    getPlayersByRole(role: string): readonly Readonly<GamePlayerState>[] {
      return getPlayersArray().filter(p => p.role === role);
    },
    getPlayersByTeam(team: string): readonly Readonly<GamePlayerState>[] {
      return getPlayersArray().filter(p => p.team === team);
    },
    getPlayersByState(state: string): readonly Readonly<GamePlayerState>[] {
      return getPlayersArray().filter(p => p.playerState === state);
    },
    getConnectedPlayers(): readonly Readonly<GamePlayerState>[] {
      return getPlayersArray().filter(p => p.connected);
    },
    getDisconnectedPlayers(): readonly Readonly<GamePlayerState>[] {
      return getPlayersArray().filter(p => !p.connected);
    },

    // Player mutations
    setPlayerState(userId: string, state: string): void {
      updatePlayerState(userId, state);
    },
    setPlayerStates(userIds: string[], state: string): void {
      for (const uid of userIds) {
        updatePlayerState(uid, state);
      }
    },

    // Turn order
    getActivePlayer(): string | null {
      return turnState.activePlayer;
    },
    getTurnOrder(): readonly string[] {
      return freezeTurnState(turnState).order;
    },
    setTurnOrder(order: string[]): void {
      setTurnOrder(turnState, order);
    },
    setActivePlayer(userId: string): void {
      setActivePlayer(turnState, userId);
    },
    reverseTurnOrder(): void {
      reverseTurnOrder(turnState);
    },
    skipNextPlayer(): void {
      skipNextPlayer(turnState);
    },
    skipPlayer(userId: string): void {
      skipPlayer(turnState, userId);
    },
    insertNextPlayer(userId: string): void {
      insertNextPlayer(turnState, userId);
    },
    rotateTurnStart(): void {
      rotateTurnStart(turnState);
    },
    completeTurnCycle(): void {
      completeTurnCycle(turnState);
    },
    getActedCount(): number {
      return turnState.acted.size;
    },
    getActedPlayers(): string[] {
      return getActedPlayers(turnState);
    },
    getRemainingPlayers(): string[] {
      return getRemainingPlayers(turnState);
    },

    // Scoring
    addScore(userId: string, points: number, breakdown?: Record<string, unknown>): void {
      addScore(scoreState, userId, points, currentRound, breakdown);
      const score = getScore(scoreState, userId);
      publish(sessionRoom(sessionId), {
        type: 'game:score.changed',
        sessionId,
        userId,
        score,
        change: points,
        breakdown,
      });
    },
    setScore(userId: string, points: number): void {
      const prev = getScore(scoreState, userId);
      setScore(scoreState, userId, points);
      publish(sessionRoom(sessionId), {
        type: 'game:score.changed',
        sessionId,
        userId,
        score: points,
        change: points - prev,
      });
    },
    getScore(userId: string): number {
      return getScore(scoreState, userId);
    },
    getLeaderboard(): Array<{ userId: string; score: number; rank: number }> {
      return computeLeaderboard(scoreState);
    },
    getTeamScores(): Array<{ team: string; score: number; rank: number }> {
      return computeTeamScores(scoreState);
    },
    getPlayerStreak(userId: string): number {
      return getPlayerStreak(scoreState, userId);
    },

    // Phase control
    advancePhase(): void {
      requestAdvancePhase();
    },
    setNextPhase(phase: string): void {
      setNextPhase(phase);
    },
    setCurrentRound(round: number): void {
      liveCurrentRound = round;
      setCurrentRound(round);
    },
    incrementRound(): void {
      liveCurrentRound += 1;
      setCurrentRound(liveCurrentRound);
    },

    // Channel control
    closeChannel(channelName: string): void {
      const ch = channels.get(channelName);
      if (ch) {
        closeChannelState(ch);
        publish(sessionRoom(sessionId), {
          type: 'game:channel.closed',
          sessionId,
          channel: channelName,
          reason: 'handler',
        });
      }
    },
    getChannelState(channelName: string): ChannelRuntimeState {
      const ch = channels.get(channelName);
      if (!ch) throw new Error(`Channel ${channelName} not found in session ${sessionId}`);
      return freezeChannelState(ch);
    },
    getChannelInputs(channelName: string): Map<string, { input: unknown; submittedAt: number }> {
      const ch = channels.get(channelName);
      if (!ch) return new Map();
      return new Map(ch.submissions);
    },

    // Timer control
    extendTimer(ms: number): void {
      const phaseTimers = getTimersByType(timerState, 'phase');
      if (phaseTimers.length > 0) {
        extendTimer(timerState, phaseTimers[0].id, ms, () => {});
        const remaining = getTimeRemaining(timerState, phaseTimers[0].id);
        publish(sessionRoom(sessionId), {
          type: 'game:timer.updated',
          sessionId,
          phaseEndsAt: Date.now() + remaining,
        });
      }
    },
    resetTimer(ms: number): void {
      const phaseTimers = getTimersByType(timerState, 'phase');
      if (phaseTimers.length > 0) {
        resetTimer(timerState, phaseTimers[0].id, ms, () => {});
        publish(sessionRoom(sessionId), {
          type: 'game:timer.updated',
          sessionId,
          phaseEndsAt: Date.now() + ms,
        });
      }
    },
    getTimeRemaining(): number {
      const phaseTimers = getTimersByType(timerState, 'phase');
      if (phaseTimers.length === 0) return 0;
      return getTimeRemaining(timerState, phaseTimers[0].id);
    },
    getPhaseEndsAt(): number {
      const phaseTimers = getTimersByType(timerState, 'phase');
      if (phaseTimers.length === 0) return 0;
      return phaseTimers[0].endsAt;
    },

    // RNG
    random: rng,

    // Scheduled events (game loop only)
    scheduleEvent(delayTicks: number, type: string, data: unknown): string {
      if (!gameLoopState)
        throw new Error('scheduleEvent is only available during game loop phases');
      return scheduleEvent(gameLoopState, delayTicks, type, data);
    },
    cancelScheduledEvent(eventId: string): boolean {
      if (!gameLoopState) return false;
      return cancelScheduledEvent(gameLoopState, eventId);
    },
    getScheduledEvents(): Array<{
      id: string;
      type: string;
      data: unknown;
      firesAtTick: number;
    }> {
      if (!gameLoopState) return [];
      return getScheduledEvents(gameLoopState);
    },
    consumeBufferedInputs(channel: string): BufferedInput[] {
      if (!gameLoopState) return [];
      return consumeBufferedInputs(gameLoopState, channel);
    },
    consumeScheduledEvents(): ScheduledEvent[] {
      if (!gameLoopState) return [];
      return consumeScheduledEvents(gameLoopState);
    },

    // State broadcasting
    broadcastState(data: Record<string, unknown>): void {
      publish(sessionRoom(sessionId), {
        type: 'game:state.updated',
        sessionId,
        data,
      });
    },
    broadcastTo(audience: string, data: Record<string, unknown>): void {
      let room: string;
      switch (audience) {
        case 'all':
          room = sessionRoom(sessionId);
          break;
        case 'host':
          room = hostRoom(sessionId);
          break;
        default:
          // Treat as a userId
          room = playerRoom(sessionId, audience);
          break;
      }
      publish(room, { type: 'game:state.updated', sessionId, data });
    },
    sendToPlayer(userId: string, data: unknown): void {
      publish(
        playerRoom(sessionId, userId),
        {
          type: 'game:privateState.updated',
          sessionId,
          data,
        },
        { trackDelivery: true },
      );
    },

    // Child sessions
    createChildSession,
    getChildSessionResult,

    // Game end
    endGame(result: WinResult): void {
      requestEndGame(result);
    },

    // Logging
    log,
  };

  return ctx;
}

/**
 * Build a read-only subset of ProcessHandlerContext.
 *
 * Used for `enabled` conditions, `checkWinCondition`, dynamic config
 * resolution, and `next` function resolution.
 */
export function buildReadonlyHandlerContext(deps: HandlerContextDeps): ReadonlyHandlerContext {
  const {
    sessionId,
    gameType,
    rules,
    phaseState,
    currentRound,
    gameState,
    privateState,
    players,
    turnState,
    scoreState,
    channels,
    timerState,
    gameLoopState,
    rng,
    log,
  } = deps;

  const getPlayersArray = (): readonly Readonly<GamePlayerState>[] => [...players.values()];

  return {
    sessionId,
    gameType,
    rules,
    get currentPhase() {
      return phaseState.currentPhase ?? '';
    },
    get currentSubPhase() {
      return phaseState.currentSubPhase;
    },
    currentRound,
    gameState: Object.freeze({ ...gameState }),

    getPrivateState(userId: string): unknown {
      return privateState.get(userId) ?? null;
    },

    getPlayer(userId: string): Readonly<GamePlayerState> {
      const p = players.get(userId);
      if (!p) throw new Error(`Player ${userId} not found in session ${sessionId}`);
      return p;
    },
    getPlayers: getPlayersArray,
    getPlayersByRole(role: string) {
      return getPlayersArray().filter(p => p.role === role);
    },
    getPlayersByTeam(team: string) {
      return getPlayersArray().filter(p => p.team === team);
    },
    getPlayersByState(state: string) {
      return getPlayersArray().filter(p => p.playerState === state);
    },
    getConnectedPlayers() {
      return getPlayersArray().filter(p => p.connected);
    },
    getDisconnectedPlayers() {
      return getPlayersArray().filter(p => !p.connected);
    },

    getActivePlayer(): string | null {
      return turnState.activePlayer;
    },
    getTurnOrder(): readonly string[] {
      return freezeTurnState(turnState).order;
    },
    getActedCount(): number {
      return turnState.acted.size;
    },
    getActedPlayers(): string[] {
      return getActedPlayers(turnState);
    },
    getRemainingPlayers(): string[] {
      return getRemainingPlayers(turnState);
    },

    getScore(userId: string): number {
      return getScore(scoreState, userId);
    },
    getLeaderboard() {
      return computeLeaderboard(scoreState);
    },
    getTeamScores() {
      return computeTeamScores(scoreState);
    },
    getPlayerStreak(userId: string): number {
      return getPlayerStreak(scoreState, userId);
    },

    getChannelState(channelName: string): ChannelRuntimeState {
      const ch = channels.get(channelName);
      if (!ch) throw new Error(`Channel ${channelName} not found in session ${sessionId}`);
      return freezeChannelState(ch);
    },
    getChannelInputs(channelName: string): Map<string, { input: unknown; submittedAt: number }> {
      const ch = channels.get(channelName);
      if (!ch) return new Map();
      return new Map(ch.submissions);
    },

    getTimeRemaining(): number {
      const phaseTimers = getTimersByType(timerState, 'phase');
      if (phaseTimers.length === 0) return 0;
      return getTimeRemaining(timerState, phaseTimers[0].id);
    },
    getPhaseEndsAt(): number {
      const phaseTimers = getTimersByType(timerState, 'phase');
      if (phaseTimers.length === 0) return 0;
      return phaseTimers[0].endsAt;
    },

    random: rng,

    getScheduledEvents() {
      if (!gameLoopState) return [];
      return getScheduledEvents(gameLoopState);
    },

    log,
  };
}
