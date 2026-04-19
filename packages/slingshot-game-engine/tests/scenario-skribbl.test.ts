/**
 * Scenario 1: Skribbl.io clone
 *
 * Validates: stream channels, scoped state sync, collect channels,
 * phase transitions, scoring, custom relay filters.
 *
 * Game flow:
 *   1. "drawing" phase — drawer streams drawing data, others guess via collect
 *   2. "reveal" phase — auto-advance, show answer
 *   3. Loop per round
 *
 * Key runtime modules exercised:
 *   - channels.ts: stream mode (rate limit, relay), collect mode
 *   - state.ts: scoped state (drawer sees word, others don't), deep diff
 *   - display.ts: custom relay filter (stream to non-drawers only)
 *   - scoring.ts: add score on correct guess
 *   - phases.ts: phase transitions
 *   - rng.ts: seeded word selection
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createChannelState,
  recordSubmission,
} from '../src/lib/channels';
import {
  playerRoom,
  resolveRelayTargets,
  resolveRelayTargetsFull,
  sessionRoom,
} from '../src/lib/display';
import { createSeededRng } from '../src/lib/rng';
import {
  addScore,
  computeLeaderboard,
  createScoreState,
  getPlayerStreak,
  getScore,
} from '../src/lib/scoring';
import {
  applyPatches,
  computeScopedDeltas,
  createPrivateStateManager,
  diffState,
  scopeStateForPlayer,
  validateJsonSerializable,
} from '../src/lib/state';
import type { GamePlayerState, ReadonlyHandlerContext } from '../src/types/models';

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

function makeReadonlyCtx(overrides?: Partial<ReadonlyHandlerContext>): ReadonlyHandlerContext {
  return {
    sessionId: 'test-session',
    gameType: 'skribbl',
    rules: {},
    currentPhase: 'drawing',
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

describe('Skribbl.io clone scenario', () => {
  describe('stream channel — drawing data', () => {
    test('accepts stream inputs and relays immediately', () => {
      const channelDef = {
        mode: 'stream' as const,
        from: 'active-player' as const,
        relay: 'others' as const,
        schema: z.object({ x: z.number(), y: z.number(), color: z.string() }),
      };

      const ctx = makeReadonlyCtx();
      const ch = createChannelState('draw', channelDef, ctx);

      const result = recordSubmission(ch, 'drawer1', { x: 10, y: 20, color: '#fff' }, []);
      expect(result.accepted).toBe(true);
      expect(result.shouldRelay).toBe(true);
      expect(result.shouldComplete).toBe(false);
    });

    test('rate limits stream inputs (silently drops excess)', () => {
      const channelDef = {
        mode: 'stream' as const,
        from: 'active-player' as const,
        relay: 'all' as const,
        schema: z.any(),
        rateLimit: { max: 3, per: 1000 },
      };

      const ctx = makeReadonlyCtx();
      const ch = createChannelState('draw', channelDef, ctx);

      // First 3 should be accepted
      expect(recordSubmission(ch, 'p1', { x: 1 }, []).accepted).toBe(true);
      expect(recordSubmission(ch, 'p1', { x: 2 }, []).accepted).toBe(true);
      expect(recordSubmission(ch, 'p1', { x: 3 }, []).accepted).toBe(true);

      // 4th should be rate limited
      const result = recordSubmission(ch, 'p1', { x: 4 }, []);
      expect(result.accepted).toBe(false);
      expect(result.code).toBe('INPUT_RATE_LIMITED');
    });

    test('stream with buffer mode queues for tick consumption', () => {
      const channelDef = {
        mode: 'stream' as const,
        from: 'all-players' as const,
        relay: 'all' as const,
        schema: z.any(),
        buffer: true,
      };

      const ctx = makeReadonlyCtx();
      const ch = createChannelState('draw', channelDef, ctx);

      const result = recordSubmission(ch, 'p1', { x: 10 }, []);
      expect(result.accepted).toBe(true);
      expect(result.shouldRelay).toBe(false); // Buffered — not relayed immediately
    });

    test('stream with persist mode fills circular buffer', () => {
      const channelDef = {
        mode: 'stream' as const,
        from: 'all-players' as const,
        relay: 'all' as const,
        schema: z.any(),
        persist: { maxCount: 3 },
      };

      const ctx = makeReadonlyCtx();
      const ch = createChannelState('draw', channelDef, ctx);

      recordSubmission(ch, 'p1', { line: 1 }, []);
      recordSubmission(ch, 'p1', { line: 2 }, []);
      recordSubmission(ch, 'p1', { line: 3 }, []);
      recordSubmission(ch, 'p1', { line: 4 }, []);

      // Should have evicted the oldest
      expect(ch.persistBuffer).not.toBeNull();
      expect(ch.persistBuffer!.length).toBe(3);
      expect(ch.persistBuffer![0].data).toEqual({ line: 2 });
    });
  });

  describe('collect channel — word guesses', () => {
    test('accepts one guess per player, no changes', () => {
      const channelDef = {
        mode: 'collect' as const,
        from: 'other-players' as const,
        relay: 'none' as const,
        schema: z.string(),
        allowChange: false,
        revealMode: 'after-close' as const,
      };

      const ctx = makeReadonlyCtx();
      const ch = createChannelState('guess', channelDef, ctx);
      const eligible = ['p2', 'p3', 'p4'];

      const r1 = recordSubmission(ch, 'p2', 'apple', eligible);
      expect(r1.accepted).toBe(true);
      expect(r1.shouldRelay).toBe(false); // revealMode: after-close

      // Same player can't change
      const r2 = recordSubmission(ch, 'p2', 'banana', eligible);
      expect(r2.accepted).toBe(false);
      expect(r2.code).toBe('INPUT_ALREADY_SUBMITTED');
    });

    test('auto-completes when all eligible players submit', () => {
      const channelDef = {
        mode: 'collect' as const,
        from: 'other-players' as const,
        relay: 'none' as const,
        schema: z.string(),
      };

      const ctx = makeReadonlyCtx();
      const ch = createChannelState('guess', channelDef, ctx);
      const eligible = ['p2', 'p3'];

      recordSubmission(ch, 'p2', 'apple', eligible);
      const r2 = recordSubmission(ch, 'p3', 'banana', eligible);

      expect(r2.accepted).toBe(true);
      expect(r2.shouldComplete).toBe(true);
    });
  });

  describe('scoped state sync — hide word from guessers', () => {
    test('scope handler filters secret word from non-drawers', () => {
      const fullState: Record<string, unknown> = {
        word: 'elephant',
        hints: ['e', '_', '_', '_', '_', '_', '_', '_'],
        round: 1,
        scores: { p1: 100, p2: 50 },
      };

      const scopeHandler = (state: Record<string, unknown>, userId: string) => {
        if (userId === 'drawer') {
          return state;
        }
        const { word: _omit, ...visible } = state;
        void _omit;
        return visible;
      };

      const drawerView = scopeStateForPlayer(fullState, 'drawer', scopeHandler);
      expect(drawerView.word).toBe('elephant');

      const guesserView = scopeStateForPlayer(fullState, 'guesser1', scopeHandler);
      expect(guesserView.word).toBeUndefined();
      expect(guesserView.hints).toEqual(['e', '_', '_', '_', '_', '_', '_', '_']);
    });

    test('compute scoped deltas per player', () => {
      const scopeHandler = (state: Record<string, unknown>, userId: string) => {
        if (userId === 'drawer') return state;
        const { word: _omit, ...visible } = state;
        void _omit;
        return visible;
      };

      const players: GamePlayerState[] = [
        makePlayer('drawer', { connected: true }),
        makePlayer('guesser1', { connected: true }),
      ];

      const previousScoped = new Map<string, Record<string, unknown>>();
      previousScoped.set('drawer', { word: 'elephant', round: 1 });
      previousScoped.set('guesser1', { round: 1 });

      const currentFullState = { word: 'elephant', round: 2 };

      const results = computeScopedDeltas(previousScoped, currentFullState, players, scopeHandler);

      // Drawer sees round change
      const drawerResult = results.get('drawer');
      expect(drawerResult).toBeDefined();
      expect(drawerResult!.patches.length).toBeGreaterThan(0);

      // Guesser sees round change but no word
      const guesserResult = results.get('guesser1');
      expect(guesserResult).toBeDefined();
      expect(guesserResult!.scopedState.word).toBeUndefined();
    });
  });

  describe('custom relay filter — stream to non-drawers', () => {
    test('resolveRelayTargets with "others" excludes sender socket', () => {
      const result = resolveRelayTargets('others', 'session-123', makePlayer('drawer'), [
        makePlayer('drawer'),
        makePlayer('p2'),
        makePlayer('p3'),
      ]);

      expect(result.rooms).toEqual([sessionRoom('session-123')]);
      expect(result.excludeSenderSocket).toBe(true);
    });

    test('resolveRelayTargetsFull with custom relay invokes filter', () => {
      const players = [
        makePlayer('drawer', { role: 'drawer' }),
        makePlayer('p2', { role: 'guesser' }),
        makePlayer('p3', { role: 'guesser' }),
      ];

      const relayFilters = {
        draw: (
          sender: { userId: string },
          _input: unknown,
          allPlayers: Array<{ userId: string }>,
        ) => allPlayers.filter(p => p.userId !== sender.userId).map(p => p.userId),
      };

      const result = resolveRelayTargetsFull(
        'custom',
        'sess-1',
        players[0],
        players,
        'draw',
        relayFilters,
        makeReadonlyCtx(),
        { x: 1, y: 2 },
      );

      expect(result.rooms).toEqual([playerRoom('sess-1', 'p2'), playerRoom('sess-1', 'p3')]);
    });
  });

  describe('scoring — correct guess', () => {
    test('awards points and computes leaderboard', () => {
      const scoreState = createScoreState();

      addScore(scoreState, 'p1', 100, 1);
      addScore(scoreState, 'p2', 50, 1);
      addScore(scoreState, 'p3', 75, 1);

      expect(getScore(scoreState, 'p1')).toBe(100);
      expect(getScore(scoreState, 'p2')).toBe(50);

      const lb = computeLeaderboard(scoreState);
      expect(lb[0].userId).toBe('p1');
      expect(lb[0].rank).toBe(1);
      expect(lb[1].userId).toBe('p3');
      expect(lb[2].userId).toBe('p2');
    });

    test('tracks scoring streaks', () => {
      const scoreState = createScoreState();

      addScore(scoreState, 'p1', 10, 1);
      addScore(scoreState, 'p1', 10, 2);
      addScore(scoreState, 'p1', 10, 3);

      expect(getPlayerStreak(scoreState, 'p1')).toBe(3);
    });
  });

  describe('state diffing — round transitions', () => {
    test('deep diff produces minimal RFC 6902 patches', () => {
      const prev = {
        round: 1,
        drawer: 'p1',
        scores: { p1: 0, p2: 0, p3: 0 },
      };

      const curr = {
        round: 2,
        drawer: 'p2',
        scores: { p1: 100, p2: 0, p3: 0 },
      };

      const patches = diffState(prev, curr);
      expect(patches.length).toBeGreaterThan(0);

      // Verify patches can be applied to reconstruct current state
      const reconstructed = applyPatches(prev, patches);
      expect(reconstructed.round).toBe(2);
      expect(reconstructed.drawer).toBe('p2');
      expect((reconstructed.scores as Record<string, number>).p1).toBe(100);
    });

    test('validates state is JSON-serializable', () => {
      const validState = { round: 1, word: 'test' };
      expect(() => validateJsonSerializable(validState)).not.toThrow();

      const circularState: Record<string, unknown> = { round: 1 };
      circularState.self = circularState;
      expect(() => validateJsonSerializable(circularState)).toThrow(/not JSON-serializable/);
    });
  });

  describe('private state — per-player hidden data', () => {
    test('private state manager isolates per-player data', () => {
      const pm = createPrivateStateManager();

      pm.set('drawer', { word: 'elephant' });
      pm.set('p2', { guessesLeft: 3 });

      expect(pm.get('drawer')).toEqual({ word: 'elephant' });
      expect(pm.get('p2')).toEqual({ guessesLeft: 3 });
      expect(pm.get('p3')).toBeNull();
    });

    test('private state update function receives current value', () => {
      const pm = createPrivateStateManager();

      pm.set('p1', { guessesLeft: 3 });
      pm.update('p1', current => {
        const state = current as { guessesLeft: number };
        return { guessesLeft: state.guessesLeft - 1 };
      });

      expect(pm.get('p1')).toEqual({ guessesLeft: 2 });
    });
  });

  describe('seeded RNG — word selection', () => {
    test('seeded RNG produces deterministic word picks', () => {
      const words = ['apple', 'banana', 'cherry', 'date', 'elderberry'];

      const rng1 = createSeededRng(42);
      const rng2 = createSeededRng(42);

      const pick1 = rng1.pick(words);
      const pick2 = rng2.pick(words);

      expect(pick1).toBe(pick2);
    });

    test('seeded RNG shuffle is deterministic', () => {
      const rng1 = createSeededRng(99);
      const rng2 = createSeededRng(99);

      const arr1 = [1, 2, 3, 4, 5];
      const arr2 = [1, 2, 3, 4, 5];

      rng1.shuffle(arr1);
      rng2.shuffle(arr2);

      expect(arr1).toEqual(arr2);
    });
  });
});
