/**
 * Scenario 4: Mario Party-style board game
 *
 * Validates: lifecycle hooks, content providers, turn management,
 * phase sub-phases, vote channels, race channels, replay log,
 * nested child sessions (mini-games), presets/rules.
 *
 * Game flow:
 *   1. "board" phase — sequential turns (roll, move, event)
 *   2. "minigame" phase — nested child session
 *   3. "shop" phase — collect channel for purchases
 *   4. Loop until N rounds complete
 *
 * Key runtime modules exercised:
 *   - hooks.ts: lifecycle hook dispatcher
 *   - content.ts: content providers for board/minigame data
 *   - turns.ts: turn order, skip, reverse, insert
 *   - phases.ts: sub-phases, conditional next
 *   - channels.ts: vote and race modes
 *   - childSessions.ts: nested session lifecycle
 *   - rules.ts: presets and rule resolution
 *   - replay.ts: typed instrumentation helpers
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  computeVoteTally,
  createChannelState,
  recordSubmission,
} from '../src/lib/channels';
import {
  completeChildSession,
  createChildSessionState,
  getActiveChildSessions,
  getChildSessionResult,
  registerChildSession,
} from '../src/lib/childSessions';
import {
  createHookErrorHandler,
  invokeOnAllPlayersDisconnected,
  invokeOnGameEnd,
  invokeOnGameStart,
  invokeOnInput,
  invokeOnPhaseEnter,
  invokeOnSessionCreated,
  invokeOnTurnEnd,
  invokeOnTurnStart,
} from '../src/lib/hooks';
import {
  areAllChannelsComplete,
  getNextSubPhase,
  getSubPhaseOrder,
  isAnyChannelComplete,
  isConditionalNext,
  resolveDelay,
  resolveNextPhase,
  resolveTimeout,
} from '../src/lib/phases';
import {
  buildReplayEntries,
  createReplaySequence,
  logChannelClosed,
  logChannelOpened,
  logChannelVoteTally,
  logPhaseEntered,
  logPhaseExited,
  logSessionCompleted,
  logSessionCreated,
  logTurnAdvanced,
} from '../src/lib/replay';
import { createSeededRng } from '../src/lib/rng';
import { extractRulesDefaults, mergeRules, resolveRules } from '../src/lib/rules';
import {
  type MutableTurnState,
  advanceTurn,
  completeTurnCycle,
  createTurnState,
  freezeTurnState,
  getActedPlayers,
  getRemainingPlayers,
  insertNextPlayer,
  reverseTurnOrder,
  rotateTurnStart,
  setActivePlayer,
  skipNextPlayer,
  skipPlayer,
} from '../src/lib/turns';
import type {
  GameDefinition,
  GameLifecycleHooks,
  GamePlayerState,
  ProcessHandlerContext,
  ReadonlyHandlerContext,
  WinResult,
} from '../src/types/models';

// ── Helpers ──────────────────────────────────────────────────────

function makePlayer(userId: string, overrides?: Partial<GamePlayerState>): GamePlayerState {
  return {
    userId,
    displayName: userId,
    role: null,
    team: null,
    playerState: null,
    score: 0,
    connected: true,
    isHost: false,
    isSpectator: false,
    joinOrder: 1,
    ...overrides,
  };
}

function makeMockCtx(overrides?: Partial<ProcessHandlerContext>): ProcessHandlerContext {
  const base: ProcessHandlerContext = {
    sessionId: 'mario-test',
    gameType: 'mario-party',
    rules: { rounds: 5, boardSize: 40 },
    currentPhase: 'board',
    currentSubPhase: null,
    currentRound: 1,
    gameState: {},
    getPrivateState: () => null,
    setPrivateState: () => {},
    updatePrivateState: () => {},
    getPlayer: () => makePlayer('p1'),
    getPlayers: () => [makePlayer('p1'), makePlayer('p2')],
    getPlayersByRole: () => [],
    getPlayersByTeam: () => [],
    getPlayersByState: () => [],
    getConnectedPlayers: () => [makePlayer('p1'), makePlayer('p2')],
    getDisconnectedPlayers: () => [],
    setPlayerState: () => {},
    setPlayerStates: () => {},
    getActivePlayer: () => 'p1',
    getTurnOrder: () => ['p1', 'p2'],
    setTurnOrder: () => {},
    setActivePlayer: () => {},
    reverseTurnOrder: () => {},
    skipNextPlayer: () => {},
    skipPlayer: () => {},
    insertNextPlayer: () => {},
    rotateTurnStart: () => {},
    completeTurnCycle: () => {},
    getActedCount: () => 0,
    getActedPlayers: () => [],
    getRemainingPlayers: () => [],
    addScore: () => {},
    setScore: () => {},
    getScore: () => 0,
    getLeaderboard: () => [],
    getTeamScores: () => [],
    getPlayerStreak: () => 0,
    advancePhase: () => {},
    setNextPhase: () => {},
    setCurrentRound: () => {},
    incrementRound: () => {},
    closeChannel: () => {},
    getChannelState: () => ({
      name: '',
      mode: 'collect' as const,
      open: false,
      startedAt: 0,
      endsAt: null,
      submissions: new Map(),
      claimedBy: [],
      complete: false,
    }),
    getChannelInputs: () => new Map(),
    extendTimer: () => {},
    resetTimer: () => {},
    getTimeRemaining: () => 0,
    getPhaseEndsAt: () => 0,
    random: createSeededRng(42),
    scheduleEvent: () => '',
    cancelScheduledEvent: () => false,
    getScheduledEvents: () => [],
    consumeBufferedInputs: () => [],
    consumeScheduledEvents: () => [],
    broadcastState: () => {},
    broadcastTo: () => {},
    sendToPlayer: () => {},
    createChildSession: async () => ({ sessionId: 'child-1' }),
    getChildSessionResult: async () => null,
    endGame: () => {},
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  return { ...base, ...overrides };
}

function makeReadonlyCtx(overrides?: Partial<ReadonlyHandlerContext>): ReadonlyHandlerContext {
  return {
    sessionId: 'mario-test',
    gameType: 'mario-party',
    rules: {},
    currentPhase: 'board',
    currentSubPhase: null,
    currentRound: 1,
    gameState: {},
    getPrivateState: () => null,
    getPlayer: () => makePlayer('p1'),
    getPlayers: () => [],
    getPlayersByRole: () => [],
    getPlayersByTeam: () => [],
    getPlayersByState: () => [],
    getConnectedPlayers: () => [],
    getDisconnectedPlayers: () => [],
    getActivePlayer: () => null,
    getTurnOrder: () => [],
    getActedCount: () => 0,
    getActedPlayers: () => [],
    getRemainingPlayers: () => [],
    getScore: () => 0,
    getLeaderboard: () => [],
    getTeamScores: () => [],
    getPlayerStreak: () => 0,
    getChannelState: () => ({
      name: '',
      mode: 'collect' as const,
      open: false,
      startedAt: 0,
      endsAt: null,
      submissions: new Map(),
      claimedBy: [],
      complete: false,
    }),
    getChannelInputs: () => new Map(),
    getTimeRemaining: () => 0,
    getPhaseEndsAt: () => 0,
    random: createSeededRng(42),
    getScheduledEvents: () => [],
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('Mario Party-style scenario', () => {
  describe('lifecycle hooks dispatcher', () => {
    test('invokes onSessionCreated hook', async () => {
      let called = false;
      const hooks: GameLifecycleHooks = {
        onSessionCreated: async () => {
          called = true;
        },
      };

      await invokeOnSessionCreated(hooks, makeMockCtx(), () => {});
      expect(called).toBe(true);
    });

    test('onGameStart can cancel the start', async () => {
      const hooks: GameLifecycleHooks = {
        onGameStart: async () => ({ cancel: true, reason: 'Not enough stars' }),
      };

      const result = await invokeOnGameStart(hooks, makeMockCtx(), () => {});
      expect(result.cancelled).toBe(true);
      expect(result.reason).toBe('Not enough stars');
    });

    test('onGameStart returns non-cancelled by default', async () => {
      const hooks: GameLifecycleHooks = {
        onGameStart: async () => undefined,
      };

      const result = await invokeOnGameStart(hooks, makeMockCtx(), () => {});
      expect(result.cancelled).toBe(false);
    });

    test('skips when hook is not defined', async () => {
      const hooks: GameLifecycleHooks = {};

      await invokeOnSessionCreated(hooks, makeMockCtx(), () => {});
      const result = await invokeOnGameStart(hooks, makeMockCtx(), () => {});
      expect(result.cancelled).toBe(false);
    });

    test('catches and logs hook errors without propagating', async () => {
      const errors: unknown[] = [];
      const hooks: GameLifecycleHooks = {
        onPhaseEnter: async () => {
          throw new Error('hook failed');
        },
      };

      await invokeOnPhaseEnter(hooks, makeMockCtx(), 'board', (_hook, err) => {
        errors.push(err);
      });

      expect(errors.length).toBe(1);
      expect((errors[0] as Error).message).toBe('hook failed');
    });

    test('onGameEnd receives win result', async () => {
      let receivedResult: WinResult | null = null;
      const hooks: GameLifecycleHooks = {
        onGameEnd: async (ctx, result) => {
          receivedResult = result;
        },
      };

      const winResult: WinResult = {
        winners: ['p1'],
        reason: 'Most stars',
        rankings: [
          { userId: 'p1', rank: 1, score: 5 },
          { userId: 'p2', rank: 2, score: 3 },
        ],
      };

      await invokeOnGameEnd(hooks, makeMockCtx(), winResult, () => {});
      expect(receivedResult).toEqual(winResult);
    });

    test('onTurnStart and onTurnEnd receive userId', async () => {
      const events: string[] = [];
      const hooks: GameLifecycleHooks = {
        onTurnStart: async (_ctx, userId) => {
          events.push(`start:${userId}`);
        },
        onTurnEnd: async (_ctx, userId) => {
          events.push(`end:${userId}`);
        },
      };

      await invokeOnTurnStart(hooks, makeMockCtx(), 'p1', () => {});
      await invokeOnTurnEnd(hooks, makeMockCtx(), 'p1', () => {});
      await invokeOnTurnStart(hooks, makeMockCtx(), 'p2', () => {});

      expect(events).toEqual(['start:p1', 'end:p1', 'start:p2']);
    });

    test('onInput receives channel, userId, and data', async () => {
      let received: { channel: string; userId: string; data: unknown } | null = null;
      const hooks: GameLifecycleHooks = {
        onInput: async (_ctx, channel, userId, data) => {
          received = { channel, userId, data };
        },
      };

      await invokeOnInput(hooks, makeMockCtx(), 'roll', 'p1', { value: 6 }, () => {});
      expect(received).toEqual({ channel: 'roll', userId: 'p1', data: { value: 6 } });
    });

    test('onAllPlayersDisconnected defaults to abandon', async () => {
      const hooks: GameLifecycleHooks = {};
      const result = await invokeOnAllPlayersDisconnected(hooks, makeMockCtx(), () => {});
      expect(result.abandon).toBe(true);
    });

    test('onAllPlayersDisconnected can prevent abandonment', async () => {
      const hooks: GameLifecycleHooks = {
        onAllPlayersDisconnected: async () => ({ abandon: false }),
      };
      const result = await invokeOnAllPlayersDisconnected(hooks, makeMockCtx(), () => {});
      expect(result.abandon).toBe(false);
    });

    test('createHookErrorHandler logs with session context', () => {
      const logged: { message: string; data: unknown }[] = [];
      const log = {
        error: (msg: string, data?: unknown) => {
          logged.push({ message: msg, data });
        },
      };

      const handler = createHookErrorHandler('sess-1', log);
      handler('onPhaseEnter', new Error('test error'));

      expect(logged.length).toBe(1);
      expect(logged[0].message).toContain('onPhaseEnter');
      expect(logged[0].message).toContain('sess-1');
    });
  });

  describe('turn management — board game turns', () => {
    /** Helper: createTurnState returns TurnState (readonly), but mutation functions need MutableTurnState. */
    function mutableTurnState(playerIds: string[]): MutableTurnState {
      return createTurnState(playerIds) as unknown as MutableTurnState;
    }

    test('sequential turns through all players', () => {
      const state = mutableTurnState(['p1', 'p2', 'p3', 'p4']);

      expect(state.activePlayer).toBe('p1');

      advanceTurn(state);
      expect(state.activePlayer).toBe('p2');

      advanceTurn(state);
      expect(state.activePlayer).toBe('p3');

      advanceTurn(state);
      expect(state.activePlayer).toBe('p4');

      advanceTurn(state);
      expect(state.activePlayer).toBe('p1'); // Wraps around
    });

    test('skip next player', () => {
      const state = mutableTurnState(['p1', 'p2', 'p3']);
      expect(state.activePlayer).toBe('p1');

      skipNextPlayer(state);
      advanceTurn(state);
      expect(state.activePlayer).toBe('p3'); // p2 skipped
    });

    test('skip specific player marks them as acted', () => {
      const state = mutableTurnState(['p1', 'p2', 'p3']);

      skipPlayer(state, 'p2');
      // p2 is now in the acted set — treated as if they already took their turn
      expect(getActedPlayers(state)).toContain('p2');
      expect(getRemainingPlayers(state)).not.toContain('p2');
    });

    test('insert player next', () => {
      const state = mutableTurnState(['p1', 'p2', 'p3']);

      insertNextPlayer(state, 'p3');
      advanceTurn(state);
      expect(state.activePlayer).toBe('p3');
    });

    test('reverse turn order', () => {
      const state = mutableTurnState(['p1', 'p2', 'p3']);
      expect(state.activePlayer).toBe('p1');

      reverseTurnOrder(state);
      advanceTurn(state);
      expect(state.activePlayer).toBe('p3'); // Reversed
    });

    test('rotate turn start', () => {
      const state = mutableTurnState(['p1', 'p2', 'p3']);

      rotateTurnStart(state);
      const frozen = freezeTurnState(state);
      expect(frozen.order[0]).toBe('p2');
    });

    test('set active player directly', () => {
      const state = mutableTurnState(['p1', 'p2', 'p3']);

      setActivePlayer(state, 'p3');
      expect(state.activePlayer).toBe('p3');
    });

    test('track acted players in a turn cycle', () => {
      const state = mutableTurnState(['p1', 'p2', 'p3']);

      // Advance through p1 → p2 (p1 is marked as acted)
      advanceTurn(state);
      expect(getActedPlayers(state)).toContain('p1');
      expect(getRemainingPlayers(state).length).toBe(2);

      // Complete the cycle to reset
      completeTurnCycle(state);
      expect(getActedPlayers(state).length).toBe(0);
      expect(getRemainingPlayers(state).length).toBe(3);
    });
  });

  describe('phase sub-phases — roll / move / event', () => {
    test('get sub-phase order', () => {
      const phaseDef = {
        next: 'minigame' as const,
        subPhases: {
          roll: { timeout: 10000 },
          move: { timeout: 5000 },
          event: { timeout: 15000 },
        },
        subPhaseOrder: ['roll', 'move', 'event'],
      };

      const order = getSubPhaseOrder(phaseDef);
      expect(order).toEqual(['roll', 'move', 'event']);
    });

    test('advance through sub-phases', () => {
      const ctx = makeReadonlyCtx();
      const phaseDef = {
        next: 'minigame' as const,
        subPhases: {
          roll: { timeout: 10000 },
          move: { timeout: 5000 },
          event: { timeout: 15000 },
        },
        subPhaseOrder: ['roll', 'move', 'event'],
      };

      const next1 = getNextSubPhase(phaseDef, -1, ctx);
      expect(next1).not.toBeNull();
      expect(next1!.name).toBe('roll');
      expect(next1!.index).toBe(0);

      const next2 = getNextSubPhase(phaseDef, 0, ctx);
      expect(next2).not.toBeNull();
      expect(next2!.name).toBe('move');

      const next3 = getNextSubPhase(phaseDef, 1, ctx);
      expect(next3).not.toBeNull();
      expect(next3!.name).toBe('event');

      const next4 = getNextSubPhase(phaseDef, 2, ctx);
      expect(next4).toBeNull(); // End of sub-phases
    });

    test('skips disabled sub-phases', () => {
      const ctx = makeReadonlyCtx();
      const phaseDef = {
        next: null,
        subPhases: {
          roll: { timeout: 10000 },
          move: { enabled: false, timeout: 5000 },
          event: { timeout: 15000 },
        },
        subPhaseOrder: ['roll', 'move', 'event'],
      };

      const next = getNextSubPhase(phaseDef, 0, ctx);
      expect(next!.name).toBe('event'); // Skipped disabled 'move'
    });

    test('conditional next phase', () => {
      const phaseDef = {
        next: 'boardContinue|minigame',
      };

      expect(isConditionalNext(phaseDef as any)).toBe(true);
    });

    test('dynamic next phase via function', () => {
      const gameDef = {
        phases: {
          board: {
            next: (ctx: ReadonlyHandlerContext) => (ctx.currentRound >= 5 ? 'final' : 'minigame'),
          },
          minigame: { next: 'board' },
          final: { next: null },
        },
      } as unknown as GameDefinition;

      const ctx3 = makeReadonlyCtx({ currentRound: 3 });
      const next3 = resolveNextPhase(gameDef, 'board', ctx3, null);
      expect(next3).toBe('minigame');

      const ctx5 = makeReadonlyCtx({ currentRound: 5 });
      const next5 = resolveNextPhase(gameDef, 'board', ctx5, null);
      expect(next5).toBe('final');
    });
  });

  describe('vote channel — minigame selection', () => {
    test('vote channel collects votes and computes tally', () => {
      const channelDef = {
        mode: 'vote' as const,
        from: 'all-players' as const,
        relay: 'none' as const,
        schema: z.string(),
        revealMode: 'after-close' as const,
      };

      const ctx = makeReadonlyCtx();
      const ch = createChannelState('vote-minigame', channelDef, ctx);
      const eligible = ['p1', 'p2', 'p3', 'p4'];

      recordSubmission(ch, 'p1', 'racing', eligible);
      recordSubmission(ch, 'p2', 'racing', eligible);
      recordSubmission(ch, 'p3', 'puzzle', eligible);
      recordSubmission(ch, 'p4', 'racing', eligible);

      const tally = computeVoteTally(ch);
      expect(tally.winner).toBe('racing');
      expect(tally.tie).toBe(false);
      expect(tally.totalVotes).toBe(4);
      expect(tally.options.get('racing')).toBe(3);
      expect(tally.options.get('puzzle')).toBe(1);
    });

    test('tie detection when votes are equal', () => {
      const channelDef = {
        mode: 'vote' as const,
        from: 'all-players' as const,
        relay: 'none' as const,
        schema: z.string(),
      };

      const ctx = makeReadonlyCtx();
      const ch = createChannelState('vote', channelDef, ctx);

      recordSubmission(ch, 'p1', 'a', ['p1', 'p2']);
      recordSubmission(ch, 'p2', 'b', ['p1', 'p2']);

      const tally = computeVoteTally(ch);
      expect(tally.tie).toBe(true);
      expect(tally.winner).toBeNull();
    });

    test('vote auto-completes when all eligible vote', () => {
      const channelDef = {
        mode: 'vote' as const,
        from: 'all-players' as const,
        relay: 'none' as const,
        schema: z.string(),
      };

      const ctx = makeReadonlyCtx();
      const ch = createChannelState('vote', channelDef, ctx);

      recordSubmission(ch, 'p1', 'a', ['p1', 'p2']);
      const r2 = recordSubmission(ch, 'p2', 'b', ['p1', 'p2']);
      expect(r2.shouldComplete).toBe(true);
    });
  });

  describe('race channel — quick-time events', () => {
    test('race channel accepts first claimer, rejects rest', () => {
      const channelDef = {
        mode: 'race' as const,
        from: 'all-players' as const,
        relay: 'all' as const,
        schema: z.any(),
        count: 1,
      };

      const ctx = makeReadonlyCtx();
      const ch = createChannelState('buzzer', channelDef, ctx);

      const r1 = recordSubmission(ch, 'p1', { buzzed: true }, []);
      expect(r1.accepted).toBe(true);
      expect(r1.shouldComplete).toBe(true);

      const r2 = recordSubmission(ch, 'p2', { buzzed: true }, []);
      expect(r2.accepted).toBe(false);
      expect(r2.code).toBe('INPUT_RACE_ALREADY_CLAIMED');
    });

    test('race with count > 1 accepts multiple claimers', () => {
      const channelDef = {
        mode: 'race' as const,
        from: 'all-players' as const,
        relay: 'all' as const,
        schema: z.any(),
        count: 2,
      };

      const ctx = makeReadonlyCtx();
      const ch = createChannelState('buzzer', channelDef, ctx);

      const r1 = recordSubmission(ch, 'p1', {}, []);
      expect(r1.accepted).toBe(true);
      expect(r1.shouldComplete).toBe(false);

      const r2 = recordSubmission(ch, 'p2', {}, []);
      expect(r2.accepted).toBe(true);
      expect(r2.shouldComplete).toBe(true);
    });
  });

  describe('nested child sessions — mini-games', () => {
    test('register and complete child session', () => {
      const state = createChildSessionState();

      const record = registerChildSession(state, 'child-1', 'racing', 'parent-1', ['p1', 'p2']);
      expect(record.sessionId).toBe('child-1');
      expect(record.gameType).toBe('racing');
      expect(record.parentSessionId).toBe('parent-1');
      expect(record.result).toBeNull();

      const result: WinResult = { winners: ['p1'], reason: 'Fastest' };
      completeChildSession(state, 'child-1', result);

      const completed = state.children.get('child-1');
      expect(completed!.result).toEqual(result);
      expect(completed!.completedAt).not.toBeNull();
    });

    test('get child session result', () => {
      const state = createChildSessionState();

      registerChildSession(state, 'child-1', 'racing', 'parent-1', ['p1', 'p2']);
      expect(getChildSessionResult(state, 'child-1')).toBeNull();

      completeChildSession(state, 'child-1', { winners: ['p2'], reason: 'Winner' });
      const result = getChildSessionResult(state, 'child-1');
      expect(result).not.toBeNull();
      expect(result!.winners).toEqual(['p2']);
    });

    test('get active child sessions', () => {
      const state = createChildSessionState();

      registerChildSession(state, 'child-1', 'racing', 'parent-1', ['p1', 'p2']);
      registerChildSession(state, 'child-2', 'puzzle', 'parent-1', ['p1', 'p2']);
      completeChildSession(state, 'child-1', { reason: 'done' });

      const active = getActiveChildSessions(state);
      expect(active.length).toBe(1);
      expect(active[0].sessionId).toBe('child-2');
    });

    test('unknown child session returns undefined', () => {
      const state = createChildSessionState();
      expect(getChildSessionResult(state, 'nonexistent')).toBeUndefined();
    });
  });

  describe('rules and presets', () => {
    test('resolve rules from schema with defaults', () => {
      const schema = z.object({
        rounds: z.number().default(10),
        boardSize: z.number().default(40),
        starCost: z.number().default(20),
      });

      const gameDef = {
        rules: schema,
        presets: {
          quick: { rounds: 3, boardSize: 20 },
        },
      } as unknown as GameDefinition;

      const resolved = resolveRules(gameDef, undefined, { rounds: 5 });
      expect(resolved.rounds).toBe(5);
      expect(resolved.boardSize).toBe(40);
      expect(resolved.starCost).toBe(20);
    });

    test('merge rules with update', () => {
      const schema = z.object({
        rounds: z.number().default(10),
        boardSize: z.number().default(40),
        starCost: z.number().default(20),
      });

      const gameDef = {
        rules: schema,
        presets: {},
      } as unknown as GameDefinition;

      const currentRules = Object.freeze({ rounds: 10, boardSize: 40, starCost: 20 });
      const merged = mergeRules(gameDef, currentRules, { starCost: 10 });
      expect(merged.rounds).toBe(10);
      expect(merged.boardSize).toBe(40);
      expect(merged.starCost).toBe(10);
    });

    test('resolve rules with preset', () => {
      const schema = z.object({
        rounds: z.number().default(10),
        boardSize: z.number().default(40),
        starCost: z.number().default(20),
      });

      const gameDef = {
        rules: schema,
        presets: {
          quick: { rounds: 3, boardSize: 20 },
        },
      } as unknown as GameDefinition;

      const resolved = resolveRules(gameDef, 'quick');
      expect(resolved.rounds).toBe(3);
      expect(resolved.boardSize).toBe(20);
      expect(resolved.starCost).toBe(20); // Default
    });

    test('extract defaults from schema', () => {
      const schema = z.object({
        rounds: z.number().default(10),
        boardSize: z.number().default(40),
      });

      const defaults = extractRulesDefaults(schema);
      expect(defaults).toBeDefined();
      expect(defaults.rounds).toBe(10);
      expect(defaults.boardSize).toBe(40);
    });
  });

  describe('phase advance triggers', () => {
    test('all channels complete trigger', () => {
      const channels = new Map([
        ['roll', { complete: true }],
        ['move', { complete: true }],
      ]);
      const activeChannels = new Set(['roll', 'move']);

      expect(areAllChannelsComplete(activeChannels, channels)).toBe(true);
    });

    test('any channel complete trigger', () => {
      const channels = new Map([
        ['buzzer', { complete: true }],
        ['timer', { complete: false }],
      ]);
      const activeChannels = new Set(['buzzer', 'timer']);

      expect(isAnyChannelComplete(activeChannels, channels)).toBe(true);
    });

    test('not complete when channels still open', () => {
      const channels = new Map([
        ['roll', { complete: false }],
        ['move', { complete: false }],
      ]);
      const activeChannels = new Set(['roll', 'move']);

      expect(areAllChannelsComplete(activeChannels, channels)).toBe(false);
      expect(isAnyChannelComplete(activeChannels, channels)).toBe(false);
    });

    test('resolve phase timeout', () => {
      const ctx = makeReadonlyCtx();

      expect(resolveTimeout({ next: null, timeout: 30_000 }, ctx)).toBe(30_000);
      expect(resolveTimeout({ next: null, timeout: () => 15_000 }, ctx)).toBe(15_000);
      expect(resolveTimeout({ next: null }, ctx)).toBeNull();
    });

    test('resolve phase delay', () => {
      const ctx = makeReadonlyCtx();

      expect(resolveDelay({ next: null, delay: 2000 }, ctx)).toBe(2000);
      expect(resolveDelay({ next: null, delay: () => 500 }, ctx)).toBe(500);
      expect(resolveDelay({ next: null }, ctx)).toBe(0);
    });
  });

  describe('replay log — full game instrumentation', () => {
    test('log a complete game flow', () => {
      const seq = createReplaySequence();
      const sessionId = 'mario-1';

      const entries = [
        logSessionCreated(sessionId, seq, {
          gameType: 'mario-party',
          hostUserId: 'p1',
          rules: { rounds: 5 },
        }),
        logPhaseEntered(sessionId, seq, {
          phase: 'board',
          timeout: 120_000,
          channels: ['roll'],
        }),
        logTurnAdvanced(sessionId, seq, {
          previousPlayer: null,
          nextPlayer: 'p1',
          turnNumber: 1,
        }),
        logChannelOpened(sessionId, seq, {
          channel: 'roll',
          mode: 'collect',
          timeout: 10_000,
        }),
        logChannelClosed(sessionId, seq, {
          channel: 'roll',
          reason: 'all-submitted',
          submissionCount: 1,
        }),
        logPhaseExited(sessionId, seq, {
          phase: 'board',
          reason: 'advance',
          duration: 45_000,
        }),
        logChannelVoteTally(sessionId, seq, {
          channel: 'vote-minigame',
          options: { racing: 3, puzzle: 1 },
          winner: 'racing',
          tie: false,
          totalVotes: 4,
        }),
        logSessionCompleted(sessionId, seq, {
          result: { type: 'win', winners: ['p1'], reason: 'Most stars' },
        }),
      ];

      // Sequences should be monotonically increasing
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i].sequence).toBe(entries[i - 1].sequence + 1);
      }

      // All entries reference the session
      for (const entry of entries) {
        expect(entry.sessionId).toBe(sessionId);
      }

      // First entry is session.created
      expect(entries[0].type).toBe('session.created');
      // Last entry is session.completed
      expect(entries[entries.length - 1].type).toBe('session.completed');
    });

    test('batch build replay entries', () => {
      const seq = createReplaySequence();
      const entries = buildReplayEntries('sess-1', seq, [
        { type: 'phase.entered', data: { phase: 'board' } },
        { type: 'turn.advanced', data: { nextPlayer: 'p1' } },
        { type: 'channel.opened', data: { channel: 'roll' } },
      ]);

      expect(entries.length).toBe(3);
      expect(entries[0].sequence).toBe(1);
      expect(entries[1].sequence).toBe(2);
      expect(entries[2].sequence).toBe(3);
    });
  });
});
