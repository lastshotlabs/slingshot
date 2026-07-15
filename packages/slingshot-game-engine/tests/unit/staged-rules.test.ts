/**
 * Staged rules — accept a rules patch at ANY time, apply it at the next safe
 * boundary the game declares, and say so.
 *
 * THE GAP THIS CLOSES: every shipped game rejected mid-turn rules edits with a
 * timing 409, because live rules were frozen onto the runtime at start. In a
 * timed game the between-turns window is seconds long, so every rules sheet
 * was functionally read-only. The owner found it live: "Rules can only be
 * changed between turns is extremely hard to deal with because of the timers."
 *
 * The contract, tested against the REAL runtime (never handlers-in-isolation):
 *
 *  1. STAGE — `stageRulesPatch()` accepts a valid patch mid-phase, stores it on
 *     the runtime, broadcasts `game:rules.staged`, and does NOT touch the live
 *     rules. An invalid patch fails loudly NOW (RULES_VALIDATION_FAILED), not
 *     silently at the boundary.
 *  2. APPLY AT THE BOUNDARY — entering a phase named in the game's
 *     `applyStagedRules` list swaps the merged rules in BEFORE the phase's
 *     timers and channels resolve, broadcasts `game:rules.applied`, and clears
 *     the staged patch. Entering any other phase leaves it staged.
 *  3. PERSIST — the staged patch is part of the durable footprint the moment it
 *     is staged (not at the next transition), and a resumed runtime carries it
 *     until its boundary. A restart must not eat a saved-but-pending edit.
 *  4. INSTANT — `applyRulesPatch()` swaps rules immediately (for fields a game
 *     deliberately keeps instant — hotseat's dial-LOWERING kill switch), with a
 *     `silent` option preserving that path's no-announcement semantics.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { type GameDefinition, defineGame } from '../../src/defineGame';
import { GameError } from '../../src/errors';
import { createInMemoryReplayStore } from '../../src/lib/replay';
import {
  type PersistedRuntimeState,
  type SessionRuntime,
  advancePhase,
  applyRulesPatch,
  createSessionRuntime,
  destroySessionRuntime,
  stageRulesPatch,
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

const rulesSchema = z.object({
  timers: z
    .object({
      answerSeconds: z.number().int().min(5).max(120).default(30),
    })
    .prefault({}),
  win: z
    .object({
      target: z.number().int().min(1).default(5),
    })
    .prefault({}),
});

/**
 * A little turn game: `turn-intro` is the declared safe boundary, `answering`
 * reads `rules.timers.answerSeconds` for its phase timer — exactly the shape
 * every shipped game has.
 */
function makeGame(name: string): GameDefinition {
  return defineGame({
    name,
    display: 'Staged Rules',
    minPlayers: 1,
    maxPlayers: 4,
    rules: rulesSchema,
    sync: { mode: 'event' },
    applyStagedRules: ['turn-intro'],
    phases: {
      lobby: { next: 'turn-intro', advance: 'manual' },
      'turn-intro': { next: 'answering', advance: 'manual' },
      answering: {
        next: 'reveal',
        advance: 'timeout',
        timeout: ctx => Number((ctx.rules as any).timers.answerSeconds) * 1000,
      },
      // NOT a boundary: a patch staged during `answering` must ride through
      // `reveal` untouched and land at the next `turn-intro`.
      reveal: { next: 'turn-intro', advance: 'manual' },
    },
    handlers: {},
  });
}

async function boot(
  game: GameDefinition,
  options: {
    rules?: Record<string, unknown>;
    persistState?: (snapshot: PersistedRuntimeState) => Promise<void>;
    resume?: {
      currentPhase: string | null;
      currentRound: number;
      stagedRulesPatch?: Record<string, unknown> | null;
    };
    onRulesApplied?: (patch: Record<string, unknown>, rules: Record<string, unknown>) => void;
  } = {},
) {
  const activeRuntimes = new Map<string, SessionRuntime>();
  activeRuntimeMaps.push(activeRuntimes);
  const published: Array<{ room: string; message: any }> = [];

  const resolvedRules = game.rules.parse(options.rules ?? {}) as Record<string, unknown>;
  const runtime = await createSessionRuntime(
    'session-1',
    game,
    Object.freeze(resolvedRules),
    [makePlayer()],
    1234,
    {
      publish(room, message) {
        published.push({ room, message });
      },
      replayStore: createInMemoryReplayStore(),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      activeRuntimes,
      persistState: options.persistState,
      resume: options.resume,
      onRulesApplied: options.onRulesApplied as never,
    },
  );

  if (!runtime) throw new Error('Expected createSessionRuntime() to create a runtime.');
  return { runtime, published };
}

function messagesOfType(published: Array<{ room: string; message: any }>, type: string) {
  return published.filter(p => p.message?.type === type).map(p => p.message);
}

