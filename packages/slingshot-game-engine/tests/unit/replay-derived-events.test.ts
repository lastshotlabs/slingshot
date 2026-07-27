/**
 * The three replay events that were exported and never written.
 *
 * `logChannelRaceClaimed`, `logScoreChanged`, and `logChannelVoteTally` all
 * existed in `src/lib/replay.ts` from the start, were part of the documented
 * event vocabulary, and were called from nowhere — so three facts a replay is
 * supposed to carry simply were not in it:
 *
 *   - WHO GOT THERE FIRST. `channel.input` records that a player submitted, not
 *     the order the race resolved in.
 *   - WHAT ANYONE SCORED. The log carried the input that earned the points and
 *     never the points, so a score could not be reconstructed at all. (This is
 *     what kept TRIVIA's results recap from rendering a "Biggest swing" card.)
 *   - HOW A VOTE CAME OUT. Every individual vote was logged; the winner/tie
 *     result was not, and `computeVoteTally` was unreachable from the runtime.
 *
 * These tests drive the real pipeline and assert on what reached the store.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGame } from '../../src/defineGame';
import {
  type SessionRuntime,
  advancePhase,
  createSessionRuntime,
  destroySessionRuntime,
  flushReplayEntries,
  processInputPipeline,
} from '../../src/lib/sessionRuntime';
import type { ReplayStore } from '../../src/types/adapters';
import type { GamePlayerState, ProcessHandlerContext, ReplayEntry } from '../../src/types/models';

const activeRuntimeMaps: Array<Map<string, SessionRuntime>> = [];

afterEach(() => {
  for (const activeRuntimes of activeRuntimeMaps.splice(0)) {
    for (const sessionId of [...activeRuntimes.keys()]) {
      destroySessionRuntime(activeRuntimes, sessionId);
    }
  }
});

function makePlayer(overrides: Partial<GamePlayerState> = {}): GamePlayerState {
  return {
    userId: 'host-user',
    displayName: 'Host',
    role: null,
    team: null,
    playerState: null,
    score: 0,
    connected: true,
    isHost: true,
    isSpectator: false,
    joinOrder: 1,
    ...overrides,
  };
}

function createRecordingStore(): ReplayStore & { readonly all: () => ReplayEntry[] } {
  const batches: ReplayEntry[][] = [];
  return {
    all: () => batches.flat(),
    appendReplayEntries(_sessionId, entries) {
      batches.push([...entries]);
      return Promise.resolve();
    },
    getReplayEntries(_sessionId, from, limit) {
      const entries = batches
        .flat()
        .filter(e => e.sequence > from)
        .slice(0, limit);
      return Promise.resolve({ entries, total: batches.flat().length, hasMore: false });
    },
    deleteReplayEntries() {
      batches.length = 0;
      return Promise.resolve();
    },
  };
}

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * `count: 2` on the race channel so the SECOND claim is still accepted — a
 * one-claim race would prove nothing about ordering.
 */
const game = defineGame({
  name: 'replay-derived-test',
  display: 'Replay Derived Test',
  minPlayers: 1,
  maxPlayers: 4,
  rules: z.object({}),
  scoring: { mode: 'cumulative', display: { label: 'Score' } },
  sync: { mode: 'event' },
  phases: {
    lobby: { next: 'play', advance: 'manual' },
    play: {
      next: null,
      advance: 'manual',
      channels: {
        buzz: {
          mode: 'race' as const,
          from: 'all-players' as const,
          relay: 'none' as const,
          count: 2,
          schema: z.object({}),
        },
        award: {
          mode: 'collect' as const,
          from: 'all-players' as const,
          relay: 'none' as const,
          allowChange: true,
          schema: z.object({ points: z.number(), absolute: z.boolean().default(false) }),
          process: 'onAward',
        },
        // A vote channel's payload IS the option — `computeVoteTally` keys the
        // count on `String(input)`, so an object payload would tally as
        // "[object Object]". Every vote channel in the repo is a bare scalar
        // schema for exactly that reason.
        pick: {
          mode: 'vote' as const,
          from: 'all-players' as const,
          relay: 'none' as const,
          schema: z.string(),
        },
      },
    },
  },
  handlers: {
    onAward(ctx: ProcessHandlerContext, ...args: unknown[]): undefined {
      const userId = args[0] as string;
      const { points, absolute } = args[1] as { points: number; absolute: boolean };
      if (absolute) ctx.setScore(userId, points);
      else ctx.addScore(userId, points);
      return undefined;
    },
  },
});

async function createHarness() {
  const activeRuntimes = new Map<string, SessionRuntime>();
  activeRuntimeMaps.push(activeRuntimes);
  const store = createRecordingStore();

  const runtime = await createSessionRuntime(
    'derived-session',
    game,
    {},
    [
      makePlayer(),
      makePlayer({ userId: 'player-2', displayName: 'Player Two', isHost: false, joinOrder: 2 }),
    ],
    1234,
    { publish() {}, replayStore: store, log: silentLog, activeRuntimes },
  );

  if (!runtime) throw new Error('Expected createSessionRuntime() to create a runtime.');
  // lobby → play opens the channels.
  await advancePhase(runtime);
  return { runtime, store };
}

async function entriesOfType(
  runtime: SessionRuntime,
  store: { all: () => ReplayEntry[] },
  type: string,
): Promise<ReplayEntry[]> {
  await flushReplayEntries(runtime);
  return store.all().filter(e => e.type === type);
}

