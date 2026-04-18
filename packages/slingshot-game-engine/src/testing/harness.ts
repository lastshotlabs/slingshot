/**
 * Test game harness.
 *
 * Creates a self-contained game session for testing with deterministic
 * time, seeded RNG, and simulated players. No real WS connections or
 * persistence — everything runs in-memory.
 *
 * See spec §30.1 for the API contract.
 */
import { type MutablePhaseState, createPhaseState } from '../lib/phases';
import { createInMemoryReplayStore } from '../lib/replay';
import { createSeededRng } from '../lib/rng';
import {
  type MutableScoreState,
  computeLeaderboard,
  createScoreState,
  getScore,
} from '../lib/scoring';
import { type MutableTimerState, createTimerState } from '../lib/timers';
import { type MutableTurnState, createTurnState } from '../lib/turns';
import type { ReplayStore } from '../types/adapters';
import type {
  GameDefinition,
  GamePlayerState,
  InputAck,
  ReplayEntry,
  WinResult,
} from '../types/models';
import type { SimulatedPlayer } from './simulatedPlayer';
import type { MockClock } from './timeControl';
import { createMockClock } from './timeControl';

/** Player input for creating a test harness. */
export interface TestPlayerInput {
  userId: string;
  displayName: string;
}

/** Configuration for a test harness. */
export interface TestHarnessConfig {
  /** The game definition to test. */
  game: GameDefinition;
  /** Initial rules (applied over defaults). */
  rules?: Record<string, unknown>;
  /** Players to join the session. */
  players: TestPlayerInput[];
  /** Fixed RNG seed. Default: 12345. */
  seed?: number;
}

/**
 * Test harness for game engine testing.
 *
 * Provides a self-contained game session with deterministic time,
 * seeded RNG, in-memory storage, and simulated player support.
 */
export class TestGameHarness {
  readonly gameDef: GameDefinition;
  readonly sessionId: string;
  readonly clock: MockClock;
  readonly replayStore: ReplayStore;

  /** Current phase name. */
  get phase(): string | null {
    return this.phaseState.currentPhase;
  }

  /** Current sub-phase name. */
  get subPhase(): string | null {
    return this.phaseState.currentSubPhase;
  }

  /** Current game state. */
  gameState: Record<string, unknown>;

  /** Private state per player. */
  private readonly privateState: Map<string, unknown>;

  /** All players in the session. */
  private readonly playerMap: Map<string, GamePlayerState>;

  /** Simulated player bots. */
  private readonly bots: Map<string, SimulatedPlayer>;

  /** Published messages (for assertion). */
  readonly publishedMessages: Array<{ room: string; message: unknown }>;

  /** Whether the game has started. */
  private started: boolean;

  /** Win result if the game has ended. */
  private winResult: WinResult | null;

  // Internal state
  private readonly phaseState: MutablePhaseState;
  private readonly turnState: MutableTurnState;
  private readonly scoreState: MutableScoreState;
  private readonly timerState: MutableTimerState;
  private readonly rules: Readonly<Record<string, unknown>>;
  private readonly rng: ReturnType<typeof createSeededRng>;
  private currentRound: number;

  constructor(config: TestHarnessConfig) {
    this.gameDef = config.game;
    this.sessionId = `test_${Date.now()}`;
    this.clock = createMockClock(Date.now());
    this.replayStore = createInMemoryReplayStore();
    this.gameState = {};
    this.privateState = new Map();
    this.playerMap = new Map();
    this.bots = new Map();
    this.publishedMessages = [];
    this.started = false;
    this.winResult = null;
    this.currentRound = 1;

    // Resolve rules
    const rulesSchema = config.game.rules;
    const parsedRules = rulesSchema.safeParse(config.rules ?? {});
    this.rules = Object.freeze(
      parsedRules.success ? parsedRules.data : (config.rules ?? {}),
    ) as Readonly<Record<string, unknown>>;

    // Create players
    const playerIds: string[] = [];
    for (let i = 0; i < config.players.length; i++) {
      const p = config.players[i];
      playerIds.push(p.userId);
      this.playerMap.set(p.userId, {
        userId: p.userId,
        displayName: p.displayName,
        role: null,
        team: null,
        playerState: config.game.initialPlayerState,
        score: 0,
        connected: true,
        isHost: i === 0,
        isSpectator: false,
        joinOrder: i + 1,
      });
    }

    // Init state
    this.phaseState = createPhaseState();
    this.turnState = createTurnState(playerIds);
    this.scoreState = createScoreState();
    this.timerState = createTimerState();
    this.rng = createSeededRng(config.seed ?? 12345);
  }

  /** Get all players. */
  getPlayers(): readonly GamePlayerState[] {
    return [...this.playerMap.values()];
  }

  /** Get a specific player. */
  getPlayer(userId: string): GamePlayerState {
    const p = this.playerMap.get(userId);
    if (!p) throw new Error(`Player ${userId} not found`);
    return p;
  }

  /** Get private state for a player. */
  getPrivateState(userId: string): unknown {
    return this.privateState.get(userId) ?? null;
  }

  /** Get the leaderboard. */
  get leaderboard(): Array<{ userId: string; score: number; rank: number }> {
    return computeLeaderboard(this.scoreState);
  }

