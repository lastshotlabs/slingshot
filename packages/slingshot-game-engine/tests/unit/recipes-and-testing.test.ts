import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGame } from '../../src/defineGame';
import { buildReplayEntry, createReplaySequence } from '../../src/lib/replay';
import { blindSchedule } from '../../src/recipes/blindSchedule';
import { elimination } from '../../src/recipes/elimination';
import { gridBoard } from '../../src/recipes/gridBoard';
import { type Card, standardDeck } from '../../src/recipes/standardDeck';
import { wordValidator } from '../../src/recipes/wordValidator';
import { gameAssertions } from '../../src/testing/assertions';
import { createTestHarness } from '../../src/testing/harness';
import { SimulatedPlayer } from '../../src/testing/simulatedPlayer';
import { createMockClock } from '../../src/testing/timeControl';

function makeProcessContext() {
  const players = new Map([
    ['alice', { userId: 'alice', playerState: null, isSpectator: false, team: 'red' }],
    ['bob', { userId: 'bob', playerState: null, isSpectator: false, team: 'red' }],
    ['carol', { userId: 'carol', playerState: null, isSpectator: false, team: 'blue' }],
  ]);
  const scores = new Map([
    ['alice', 10],
    ['bob', 2],
    ['carol', 1],
  ]);

  return {
    getLeaderboard: () => [
      { userId: 'alice', score: 10, rank: 1 },
      { userId: 'bob', score: 2, rank: 2 },
      { userId: 'carol', score: 1, rank: 3 },
    ],
    getPlayer: (userId: string) => players.get(userId)!,
    getPlayers: () => [...players.values()],
    getScore: (userId: string) => scores.get(userId) ?? 0,
    setPlayerState: (userId: string, state: string) => {
      const current = players.get(userId);
      if (!current) return;
      players.set(userId, { ...current, playerState: state });
    },
  } as any;
}

const harnessGame = defineGame({
  name: 'harness-test',
  display: 'Harness Test',
  minPlayers: 1,
  maxPlayers: 4,
  rules: z.object({ rounds: z.number().default(3) }),
  scoring: {
    mode: 'cumulative',
    display: { label: 'Score' },
  },
  sync: { mode: 'event' },
  phases: {
    lobby: { next: 'play', advance: 'manual' },
    play: { next: null, advance: 'manual' },
  },
  handlers: {},
});