describe('channel.race.claimed', () => {
  test('every accepted claim is logged, in claim order, with a 1-based position', async () => {
    const { runtime, store } = await createHarness();

    expect((await processInputPipeline(runtime, 'buzz', 'player-2', {}, 1)).accepted).toBeTrue();
    expect((await processInputPipeline(runtime, 'buzz', 'host-user', {}, 1)).accepted).toBeTrue();

    const claimed = await entriesOfType(runtime, store, 'channel.race.claimed');
    expect(claimed).toHaveLength(2);
    // Player two got there first, and the log says so — which is the entire
    // point of a race and the one thing `channel.input` cannot tell you.
    expect(claimed[0].data).toMatchObject({ channel: 'buzz', userId: 'player-2', position: 1 });
    expect(claimed[1].data).toMatchObject({ channel: 'buzz', userId: 'host-user', position: 2 });
  });

  test('a rejected claim past the count writes nothing', async () => {
    const { runtime, store } = await createHarness();

    await processInputPipeline(runtime, 'buzz', 'player-2', {}, 1);
    await processInputPipeline(runtime, 'buzz', 'host-user', {}, 1);
    // The race is full (count: 2) and the channel closed on completion.
    const third = await processInputPipeline(runtime, 'buzz', 'player-2', {}, 2);
    expect(third.accepted).toBeFalse();

    expect(await entriesOfType(runtime, store, 'channel.race.claimed')).toHaveLength(2);
  });

  test('a non-race channel does not emit a claim', async () => {
    const { runtime, store } = await createHarness();

    await processInputPipeline(runtime, 'award', 'host-user', { points: 10 }, 1);

    expect(await entriesOfType(runtime, store, 'channel.race.claimed')).toHaveLength(0);
  });
});

describe('score.changed', () => {
  test('ctx.addScore writes the before, the after, and the delta', async () => {
    const { runtime, store } = await createHarness();

    await processInputPipeline(runtime, 'award', 'player-2', { points: 200 }, 1);
    await processInputPipeline(runtime, 'award', 'player-2', { points: -50 }, 2);

    const changes = await entriesOfType(runtime, store, 'score.changed');
    expect(changes).toHaveLength(2);
    expect(changes[0].data).toEqual({
      userId: 'player-2',
      previousScore: 0,
      newScore: 200,
      change: 200,
    });
    // The second entry's previousScore is the first's newScore — the chain a
    // recap walks to find the biggest swing.
    expect(changes[1].data).toEqual({
      userId: 'player-2',
      previousScore: 200,
      newScore: 150,
      change: -50,
    });
  });

  test('ctx.setScore reports the delta it implies, not the value it was given', async () => {
    const { runtime, store } = await createHarness();

    await processInputPipeline(runtime, 'award', 'host-user', { points: 300 }, 1);
    await processInputPipeline(runtime, 'award', 'host-user', { points: 100, absolute: true }, 2);

    const changes = await entriesOfType(runtime, store, 'score.changed');
    expect(changes).toHaveLength(2);
    expect(changes[1].data).toEqual({
      userId: 'host-user',
      previousScore: 300,
      newScore: 100,
      change: -200,
    });
  });
});

describe('channel.vote.tally', () => {
  test('a vote channel closing on completion logs the outcome', async () => {
    const { runtime, store } = await createHarness();

    await processInputPipeline(runtime, 'pick', 'host-user', 'blue', 1);
    // The last eligible vote completes the channel, which closes it.
    await processInputPipeline(runtime, 'pick', 'player-2', 'blue', 1);

    const tallies = await entriesOfType(runtime, store, 'channel.vote.tally');
    expect(tallies).toHaveLength(1);
    expect(tallies[0].data).toMatchObject({
      channel: 'pick',
      winner: 'blue',
      tie: false,
      totalVotes: 2,
    });
    expect((tallies[0].data as { options: Record<string, number> }).options).toEqual({ blue: 2 });
  });

  test('a split vote is logged as a tie with no winner', async () => {
    const { runtime, store } = await createHarness();

    await processInputPipeline(runtime, 'pick', 'host-user', 'blue', 1);
    await processInputPipeline(runtime, 'pick', 'player-2', 'red', 1);

    const tallies = await entriesOfType(runtime, store, 'channel.vote.tally');
    expect(tallies).toHaveLength(1);
    expect(tallies[0].data).toMatchObject({ winner: null, tie: true, totalVotes: 2 });
  });

  test('a vote still open when the phase advances is tallied at that close too', async () => {
    const { runtime, store } = await createHarness();

    await processInputPipeline(runtime, 'pick', 'host-user', 'green', 1);
    // Only one of two eligible players voted, so the channel is still open.
    expect(await entriesOfType(runtime, store, 'channel.vote.tally')).toHaveLength(0);

    await advancePhase(runtime);

    const tallies = await entriesOfType(runtime, store, 'channel.vote.tally');
    expect(tallies).toHaveLength(1);
    expect(tallies[0].data).toMatchObject({ winner: 'green', tie: false, totalVotes: 1 });
  });

  test('a non-vote channel closing emits channel.closed and no tally', async () => {
    const { runtime, store } = await createHarness();

    await processInputPipeline(runtime, 'buzz', 'player-2', {}, 1);
    await processInputPipeline(runtime, 'buzz', 'host-user', {}, 1);

    expect(
      (await entriesOfType(runtime, store, 'channel.closed')).some(
        e => (e.data as { channel: string }).channel === 'buzz',
      ),
    ).toBeTrue();
    expect(await entriesOfType(runtime, store, 'channel.vote.tally')).toHaveLength(0);
  });
});