/** Remaining duration of the current phase timer, in ms. */
function phaseTimerDuration(runtime: SessionRuntime): number | null {
  const timerId = runtime.phaseState.phaseTimerId;
  if (!timerId) return null;
  const timer = runtime.timerState.timers.get(timerId);
  return timer ? timer.endsAt - timer.startedAt : null;
}

describe('staging a patch mid-phase', () => {
  test('accepts, broadcasts game:rules.staged, and does NOT change live rules', async () => {
    const { runtime, published } = await boot(makeGame('stage-basic'));
    await advancePhase(runtime); // lobby → turn-intro
    await advancePhase(runtime); // turn-intro → answering (mid-turn now)

    const staged = stageRulesPatch(runtime, { timers: { answerSeconds: 10 } });
    expect(staged).toEqual({ timers: { answerSeconds: 10 } });

    // (b) NOT live during the current turn.
    expect((runtime.rules as any).timers.answerSeconds).toBe(30);
    expect(runtime.stagedRulesPatch).toEqual({ timers: { answerSeconds: 10 } });

    // The room heard about it — the UI's "takes effect next turn" signal.
    const stagedMsgs = messagesOfType(published, 'game:rules.staged');
    expect(stagedMsgs.length).toBe(1);
    expect(stagedMsgs[0].patch).toEqual({ timers: { answerSeconds: 10 } });
    expect(stagedMsgs[0].appliesAtPhases).toEqual(['turn-intro']);
  });

  test('an INVALID patch throws RULES_VALIDATION_FAILED now, stages nothing', async () => {
    const { runtime, published } = await boot(makeGame('stage-invalid'));
    await advancePhase(runtime); // lobby → turn-intro

    expect(() => stageRulesPatch(runtime, { timers: { answerSeconds: 2 } })).toThrow(GameError);
    expect(runtime.stagedRulesPatch).toBeNull();
    expect(messagesOfType(published, 'game:rules.staged').length).toBe(0);
  });

  test('a second stage merges over the first (last write wins per section)', async () => {
    const { runtime } = await boot(makeGame('stage-merge'));
    await advancePhase(runtime); // lobby → turn-intro

    stageRulesPatch(runtime, { timers: { answerSeconds: 10 } });
    stageRulesPatch(runtime, { win: { target: 7 } });
    expect(runtime.stagedRulesPatch).toEqual({
      timers: { answerSeconds: 10 },
      win: { target: 7 },
    });
  });
});

describe('applying at the declared boundary', () => {
  test('the patch lands entering a boundary phase — and the NEXT phase timer uses it', async () => {
    const { runtime, published } = await boot(makeGame('apply-boundary'));
    await advancePhase(runtime); // lobby → turn-intro
    await advancePhase(runtime); // turn-intro → answering

    // Mid-turn edit: shorten the answer timer 30s → 10s.
    stageRulesPatch(runtime, { timers: { answerSeconds: 10 } });

    // Current turn still runs on the old rules: the live `answering` timer was
    // armed for 30s and stays armed for 30s.
    expect(phaseTimerDuration(runtime)).toBe(30_000);

    await advancePhase(runtime); // answering → reveal (NOT a boundary)
    expect((runtime.rules as any).timers.answerSeconds).toBe(30);
    expect(runtime.stagedRulesPatch).not.toBeNull();

    await advancePhase(runtime); // reveal → turn-intro (BOUNDARY — applies here)
    // (c) live on the next turn.
    expect((runtime.rules as any).timers.answerSeconds).toBe(10);
    expect(runtime.stagedRulesPatch).toBeNull();

    const appliedMsgs = messagesOfType(published, 'game:rules.applied');
    expect(appliedMsgs.length).toBe(1);
    expect(appliedMsgs[0].patch).toEqual({ timers: { answerSeconds: 10 } });
    expect(appliedMsgs[0].rules.timers.answerSeconds).toBe(10);
    expect(appliedMsgs[0].phase).toBe('turn-intro');

    // And the value is REAL, not decorative: the next answering phase arms its
    // timer from the new rules.
    await advancePhase(runtime); // turn-intro → answering
    expect(phaseTimerDuration(runtime)).toBe(10_000);
  });

  test('defineGame rejects an applyStagedRules entry that is not a phase', () => {
    expect(() =>
      defineGame({
        name: 'bad-boundary',
        display: 'x',
        minPlayers: 1,
        maxPlayers: 2,
        rules: z.object({}),
        applyStagedRules: ['no-such-phase'],
        phases: { only: { next: null, advance: 'manual' } },
        handlers: {},
      }),
    ).toThrow(/applyStagedRules/);
  });
});

