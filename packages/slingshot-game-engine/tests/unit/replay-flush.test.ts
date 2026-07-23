/**
 * Replay durability: flush cadence, write ordering, and failure isolation.
 *
 * The behaviour under test is the fix for a real defect. Replay entries used to
 * accumulate in `runtime.pendingReplayEntries` for the ENTIRE session and reach
 * the store exactly once, from `endGameFlow`. That meant:
 *
 *   - a crash or redeploy mid-session lost every entry;
 *   - a session that was abandoned (and so never reached `endGameFlow`) was
 *     never written at all;
 *   - the buffer grew without bound across a long session;
 *   - and the `ReplayStore` contract — "entries MUST be persisted durably
 *     before returning" — was not honoured by the caller.
 *
 * These tests pin the fix: entries reach the store DURING the session, in
 * order, and a failing store does not take the live game down.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGame } from '../../src/defineGame';
import {
  type SessionRuntime,
  createSessionRuntime,
  destroySessionRuntime,
  flushReplayEntries,
  handleDisconnect,
} from '../../src/lib/sessionRuntime';
import type { ReplayStore } from '../../src/types/adapters';
import type { GamePlayerState, ReplayEntry } from '../../src/types/models';

const activeRuntimeMaps: Array<Map<string, SessionRuntime>> = [];

afterEach(() => {
  for (const activeRuntimes of activeRuntimeMaps.splice(0)) {
    for (const sessionId of [...activeRuntimes.keys()]) {
      destroySessionRuntime(activeRuntimes, sessionId);
    }
  }
});

const game = defineGame({
  name: 'replay-flush-test',
  display: 'Replay Flush Test',
  minPlayers: 1,
  maxPlayers: 4,
  rules: z.object({}),
  scoring: { mode: 'cumulative', display: { label: 'Score' } },
  sync: { mode: 'event' },
  phases: {
    lobby: { next: 'play', advance: 'manual' },
    play: { next: null, advance: 'manual' },
  },
  handlers: {},
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

/** A ReplayStore that records every write, in the order it received them. */
function createRecordingStore(): ReplayStore & {
  readonly batches: ReplayEntry[][];
  readonly all: () => ReplayEntry[];
} {
  const batches: ReplayEntry[][] = [];
  return {
    batches,
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

async function createRuntimeWith(store: ReplayStore, log = silentLog) {
  const activeRuntimes = new Map<string, SessionRuntime>();
  activeRuntimeMaps.push(activeRuntimes);

  const runtime = await createSessionRuntime(
    'replay-session',
    game,
    {},
    [
      makePlayer(),
      makePlayer({ userId: 'player-2', displayName: 'Player Two', isHost: false, joinOrder: 2 }),
    ],
    1234,
    { publish() {}, replayStore: store, log, activeRuntimes },
  );

  if (!runtime) throw new Error('Expected createSessionRuntime() to create a runtime.');
  return runtime;
}

describe('replay flush cadence', () => {
  test('entries reach the store DURING the session, not only when the game ends', async () => {
    const store = createRecordingStore();
    const runtime = await createRuntimeWith(store);

    // Drain anything emitted while the runtime was being built.
    await flushReplayEntries(runtime);
    const before = store.all().length;

    // A perfectly ordinary mid-game event. The game is NOT over — endGameFlow
    // has not run and will not run in this test.
    await handleDisconnect(runtime, 'player-2');
    await flushReplayEntries(runtime);

    const written = store.all();
    expect(written.length).toBeGreaterThan(before);
    expect(written.some(e => e.type === 'player.disconnected')).toBeTrue();
    // The buffer is handed over, not merely copied.
    expect(runtime.pendingReplayEntries).toHaveLength(0);
  });

  test('a flush is scheduled automatically, without an explicit call', async () => {
    const store = createRecordingStore();
    const runtime = await createRuntimeWith(store);
    await flushReplayEntries(runtime);
    const before = store.all().length;

    await handleDisconnect(runtime, 'player-2');

    // No explicit flush here — `appendReplay` schedules one on the microtask
    // queue. Yield twice: once for the scheduling microtask, once for the
    // store write it kicks off.
    await Promise.resolve();
    await Promise.resolve();
    await runtime.replayFlushChain;

    expect(store.all().length).toBeGreaterThan(before);
  });

  test('entries emitted in one cycle coalesce into a single write', async () => {
    const store = createRecordingStore();
    const runtime = await createRuntimeWith(store);
    await flushReplayEntries(runtime);
    store.batches.length = 0;

    // handleDisconnect emits more than one entry (disconnect + any timer it
    // starts). They must arrive as ONE batch, not one write per entry.
    await handleDisconnect(runtime, 'player-2');
    await flushReplayEntries(runtime);

    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]!.length).toBeGreaterThan(0);
  });

  test('batches reach the store in sequence order', async () => {
    const store = createRecordingStore();
    const runtime = await createRuntimeWith(store);

    // Two flushes racing: without the serializing chain these could interleave
    // and produce a log that cannot be deterministically reconstructed.
    await handleDisconnect(runtime, 'player-2');
    const a = flushReplayEntries(runtime);
    const b = flushReplayEntries(runtime);
    await Promise.all([a, b]);

    const sequences = store.all().map(e => e.sequence);
    const sorted = [...sequences].sort((x, y) => x - y);
    expect(sequences).toEqual(sorted);
  });

  test('a failing store is logged, not thrown — the live game survives it', async () => {
    const errors: string[] = [];
    const exploding: ReplayStore = {
      appendReplayEntries() {
        return Promise.reject(new Error('storage is down'));
      },
      getReplayEntries() {
        return Promise.resolve({ entries: [], total: 0, hasMore: false });
      },
      deleteReplayEntries() {
        return Promise.resolve();
      },
    };

    const runtime = await createRuntimeWith(exploding, {
      ...silentLog,
      error(message: string) {
        errors.push(message);
      },
    });

    // Must not reject.
    await handleDisconnect(runtime, 'player-2');
    await flushReplayEntries(runtime);

    expect(errors.some(m => m.includes('Failed to flush replay entries'))).toBeTrue();
    // The runtime is still usable.
    expect(runtime.players.get('player-2')).toBeDefined();
  });

  test('flushing an empty buffer is a no-op, not an empty write', async () => {
    const store = createRecordingStore();
    const runtime = await createRuntimeWith(store);
    await flushReplayEntries(runtime);
    store.batches.length = 0;

    await flushReplayEntries(runtime);
    await flushReplayEntries(runtime);

    expect(store.batches).toHaveLength(0);
  });
});
