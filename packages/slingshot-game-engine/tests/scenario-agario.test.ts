/**
 * Scenario 2: Agar.io-style real-time game
 *
 * Validates: tick system, delta sync, PRNG, game loop, scheduled events,
 * input buffering, overrun recovery.
 *
 * Game flow:
 *   1. "playing" phase — continuous tick loop processes movement
 *   2. Players stream movement inputs, consumed per tick
 *   3. Delta sync broadcasts state diffs after each tick
 *   4. Scheduled events for food spawning
 *   5. Game ends when win condition met
 *
 * Key runtime modules exercised:
 *   - gameLoop.ts: tick system, overrun detection, scheduled events, input buffers
 *   - state.ts: deep diff for delta sync, JSON patch
 *   - rng.ts: seeded food spawn positions
 *   - channels.ts: stream mode with buffer:true for tick consumption
 *   - scoring.ts: mass-based scoring
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { consumeStreamBuffers, createChannelState, recordSubmission } from '../src/lib/channels';
import {
  bufferInput,
  cancelScheduledEvent,
  clearInputBuffers,
  clearScheduledEvents,
  consumeBufferedInputs,
  consumeScheduledEvents,
  createGameLoopState,
  getScheduledEvents,
  scheduleEvent,
} from '../src/lib/gameLoop';
import { createSeededRng } from '../src/lib/rng';
import {
  addScore,
  computeLeaderboard,
  createScoreState,
  getScore,
  setScore,
} from '../src/lib/scoring';
import {
  applyPatches,
  deepCloneState,
  diffState,
} from '../src/lib/state';
import type { ReadonlyHandlerContext } from '../src/types/models';

function makeReadonlyCtx(): ReadonlyHandlerContext {
  return {
    sessionId: 'agario-test',
    gameType: 'agario',
    rules: {},
    currentPhase: 'playing',
    currentSubPhase: null,
    currentRound: 1,
    gameState: {},
    getPrivateState: () => null,
    getPlayer: () => ({
      userId: 'p1',
      displayName: 'p1',
      role: null,
      team: null,
      playerState: null,
      score: 0,
      connected: true,
      isHost: false,
      isSpectator: false,
      joinOrder: 1,
    }),
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
      mode: 'stream' as const,
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
  };
}

describe('Agar.io-style scenario', () => {
  describe('game loop — tick system', () => {
    test('creates game loop state with correct initial values', () => {
      const loop = createGameLoopState(20);

      expect(loop.running).toBe(false);
      expect(loop.tickRate).toBe(20);
      expect(loop.tick).toBe(0);
      expect(loop.effectiveTickRate).toBe(20);
      expect(loop.consecutiveOverruns).toBe(0);
      expect(loop.reducedRate).toBe(false);
      expect(loop.inputBuffers.size).toBe(0);
      expect(loop.scheduledEvents.size).toBe(0);
    });

    test('supports custom max overrun threshold', () => {
      const loop = createGameLoopState(60, 10000);
      expect(loop.maxOverrunMs).toBe(10000);
    });
  });

  describe('input buffering — movement commands', () => {
    test('buffers inputs per channel', () => {
      const loop = createGameLoopState(20);

      bufferInput(loop, 'move', 'p1', { dx: 1, dy: 0 }, 1000);
      bufferInput(loop, 'move', 'p2', { dx: 0, dy: 1 }, 1001);
      bufferInput(loop, 'move', 'p1', { dx: 1, dy: 1 }, 1002);

      const consumed = consumeBufferedInputs(loop, 'move');
      expect(consumed.length).toBe(3);
      expect(consumed[0].userId).toBe('p1');
      expect(consumed[1].userId).toBe('p2');
      expect(consumed[2].userId).toBe('p1');
    });

    test('consuming clears the buffer', () => {
      const loop = createGameLoopState(20);

      bufferInput(loop, 'move', 'p1', { dx: 1 }, 1000);
      consumeBufferedInputs(loop, 'move');

      const second = consumeBufferedInputs(loop, 'move');
      expect(second.length).toBe(0);
    });

    test('buffers are independent per channel', () => {
      const loop = createGameLoopState(20);

      bufferInput(loop, 'move', 'p1', { dx: 1 }, 1000);
      bufferInput(loop, 'split', 'p1', {}, 1001);

      expect(consumeBufferedInputs(loop, 'move').length).toBe(1);
      expect(consumeBufferedInputs(loop, 'split').length).toBe(1);
      expect(consumeBufferedInputs(loop, 'eject').length).toBe(0);
    });

    test('clearInputBuffers removes all buffers', () => {
      const loop = createGameLoopState(20);

      bufferInput(loop, 'move', 'p1', {}, 1000);
      bufferInput(loop, 'split', 'p2', {}, 1001);

      clearInputBuffers(loop);

      expect(loop.inputBuffers.size).toBe(0);
    });
  });

  describe('scheduled events — food spawning', () => {
    test('schedule and consume events at correct tick', () => {
      const loop = createGameLoopState(20);
      loop.tick = 10;

      const id = scheduleEvent(loop, 5, 'spawn-food', { x: 100, y: 200 });
      expect(id).toMatch(/^evt_/);

      // Not due yet at tick 10
      expect(consumeScheduledEvents(loop).length).toBe(0);

      // Advance to tick 15 — now due
      loop.tick = 15;
      const due = consumeScheduledEvents(loop);
      expect(due.length).toBe(1);
      expect(due[0].type).toBe('spawn-food');
      expect(due[0].data).toEqual({ x: 100, y: 200 });

      // Should be removed after consumption
      expect(getScheduledEvents(loop).length).toBe(0);
    });

    test('cancel a scheduled event', () => {
      const loop = createGameLoopState(20);
      loop.tick = 0;

      const id = scheduleEvent(loop, 10, 'spawn-food', {});
      expect(cancelScheduledEvent(loop, id)).toBe(true);
      expect(cancelScheduledEvent(loop, id)).toBe(false); // Already cancelled

      loop.tick = 10;
      expect(consumeScheduledEvents(loop).length).toBe(0);
    });

    test('multiple events fire in correct order', () => {
      const loop = createGameLoopState(20);
      loop.tick = 0;

      scheduleEvent(loop, 10, 'event-b', { order: 2 });
      scheduleEvent(loop, 5, 'event-a', { order: 1 });
      scheduleEvent(loop, 10, 'event-c', { order: 3 });

      loop.tick = 5;
      const firstBatch = consumeScheduledEvents(loop);
      expect(firstBatch.length).toBe(1);
      expect(firstBatch[0].type).toBe('event-a');

      loop.tick = 10;
      const secondBatch = consumeScheduledEvents(loop);
      expect(secondBatch.length).toBe(2);
    });

    test('clearScheduledEvents removes all', () => {
      const loop = createGameLoopState(20);

      scheduleEvent(loop, 5, 'a', {});
      scheduleEvent(loop, 10, 'b', {});

      clearScheduledEvents(loop);
      expect(getScheduledEvents(loop).length).toBe(0);
    });
  });

  describe('delta sync — state diffing', () => {
    test('diff tracks player position changes', () => {
      const prev = {
        players: {
          p1: { x: 0, y: 0, mass: 10 },
          p2: { x: 100, y: 100, mass: 10 },
        },
        food: [{ x: 50, y: 50 }],
      };

      const curr = {
        players: {
          p1: { x: 5, y: 3, mass: 10 },
          p2: { x: 100, y: 100, mass: 10 },
        },
        food: [{ x: 50, y: 50 }],
      };

      const patches = diffState(prev, curr);
      expect(patches.length).toBeGreaterThan(0);

      // Only p1 changed — p2 and food should not generate patches
      const p2Patches = patches.filter(p => p.path.includes('p2'));
      expect(p2Patches.length).toBe(0);

      const foodPatches = patches.filter(p => p.path.includes('food'));
      expect(foodPatches.length).toBe(0);
    });

    test('apply patches reconstructs state', () => {
      const prev = {
        players: {
          p1: { x: 0, y: 0, mass: 10 },
        },
        tick: 1,
      };

      const curr = {
        players: {
          p1: { x: 10, y: 5, mass: 15 },
        },
        tick: 2,
      };

      const patches = diffState(prev, curr);
      const reconstructed = applyPatches(prev, patches);

      expect(reconstructed.tick).toBe(2);
      const p1 = (reconstructed.players as Record<string, unknown>).p1 as Record<string, number>;
      expect(p1.x).toBe(10);
      expect(p1.y).toBe(5);
      expect(p1.mass).toBe(15);
    });

    test('deep clone produces independent copy', () => {
      const state = { players: { p1: { x: 0 } } };
      const cloned = deepCloneState(state);

      cloned.players.p1.x = 999;
      expect(state.players.p1.x).toBe(0);
    });

    test('diff handles property additions and removals', () => {
      const prev: Record<string, unknown> = { a: 1, b: 2 };
      const curr: Record<string, unknown> = { a: 1, c: 3 };

      const patches = diffState(prev, curr);
      const addPatch = patches.find(p => p.op === 'add' && p.path === '/c');
      const removePatch = patches.find(p => p.op === 'remove' && p.path === '/b');

      expect(addPatch).toBeDefined();
      expect(removePatch).toBeDefined();
    });
  });

  describe('seeded PRNG — food spawning', () => {
    test('deterministic food spawn positions', () => {
      const rng = createSeededRng(42);

      const foods1 = Array.from({ length: 10 }, () => ({
        x: rng.int(0, 1000),
        y: rng.int(0, 1000),
      }));

      const rng2 = createSeededRng(42);
      const foods2 = Array.from({ length: 10 }, () => ({
        x: rng2.int(0, 1000),
        y: rng2.int(0, 1000),
      }));

      expect(foods1).toEqual(foods2);
    });

    test('float generates values in range', () => {
      const rng = createSeededRng(99);

      for (let i = 0; i < 100; i++) {
        const v = rng.float(0, 1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });

    test('int generates values in [min, max]', () => {
      const rng = createSeededRng(77);

      for (let i = 0; i < 100; i++) {
        const v = rng.int(5, 10);
        expect(v).toBeGreaterThanOrEqual(5);
        expect(v).toBeLessThanOrEqual(10);
      }
    });

    test('weighted selection respects probabilities', () => {
      const rng = createSeededRng(42);
      const items = [
        { value: 'common', weight: 90 },
        { value: 'rare', weight: 10 },
      ];

      const picks = Array.from({ length: 1000 }, () => rng.weighted(items));
      const commonCount = picks.filter(p => p === 'common').length;

      // With 90% weight, should get roughly 850-950 out of 1000
      expect(commonCount).toBeGreaterThan(800);
      expect(commonCount).toBeLessThan(980);
    });
  });

  describe('stream channel with buffer — tick consumption', () => {
    test('stream inputs buffered and consumed in batch', () => {
      const channelDef = {
        mode: 'stream' as const,
        from: 'all-players' as const,
        relay: 'all' as const,
        schema: z.object({ dx: z.number(), dy: z.number() }),
        buffer: true,
      };

      const ctx = makeReadonlyCtx();
      const ch = createChannelState('move', channelDef, ctx);

      // Several inputs from different players
      recordSubmission(ch, 'p1', { dx: 1, dy: 0 }, []);
      recordSubmission(ch, 'p2', { dx: 0, dy: 1 }, []);
      recordSubmission(ch, 'p1', { dx: -1, dy: 0 }, []);

      // Consume all at once (as tick handler would)
      const consumed = consumeStreamBuffers(ch);
      expect(consumed.length).toBe(3);

      // Sorted by timestamp
      for (let i = 1; i < consumed.length; i++) {
        expect(consumed[i].timestamp).toBeGreaterThanOrEqual(consumed[i - 1].timestamp);
      }

      // Buffer should be empty after consumption
      const second = consumeStreamBuffers(ch);
      expect(second.length).toBe(0);
    });
  });

  describe('scoring — mass-based', () => {
    test('set and increment score based on mass', () => {
      const scores = createScoreState();

      setScore(scores, 'p1', 10);
      addScore(scores, 'p1', 5, 1);
      expect(getScore(scores, 'p1')).toBe(15);

      addScore(scores, 'p2', 20, 1);
      expect(getScore(scores, 'p2')).toBe(20);

      const lb = computeLeaderboard(scores);
      expect(lb[0].userId).toBe('p2');
      expect(lb[1].userId).toBe('p1');
    });
  });
});
