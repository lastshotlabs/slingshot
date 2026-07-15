/**
 * Live-session persistence + resume.
 *
 * THE GAP THIS CLOSES: the engine kept a live session's `gameState`,
 * `currentPhase` and private state in memory only. The session ROW was written
 * at creation and at completion — nothing in between — and a runtime was only
 * ever created by the `game:session.started` event. So a process restart (a
 * deploy) destroyed every in-flight game: the row said `playing`, the persisted
 * state was the CREATION snapshot, and no runtime ever came back. Three real
 * parties died to this in one night.
 *
 * Two halves, tested here against the REAL runtime (never handlers-in-
 * isolation — that is how a 124-test suite stayed green through the last
 * engine bug):
 *
 *  1. PERSIST — after every settled phase transition, the runtime hands a
 *     snapshot (gameState, currentPhase, currentRound, privateState, rngState)
 *     to `deps.persistState`. A persist failure is LOUD and non-fatal: the
 *     game plays on, the operator finds a screaming log line.
 *
 *  2. RESUME — `createSessionRuntime(..., { resume })` rebuilds a runtime from
 *     that snapshot: state hydrated, the persisted phase re-armed (channels
 *     open, timer running), and inputs accepted. It must NOT re-run
 *     `onGameStart` (games wipe and rebuild state there — a respawn that wipes
 *     the state it came to restore is worse than none) and must NOT re-run the
 *     phase's `onEnter` (its mutations are already IN the persisted snapshot;
 *     running them twice double-applies them).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { type GameDefinition, defineGame } from '../../src/defineGame';
import { createInMemoryReplayStore } from '../../src/lib/replay';
import {
  type PersistedRuntimeState,
  type SessionRuntime,
  advancePhase,
  createSessionRuntime,
  destroySessionRuntime,
  processInputPipeline,
} from '../../src/lib/sessionRuntime';
import type { GamePlayerState } from '../../src/types/models';

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

const base = {
  display: 'Persistence',
  minPlayers: 1,
  maxPlayers: 4,
  rules: z.object({}),
  scoring: { mode: 'cumulative', display: { label: 'Score' } },
  sync: { mode: 'event' },
} as const;

/** A stateful little game: onGameStart seeds, onEnter mutates, inputs count. */
function makeGame(name: string, calls: string[]): GameDefinition {
  return defineGame({
    ...base,
    name,
    phases: {
      lobby: { next: 'play', advance: 'manual' },
      play: {
        next: 'wrap',
        advance: 'timeout',
        timeout: 60_000,
        onEnter: 'enterPlay',
        channels: {
          tap: {
            mode: 'free',
            from: 'all-players',
            relay: 'none',
            schema: z.object({ n: z.number() }),
            process: 'processTap',
          },
        },
      },
      wrap: { next: null, advance: 'manual' },
    },
    handlers: {
      enterPlay: (ctx: any) => {
        calls.push('enterPlay');
        ctx.gameState.entries = (ctx.gameState.entries ?? 0) + 1;
      },
      processTap: (ctx: any, _userId: unknown, data: any) => {
        calls.push('processTap');
        ctx.gameState.taps = (ctx.gameState.taps ?? 0) + Number(data?.n ?? 0);
        return undefined;
      },
    },
    hooks: {
      onGameStart(ctx: any) {
        calls.push('onGameStart');
        ctx.gameState.seeded = true;
        ctx.gameState.taps = 0;
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
      privateState?: Record<string, unknown> | null;
      rngState?: number | null;
    };
    initialGameState?: Record<string, unknown>;
  } = {},
) {
  const activeRuntimes = new Map<string, SessionRuntime>();
  activeRuntimeMaps.push(activeRuntimes);
  const logErrors: string[] = [];

  const runtime = await createSessionRuntime('session-1', game, {}, [makePlayer()], 1234, {
    publish() {},
    replayStore: createInMemoryReplayStore(),
    log: {
      debug() {},
      info() {},
      warn() {},
      error(message: string) {
        logErrors.push(message);
      },
    },
    activeRuntimes,
    persistState: options.persistState,
    resume: options.resume,
    initialGameState: options.initialGameState ?? null,
  });

  if (!runtime) throw new Error('Expected createSessionRuntime() to create a runtime.');
  return { runtime, logErrors };
}

describe('persist on phase transition', () => {
  test('every settled transition hands the post-transition snapshot to persistState', async () => {
    const calls: string[] = [];
    const snapshots: PersistedRuntimeState[] = [];

    const { runtime } = await boot(makeGame('persist-basic', calls), {
      persistState: async snapshot => {
        snapshots.push(structuredClone(snapshot));
      },
    });

    await advancePhase(runtime); // lobby → play (runs enterPlay)
    // Fire-and-forget by design — give the microtask a beat to land.
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const last = snapshots[snapshots.length - 1]!;
    // The snapshot is POST-transition: the phase we landed in, with onEnter's
    // mutation already applied. A pre-transition snapshot would resurrect the
    // phase the room just left.
    expect(last.currentPhase).toBe('play');
    expect((last.gameState as { entries?: number }).entries).toBe(1);
    // The resumability marker + determinism: the RNG's live state rides along.
    expect(typeof last.rngState).toBe('number');
  });

  test('a persist failure is LOUD and non-fatal: the game plays on', async () => {
    const calls: string[] = [];
    const { runtime, logErrors } = await boot(makeGame('persist-fails', calls), {
      persistState: async () => {
        throw new Error('disk on fire');
      },
    });

    await advancePhase(runtime); // lobby → play
    await new Promise(resolve => setTimeout(resolve, 10));

    // The transition itself succeeded…
    expect(runtime.phaseState.currentPhase).toBe('play');
    // …and the failure was SCREAMED, not swallowed. A silent persist failure
    // is exactly how a "the state is safe" assumption dies unnoticed.
    expect(logErrors.some(line => /persist/i.test(line))).toBe(true);
  });
});

describe('resume from a persisted snapshot', () => {
  test('rebuilds the runtime mid-game: state kept, phase re-armed, inputs accepted', async () => {
    const calls: string[] = [];

    // The snapshot a real crash would leave behind: mid-`play`, one enter
    // already applied, three taps in.
    const { runtime } = await boot(makeGame('resume-basic', calls), {
      initialGameState: { seeded: true, entries: 1, taps: 3 },
      resume: {
        currentPhase: 'play',
        currentRound: 2,
        privateState: { 'host-user': { secret: 'kept' } },
        rngState: 987654,
      },
    });

    // onGameStart must NOT have run (it would wipe taps back to 0), and the
    // phase's onEnter must NOT have re-run (entries would double to 2).
    expect(calls).not.toContain('onGameStart');
    expect(calls).not.toContain('enterPlay');
    expect((runtime.gameState as { taps?: number }).taps).toBe(3);
    expect((runtime.gameState as { entries?: number }).entries).toBe(1);

    // The persisted phase is live again: right phase, round restored, the
    // phase timer armed, the channel open.
    expect(runtime.phaseState.currentPhase).toBe('play');
    expect(runtime.currentRound).toBe(2);
    expect(runtime.phaseState.phaseTimerId).not.toBeNull();
    expect(runtime.channels.get('tap')?.open).toBe(true);

    // Private state came back — a dossier must survive a deploy.
    expect(runtime.privateStateManager.get('host-user')).toEqual({ secret: 'kept' });

    // RNG state restored, not reseeded.
    expect((runtime.rng as unknown as { getState(): number }).getState()).toBe(987654);

    // And the room can actually PLAY: an input on the resumed channel lands.
    const ack = await processInputPipeline(runtime, 'tap', 'host-user', { n: 2 }, 1);
    expect(ack.accepted).toBe(true);
    expect((runtime.gameState as { taps?: number }).taps).toBe(5);
  });

  test('resuming still advances normally afterwards', async () => {
    const calls: string[] = [];
    const { runtime } = await boot(makeGame('resume-advances', calls), {
      initialGameState: { seeded: true, entries: 1, taps: 0 },
      resume: { currentPhase: 'play', currentRound: 1 },
    });

    await advancePhase(runtime); // play → wrap
    expect(runtime.phaseState.currentPhase).toBe('wrap');
  });
});
