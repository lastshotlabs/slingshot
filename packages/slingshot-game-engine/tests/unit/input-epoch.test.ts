/**
 * INPUT EPOCH — the cross-turn stale-input guard.
 *
 * THE BUG CLASS THIS PINS (hotseat's vanishing truth/dare picker, patched
 * app-side there and promoted to the framework here): the only phase-scoping
 * on an input used to be the channel-open check. Channels regularly REUSE
 * NAMES across phases/turns ("chooseKind" exists every turn), and a reconnect
 * both resets the per-connection sequence cache and flushes the client's
 * outbound queue — so an input composed against the PREVIOUS phase could
 * re-land under a fresh sequence in a same-named channel reopened for the NEW
 * phase, and complete it. The player who was supposed to act watched their
 * picker vanish.
 *
 * The guard: the runtime bumps `inputEpoch` on every phase transition, stamps
 * it on every session frame it publishes, and rejects any input stamped with
 * an OLDER epoch (`INPUT_STALE_EPOCH`). Unstamped inputs pass (old clients,
 * tests); inputs stamped AHEAD pass (a restart may resume the counter
 * slightly behind the last broadcast — a genuinely stale input is always
 * strictly LOWER).
 *
 * Everything here drives the REAL runtime through `createSessionRuntime` /
 * `processInputPipeline` — never a handler in isolation.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGame } from '../../src/defineGame';
import { GameErrorCode } from '../../src/errors';
import { createInMemoryReplayStore } from '../../src/lib/replay';
import {
  type PersistedRuntimeState,
  type SessionRuntime,
  advancePhase,
  createSessionRuntime,
  destroySessionRuntime,
  processInputPipeline,
} from '../../src/lib/sessionRuntime';
import type { GameDefinition } from '../../src/types/models';
import type { GamePlayerState } from '../../src/types/models';
import { buildIncomingDispatch } from '../../src/ws/incoming';

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

/**
 * The shape that produced the live bug: two consecutive phases that BOTH open
 * a channel named `pick`. An input aimed at choose's `pick` must not be able
 * to land in act's `pick`.
 */
function makeGame(name: string, picks: Array<{ phase: string | null; v: number }>): GameDefinition {
  const pickChannel = {
    mode: 'free',
    from: 'all-players',
    relay: 'none',
    schema: z.object({ v: z.number() }),
    process: 'processPick',
  } as const;
  return defineGame({
    name,
    display: 'Epoch',
    minPlayers: 1,
    maxPlayers: 4,
    rules: z.object({}),
    scoring: { mode: 'cumulative', display: { label: 'Score' } },
    sync: { mode: 'event' },
    phases: {
      choose: { next: 'act', advance: 'manual', channels: { pick: pickChannel } },
      act: { next: 'wrap', advance: 'manual', channels: { pick: pickChannel } },
      wrap: { next: null, advance: 'manual' },
    },
    handlers: {
      processPick: (ctx: any, _userId: unknown, data: any) => {
        picks.push({ phase: ctx.phaseState?.currentPhase ?? ctx.currentPhase ?? null, v: data.v });
        return undefined;
      },
    },
  });
}