describe('persistence — a saved edit must survive a restart', () => {
  test('staging persists the patch IMMEDIATELY, not at the next transition', async () => {
    const snapshots: PersistedRuntimeState[] = [];
    const { runtime } = await boot(makeGame('persist-stage'), {
      persistState: async snapshot => {
        snapshots.push(structuredClone(snapshot));
      },
    });
    await advancePhase(runtime); // lobby → turn-intro
    await advancePhase(runtime); // turn-intro → answering
    await new Promise(resolve => setTimeout(resolve, 10));
    const before = snapshots.length;

    stageRulesPatch(runtime, { timers: { answerSeconds: 15 } });
    await new Promise(resolve => setTimeout(resolve, 10));

    // A persist fired for the stage itself — a crash one second after "Saved —
    // takes effect next turn" must not eat the edit.
    expect(snapshots.length).toBeGreaterThan(before);
    const last = snapshots[snapshots.length - 1]!;
    expect(last.stagedRulesPatch).toEqual({ timers: { answerSeconds: 15 } });
    // Live rules in the same snapshot are still the old ones.
    expect((last.rules as any).timers.answerSeconds).toBe(30);
  });

  test('a resumed runtime carries the staged patch and applies it at its boundary', async () => {
    const { runtime, published } = await boot(makeGame('resume-staged'), {
      resume: {
        currentPhase: 'answering',
        currentRound: 2,
        stagedRulesPatch: { timers: { answerSeconds: 20 } },
      },
    });

    // Still staged after the restart, still not live.
    expect(runtime.stagedRulesPatch).toEqual({ timers: { answerSeconds: 20 } });
    expect((runtime.rules as any).timers.answerSeconds).toBe(30);

    await advancePhase(runtime); // answering → reveal
    await advancePhase(runtime); // reveal → turn-intro (boundary)
    expect((runtime.rules as any).timers.answerSeconds).toBe(20);
    expect(runtime.stagedRulesPatch).toBeNull();
    expect(messagesOfType(published, 'game:rules.applied').length).toBe(1);
  });

  test('applying at the boundary persists the NEW rules', async () => {
    const snapshots: PersistedRuntimeState[] = [];
    const { runtime } = await boot(makeGame('persist-apply'), {
      persistState: async snapshot => {
        snapshots.push(structuredClone(snapshot));
      },
    });
    await advancePhase(runtime); // lobby → turn-intro
    await advancePhase(runtime); // turn-intro → answering
    stageRulesPatch(runtime, { timers: { answerSeconds: 12 } });
    await advancePhase(runtime); // answering → reveal
    await advancePhase(runtime); // reveal → turn-intro (applies)
    await new Promise(resolve => setTimeout(resolve, 10));

    const last = snapshots[snapshots.length - 1]!;
    expect((last.rules as any).timers.answerSeconds).toBe(12);
    expect(last.stagedRulesPatch).toBeNull();
  });
});

describe('instant application — the kill-switch path stays instant', () => {
  test('applyRulesPatch swaps live rules immediately and broadcasts', async () => {
    const { runtime, published } = await boot(makeGame('instant'));
    await advancePhase(runtime); // lobby → turn-intro
    await advancePhase(runtime); // turn-intro → answering

    applyRulesPatch(runtime, { win: { target: 3 } });
    expect((runtime.rules as any).win.target).toBe(3);
    expect(messagesOfType(published, 'game:rules.applied').length).toBe(1);
  });

  test('silent: true applies without a broadcast (dial-LOWERING semantics)', async () => {
    const { runtime, published } = await boot(makeGame('instant-silent'));
    await advancePhase(runtime); // lobby → turn-intro

    applyRulesPatch(runtime, { win: { target: 2 } }, { silent: true });
    expect((runtime.rules as any).win.target).toBe(2);
    expect(messagesOfType(published, 'game:rules.applied').length).toBe(0);
  });

  test('every APPLY fires the server-side onRulesApplied signal — even silent ones', async () => {
    const applied: Array<Record<string, unknown>> = [];
    const { runtime } = await boot(makeGame('apply-signal'), {
      onRulesApplied: patch => {
        applied.push(patch);
      },
    });
    await advancePhase(runtime); // lobby → turn-intro
    await advancePhase(runtime); // turn-intro → answering

    // Silent instant apply: room hears nothing, the SERVER still must —
    // durable mirrors (a match row's rules snapshot) update either way.
    applyRulesPatch(runtime, { win: { target: 4 } }, { silent: true });
    expect(applied.length).toBe(1);
    expect(applied[0]).toEqual({ win: { target: 4 } });

    // Staged apply at the boundary fires it too.
    stageRulesPatch(runtime, { timers: { answerSeconds: 25 } });
    expect(applied.length).toBe(1); // staging alone is not an apply
    await advancePhase(runtime); // answering → reveal
    await advancePhase(runtime); // reveal → turn-intro (boundary)
    expect(applied.length).toBe(2);
    expect(applied[1]).toEqual({ timers: { answerSeconds: 25 } });
  });

  test('an invalid instant patch throws and leaves live rules untouched', async () => {
    const { runtime } = await boot(makeGame('instant-invalid'));
    await advancePhase(runtime);

    expect(() => applyRulesPatch(runtime, { win: { target: 0 } })).toThrow(GameError);
    expect((runtime.rules as any).win.target).toBe(5);
  });
});