describe('recipes', () => {
  test('computes blind levels and escalating schedules', () => {
    const schedule = blindSchedule.createSchedule(4, 5, 10);

    expect(schedule).toEqual([
      { smallBlind: 5, bigBlind: 10, ante: 0, durationMinutes: 10 },
      { smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 10 },
      { smallBlind: 20, bigBlind: 40, ante: 0, durationMinutes: 10 },
      { smallBlind: 40, bigBlind: 80, ante: 8, durationMinutes: 10 },
    ]);
    expect(blindSchedule.getCurrentLevel(schedule, 0)).toEqual({
      smallBlind: 5,
      bigBlind: 10,
      ante: 0,
      level: 1,
    });
    expect(blindSchedule.getCurrentLevel(schedule, 45)).toEqual({
      smallBlind: 40,
      bigBlind: 80,
      ante: 8,
      level: 4,
    });
  });

  test('eliminates players by rank/threshold and resolves last-standing winners', () => {
    const ctx = makeProcessContext();
    const thresholdCtx = makeProcessContext();

    expect(elimination.eliminateLowest(ctx, { count: 1 })).toEqual(['carol']);
    expect(elimination.eliminateBelow(thresholdCtx, { threshold: 2, state: 'out' })).toEqual([
      'bob',
      'carol',
    ]);
    expect(
      elimination.checkLastStanding({
        ...ctx,
        getPlayers: () => [
          { userId: 'alice', playerState: null, isSpectator: false, team: 'red' },
          { userId: 'bob', playerState: null, isSpectator: false, team: 'red' },
          { userId: 'carol', playerState: 'eliminated', isSpectator: false, team: 'blue' },
        ],
      } as any),
    ).toEqual({
      winningTeam: 'red',
      winners: ['alice', 'bob'],
      reason: 'Last team standing',
    });
  });

  test('creates boards, finds paths, flood-fills connected cells, and clones safely', () => {
    const grid = gridBoard.create(3, 3, { fill: 0 });
    gridBoard.set(grid, 1, 1, 9);
    gridBoard.set(grid, 2, 0, 1);

    expect(gridBoard.get(grid, 1, 1)).toBe(9);
    expect(gridBoard.inBounds(grid, 2, 2)).toBe(true);
    expect(gridBoard.inBounds(grid, 3, 2)).toBe(false);
    expect(
      gridBoard.neighbors(grid, 1, 1, { diagonal: true }).map(({ x, y, value }) => ({
        x,
        y,
        value,
      })),
    ).toHaveLength(8);

    const path = gridBoard.findPath(
      grid,
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { walkable: cell => cell !== 9 },
    );
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ]);

    expect(gridBoard.floodFill(grid, 0, 0, { match: 0, fill: 7 })).toBe(7);
    const cloned = gridBoard.clone(grid);
    gridBoard.set(cloned, 0, 0, 99);
    expect(gridBoard.get(grid, 0, 0)).toBe(7);
    expect(gridBoard.get(cloned, 0, 0)).toBe(99);
  });

  test('builds decks, compares cards, and evaluates poker hands', () => {
    const deck = standardDeck.create({ decks: 2, jokers: 2 });
    expect(deck).toHaveLength(106);
    expect(
      standardDeck.compare(
        { suit: 'clubs', rank: '2', value: 2 },
        { suit: 'spades', rank: 'A', value: 14 },
      ),
    ).toBe(-1);

    const royalFlush: Card[] = [
      { suit: 'hearts', rank: '10', value: 10 },
      { suit: 'hearts', rank: 'J', value: 11 },
      { suit: 'hearts', rank: 'Q', value: 12 },
      { suit: 'hearts', rank: 'K', value: 13 },
      { suit: 'hearts', rank: 'A', value: 14 },
    ];
    const aceLowStraight: Card[] = [
      { suit: 'clubs', rank: 'A', value: 14 },
      { suit: 'diamonds', rank: '2', value: 2 },
      { suit: 'hearts', rank: '3', value: 3 },
      { suit: 'spades', rank: '4', value: 4 },
      { suit: 'clubs', rank: '5', value: 5 },
    ];

    expect(standardDeck.evaluatePokerHand(royalFlush)).toEqual({
      rank: 'royal-flush',
      value: 1000,
      display: 'Royal Flush',
    });
    expect(standardDeck.evaluatePokerHand(aceLowStraight)).toEqual({
      rank: 'straight',
      value: 514,
      display: 'Straight, Ace high',
    });
    expect(() => standardDeck.evaluatePokerHand(royalFlush.slice(0, 4))).toThrow(
      'Poker hand evaluation requires exactly 5 cards.',
    );
  });

  test('validates words and fuzzy matches accepted answers', () => {
    expect(wordValidator.isValid('Slingshot')).toBe(true);
    expect(wordValidator.isValid('')).toBe(false);
    expect(wordValidator.isValid('bad answer')).toBe(false);
    expect(wordValidator.isValidWith('Alpha', new Set(['alpha']))).toBe(true);
    expect(wordValidator.fuzzyMatch('slingshot', 'slingshat', 0.8)).toEqual({
      match: true,
      confidence: 0.89,
    });
    expect(wordValidator.matchesAny('slingshat', ['rocket', 'slingshot'], 0.8)).toEqual({
      match: true,
      confidence: 0.89,
    });
  });
});