  /** Get a player's score. */
  getScore(userId: string): number {
    return getScore(this.scoreState, userId);
  }

  /** Get the win result (null if game not ended). */
  getWinResult(): WinResult | null {
    return this.winResult;
  }

  /** Start the game. */
  start(): void {
    if (this.started) throw new Error('Game already started');
    this.started = true;

    // Enter first phase
    const phaseNames = Object.keys(this.gameDef.phases);
    if (phaseNames.length > 0) {
      this.phaseState.currentPhase = phaseNames[0];
    }
  }

  /**
   * Submit input as a specific player.
   *
   * @returns An InputAck indicating acceptance or rejection.
   */
  submitAs(userId: string, channel: string, data: unknown): InputAck {
    if (!this.started) {
      return { accepted: false, code: 'SESSION_NOT_PLAYING', reason: 'Game not started' };
    }

    const player = this.playerMap.get(userId);
    if (!player) {
      return { accepted: false, code: 'PLAYER_NOT_IN_SESSION', reason: 'Player not found' };
    }

    // For testing, we accept all inputs and record them
    this.publishedMessages.push({
      room: `sessions:${this.sessionId}:session`,
      message: {
        type: 'game:channel.input',
        sessionId: this.sessionId,
        channel,
        userId,
        data,
        timestamp: this.clock.now(),
      },
    });

    return { accepted: true };
  }

  /** Advance time by milliseconds, firing timers. */
  advanceTime(ms: number): void {
    this.clock.advance(ms);
  }

  /** Advance by N ticks (for game loop testing). */
  advanceTicks(count: number): void {
    if (!this.gameDef.loop) return;
    const tickInterval = 1000 / this.gameDef.loop.tickRate;
    for (let i = 0; i < count; i++) {
      this.clock.advance(tickInterval);
    }
  }

  /** Run until a specific phase is entered. */
  runUntilPhase(phase: string, maxIterations?: number): void {
    const max = maxIterations ?? 1000;
    for (let i = 0; i < max; i++) {
      if (this.phaseState.currentPhase === phase) return;
      this.clock.advance(100);
    }
    throw new Error(`Phase '${phase}' not reached after ${max} iterations`);
  }

  /** Run until a specific event is published. */
  runUntilEvent(eventType: string, maxIterations?: number): void {
    const max = maxIterations ?? 1000;
    const startLen = this.publishedMessages.length;
    for (let i = 0; i < max; i++) {
      for (let j = startLen; j < this.publishedMessages.length; j++) {
        const msg = this.publishedMessages[j].message as Record<string, unknown>;
        if (msg.type === eventType) return;
      }
      this.clock.advance(100);
    }
    throw new Error(`Event '${eventType}' not received after ${max} iterations`);
  }

  /** Run the entire game to completion (requires bot strategies). */
  runToCompletion(maxIterations?: number): WinResult | null {
    const max = maxIterations ?? 10000;
    for (let i = 0; i < max; i++) {
      if (this.winResult) return this.winResult;
      this.clock.advance(100);
    }
    return this.winResult;
  }

  /** Simulate a player disconnect. */
  disconnect(userId: string): void {
    const player = this.playerMap.get(userId);
    if (!player) throw new Error(`Player ${userId} not found`);

    this.playerMap.set(userId, { ...player, connected: false });
    this.publishedMessages.push({
      room: `sessions:${this.sessionId}:session`,
      message: {
        type: 'game:player.disconnected',
        sessionId: this.sessionId,
        userId,
      },
    });
  }

  /** Simulate a player reconnect. */
  reconnect(userId: string): void {
    const player = this.playerMap.get(userId);
    if (!player) throw new Error(`Player ${userId} not found`);

    this.playerMap.set(userId, { ...player, connected: true });
    this.publishedMessages.push({
      room: `sessions:${this.sessionId}:session`,
      message: {
        type: 'game:player.reconnected',
        sessionId: this.sessionId,
        userId,
      },
    });
  }

  /** Add a simulated player bot. */
  addPlayer(bot: SimulatedPlayer): void {
    this.bots.set(bot.userId, bot);
    this.playerMap.set(bot.userId, {
      userId: bot.userId,
      displayName: bot.displayName,
      role: null,
      team: null,
      playerState: this.gameDef.initialPlayerState,
      score: 0,
      connected: true,
      isHost: false,
      isSpectator: false,
      joinOrder: this.playerMap.size + 1,
    });
  }

  /** Get the replay log. */
  async getReplayLog(): Promise<ReplayEntry[]> {
    const result = await this.replayStore.getReplayEntries(this.sessionId, 0, 10000);
    return result.entries;
  }

  /** End the game with a result. */
  endGame(result: WinResult): void {
    this.winResult = result;
  }
}

/**
 * Create a test harness for game testing.
 *
 * @example
 * ```ts
 * const harness = createTestHarness({
 *   game: myGameDefinition,
 *   rules: { rounds: 3 },
 *   players: [
 *     { userId: 'alice', displayName: 'Alice' },
 *     { userId: 'bob', displayName: 'Bob' },
 *   ],
 * });
 * await harness.start();
 * ```
 */
export function createTestHarness(config: TestHarnessConfig): TestGameHarness {
  return new TestGameHarness(config);
}