async function boot(
  game: GameDefinition,
  options: {
    persistState?: (snapshot: PersistedRuntimeState) => Promise<void>;
    resume?: {
      currentPhase: string | null;
      currentRound: number;
      rngState?: number | null;
      inputEpoch?: number | null;
    };
    initialGameState?: Record<string, unknown>;
    published?: Array<{ room: string; message: unknown }>;
  } = {},
) {
  const activeRuntimes = new Map<string, SessionRuntime>();
  activeRuntimeMaps.push(activeRuntimes);

  const runtime = await createSessionRuntime('session-1', game, {}, [makePlayer()], 1234, {
    publish(room, message) {
      options.published?.push({ room, message });
    },
    replayStore: createInMemoryReplayStore(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    activeRuntimes,
    persistState: options.persistState,
    resume: options.resume,
    initialGameState: options.initialGameState ?? null,
    initialPrivateState: null,
  });

  if (!runtime) throw new Error('Expected createSessionRuntime() to create a runtime.');
  return runtime;
}

describe('the epoch guard in the input pipeline', () => {
  test('a current-epoch input is accepted; an older one is rejected LOUDLY with the current epoch', async () => {
    const picks: Array<{ phase: string | null; v: number }> = [];
    const runtime = await boot(makeGame('epoch-basic', picks));
    const startEpoch = runtime.inputEpoch;

    const ok = await processInputPipeline(runtime, 'pick', 'host-user', { v: 1 }, 1, startEpoch);
    expect(ok.accepted).toBe(true);

    await advancePhase(runtime); // choose → act, same-named `pick` reopens
    expect(runtime.inputEpoch).toBe(startEpoch + 1);

    // THE BUG: this input was composed against `choose`. Without the guard it
    // lands in act's reopened `pick` and completes the wrong phase.
    const stale = await processInputPipeline(runtime, 'pick', 'host-user', { v: 2 }, 2, startEpoch);
    expect(stale.accepted).toBe(false);
    expect(stale.code).toBe(GameErrorCode.INPUT_STALE_EPOCH);
    // The nack carries the current epoch so a client can resync, not guess.
    expect((stale.details as { currentEpoch?: number }).currentEpoch).toBe(runtime.inputEpoch);
    expect(picks.map(p => p.v)).toEqual([1]); // the stale handler never ran

    const fresh = await processInputPipeline(
      runtime,
      'pick',
      'host-user',
      { v: 3 },
      3,
      runtime.inputEpoch,
    );
    expect(fresh.accepted).toBe(true);
    expect(picks.map(p => p.v)).toEqual([1, 3]);
  });

  test('an UNSTAMPED input passes (old clients, harness drivers) — no regression', async () => {
    const picks: Array<{ phase: string | null; v: number }> = [];
    const runtime = await boot(makeGame('epoch-unstamped', picks));
    await advancePhase(runtime);
    const ack = await processInputPipeline(runtime, 'pick', 'host-user', { v: 7 }, 1);
    expect(ack.accepted).toBe(true);
  });

  test('an input stamped AHEAD of the runtime passes — a resume may sit slightly behind', async () => {
    const picks: Array<{ phase: string | null; v: number }> = [];
    const runtime = await boot(makeGame('epoch-ahead', picks));
    const ack = await processInputPipeline(
      runtime,
      'pick',
      'host-user',
      { v: 9 },
      1,
      runtime.inputEpoch + 3,
    );
    expect(ack.accepted).toBe(true);
  });

  test('the reconnect replay path itself: sequence cache reset + fresh sequence does NOT resurrect a stale input', async () => {
    const picks: Array<{ phase: string | null; v: number }> = [];
    const runtime = await boot(makeGame('epoch-reconnect', picks));
    const preEpoch = runtime.inputEpoch;

    await processInputPipeline(runtime, 'pick', 'host-user', { v: 1 }, 1, preEpoch);
    await advancePhase(runtime); // the world moves on while the phone is offline

    // What a resubscribe does (resetSequenceCache is module-private; the cache
    // key is `${sessionId}:${userId}`) — and exactly why sequence dedup can't
    // catch the replay that follows it.
    runtime.sequenceCache.delete('session-1:host-user');

    // The client's outbound queue flushes its pre-disconnect frame under a
    // fresh connection-local sequence.
    const replayed = await processInputPipeline(
      runtime,
      'pick',
      'host-user',
      { v: 1 },
      1,
      preEpoch,
    );
    expect(replayed.accepted).toBe(false);
    expect(replayed.code).toBe(GameErrorCode.INPUT_STALE_EPOCH);
    expect(picks.length).toBe(1);
  });

  test('an exact resend of an ACCEPTED input still gets its cached ack (dedup wins over the guard)', async () => {
    const picks: Array<{ phase: string | null; v: number }> = [];
    const runtime = await boot(makeGame('epoch-dedup', picks));
    const epochAtSend = runtime.inputEpoch;

    const first = await processInputPipeline(
      runtime,
      'pick',
      'host-user',
      { v: 5 },
      4,
      epochAtSend,
    );
    expect(first.accepted).toBe(true);

    await advancePhase(runtime);

    // Same connection, same sequence: the resend of an input that WAS applied
    // must report success, not STALE_EPOCH — the client is asking "did it
    // land?", and it did.
    const resend = await processInputPipeline(
      runtime,
      'pick',
      'host-user',
      { v: 5 },
      4,
      epochAtSend,
    );
    expect(resend.accepted).toBe(true);
    expect(picks.length).toBe(1);
  });
});

describe('clients can always know the current epoch', () => {
  test('every session frame the runtime publishes carries it', async () => {
    const picks: Array<{ phase: string | null; v: number }> = [];
    const published: Array<{ room: string; message: unknown }> = [];
    const runtime = await boot(makeGame('epoch-frames', picks), { published });

    published.length = 0;
    await advancePhase(runtime); // choose → act publishes channel/phase frames

    const sessionFrames = published
      .map(p => p.message as Record<string, unknown>)
      .filter(m => m && m.sessionId === 'session-1');
    expect(sessionFrames.length).toBeGreaterThanOrEqual(1);
    // Every frame is stamped. Frames published while LEAVING the old phase
    // (channel.closed) carry the old epoch — an input composed against them is
    // exactly the input the guard must reject — and the entry frames carry the
    // new one, so a client that saw the transition holds the current value.
    for (const frame of sessionFrames) {
      expect(typeof frame.epoch).toBe('number');
    }
    const entered = sessionFrames.find(f => f.type === 'game:phase.entered');
    expect(entered).toBeDefined();
    expect(entered!.epoch).toBe(runtime.inputEpoch);
  });

  test('the game:state.snapshot subscribe ack carries it (the reconnect hello)', async () => {
    const picks: Array<{ phase: string | null; v: number }> = [];
    const runtime = await boot(makeGame('epoch-snapshot', picks));

    const acks: unknown[] = [];
    const handlers = buildIncomingDispatch({
      resolveSession: async () => ({
        session: {
          id: 'session-1',
          gameType: 'epoch-snapshot',
          status: 'playing',
          hostUserId: 'host-user',
        },
        players: [makePlayer()],
        gameDef: runtime.gameDef,
      }),
      processInput: async () => ({ accepted: true }),
      handleReconnect: async () => {},
      getSessionEpoch: () => runtime.inputEpoch,
      bus: { emit() {} },
    });
    const subscribe = handlers.find(h => h.event === 'game:subscribe');
    if (!subscribe) throw new Error('no game:subscribe handler');
    await subscribe.handler({
      actorId: 'host-user',
      socketId: 's1',
      payload: { type: 'game:subscribe', sessionId: 'session-1' },
      ack: data => acks.push(data),
      publish() {},
      subscribe() {},
      unsubscribe() {},
    });

    const snapshot = acks.find(
      a => (a as { type?: string }).type === 'game:state.snapshot',
    ) as Record<string, unknown>;
    expect(snapshot).toBeDefined();
    expect(snapshot.epoch).toBe(runtime.inputEpoch);
  });

  test('the wire schema forwards the stamp into the pipeline', async () => {
    const seen: Array<number | undefined> = [];
    const handlers = buildIncomingDispatch({
      resolveSession: async () => null,
      processInput: async (_s, _c, _u, _d, _seq, epoch) => {
        seen.push(epoch);
        return { accepted: true };
      },
      handleReconnect: async () => {},
      bus: { emit() {} },
    });
    const input = handlers.find(h => h.event === 'game:input');
    if (!input) throw new Error('no game:input handler');

    const ctx = (payload: unknown) => ({
      actorId: 'host-user',
      socketId: 's1',
      payload,
      ack() {},
      publish() {},
      subscribe() {},
      unsubscribe() {},
    });
    await input.handler(
      ctx({
        type: 'game:input',
        sessionId: 's',
        channel: 'pick',
        data: { v: 1 },
        sequence: 1,
        epoch: 4,
      }),
    );
    await input.handler(
      ctx({ type: 'game:input', sessionId: 's', channel: 'pick', data: { v: 1 }, sequence: 2 }),
    );
    expect(seen).toEqual([4, undefined]);
  });
});

describe('the epoch survives a restart', () => {
  test('persisted on every settled transition; resume hydrates it instead of restarting at zero', async () => {
    const picks: Array<{ phase: string | null; v: number }> = [];
    const snapshots: PersistedRuntimeState[] = [];
    const runtime = await boot(makeGame('epoch-persist', picks), {
      persistState: async snapshot => {
        snapshots.push(structuredClone(snapshot));
      },
    });

    await advancePhase(runtime); // choose → act
    await new Promise(resolve => setTimeout(resolve, 10));

    const last = snapshots[snapshots.length - 1]!;
    expect(last.inputEpoch).toBe(runtime.inputEpoch);
    expect(last.inputEpoch).toBeGreaterThanOrEqual(1);

    // The respawn: a fresh process, the persisted footprint, no re-enter (so
    // no bump — clients hold exactly this epoch and must stay in sync).
    const resumed = await boot(makeGame('epoch-persist-2', picks), {
      initialGameState: last.gameState,
      resume: {
        currentPhase: last.currentPhase,
        currentRound: last.currentRound,
        rngState: last.rngState,
        inputEpoch: last.inputEpoch,
      },
    });
    expect(resumed.inputEpoch).toBe(last.inputEpoch);

    // An input stamped with the pre-restart epoch is CURRENT here, not stale.
    const ack = await processInputPipeline(
      resumed,
      'pick',
      'host-user',
      { v: 11 },
      1,
      last.inputEpoch,
    );
    expect(ack.accepted).toBe(true);
  });
});