describe('testing helpers', () => {
  test('drives deterministic timers and intervals through the mock clock', () => {
    const clock = createMockClock(100);
    const fired: string[] = [];

    const timeoutId = clock.setTimeout(() => fired.push('timeout'), 50);
    const intervalId = clock.setInterval(() => fired.push('interval'), 25);

    clock.advance(60);
    expect(clock.now()).toBe(160);
    expect(fired).toEqual(['interval', 'timeout', 'interval']);

    clock.clearInterval(intervalId);
    clock.clearTimeout(timeoutId);
    expect(clock.pendingCount()).toBe(0);

    clock.setTimeout(() => fired.push('after-reset'), 10);
    clock.reset();
    expect(clock.now()).toBe(100);
    expect(clock.pendingCount()).toBe(0);
  });

  test('creates a harness, accepts player bots, stores replay entries, and exposes assertion helpers', async () => {
    const harness = createTestHarness({
      game: harnessGame,
      rules: { rounds: 5 },
      players: [
        { userId: 'host-user', displayName: 'Host' },
        { userId: 'guest-user', displayName: 'Guest' },
      ],
    });

    expect(harness.submitAs('host-user', 'buzz', { answer: 'before-start' })).toEqual({
      accepted: false,
      code: 'SESSION_NOT_PLAYING',
      reason: 'Game not started',
    });

    harness.start();
    harness.publishedMessages.push(
      {
        room: `sessions:${harness.sessionId}:session`,
        message: { type: 'game:phase.entered', phase: 'lobby' },
      },
      {
        room: `sessions:${harness.sessionId}:session`,
        message: { type: 'game:phase.entered', phase: 'play' },
      },
      {
        room: `sessions:${harness.sessionId}:session`,
        message: { type: 'game:channel.opened', channel: 'buzz' },
      },
    );

    expect(harness.phase).toBe('lobby');
    expect(harness.submitAs('host-user', 'buzz', { answer: 'ready' })).toEqual({ accepted: true });

    harness.disconnect('guest-user');
    gameAssertions.playerDisconnected(harness, 'guest-user');
    harness.reconnect('guest-user');
    gameAssertions.playerConnected(harness, 'guest-user');

    const bot = new SimulatedPlayer({
      userId: 'bot-user',
      displayName: 'Bot',
      strategy: {
        buzz: (_channelData, context) => ({ answer: context.userId }),
        race: { delay: ({ phase }) => (phase === 'lobby' ? 25 : 50) },
      },
    });
    harness.addPlayer(bot);

    expect(bot.hasStrategy('buzz')).toBe(true);
    expect(
      bot.getResponse(
        'buzz',
        { prompt: 'go' },
        {
          userId: 'bot-user',
          gameState: {},
          phase: 'lobby',
          random: {
            int: () => 1,
            pick: array => array[0]!,
            bool: () => true,
          },
        },
      ),
    ).toEqual({ answer: 'bot-user' });
    expect(
      bot.getRaceDelay('race', {
        userId: 'bot-user',
        gameState: {},
        phase: 'lobby',
        random: {
          int: () => 1,
          pick: array => array[0]!,
          bool: () => true,
        },
      }),
    ).toBe(25);
    bot.setStrategy('vote', () => 'yes');
    expect(bot.hasStrategy('vote')).toBe(true);

    const replaySequence = createReplaySequence();
    await harness.replayStore.appendReplayEntries(harness.sessionId, [
      buildReplayEntry(harness.sessionId, replaySequence, 'player.joined', {
        userId: 'host-user',
      }),
    ]);

    harness.endGame({ winners: ['host-user'], reason: 'Last player standing' });
    (harness as any).scoreState.scores.set('host-user', 3);
    (harness as any).scoreState.scores.set('guest-user', 1);
    harness.getPlayer('guest-user').playerState = 'ready';

    gameAssertions.playerState(harness, 'guest-user', 'ready');
    gameAssertions.activePlayer(harness, 'host-user');
    gameAssertions.phase(harness, 'lobby');
    gameAssertions.channelOpen(harness, 'buzz');
    gameAssertions.phaseHistory(harness, ['lobby', 'play']);
    gameAssertions.score(harness, 'host-user', 3);
    gameAssertions.leaderboardPosition(harness, 'host-user', 1);
    gameAssertions.winner(harness, 'host-user');
    await expect(
      gameAssertions.replayContains(harness, {
        type: 'player.joined',
        data: { userId: 'host-user' },
      }),
    ).resolves.toBeUndefined();
  });
});
