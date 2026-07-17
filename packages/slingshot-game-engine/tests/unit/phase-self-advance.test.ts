/**
 * Phase self-advance — a phase advancing from its own `onEnter`.
 *
 * This is how you express "this phase is a computation, not a wait": deck prep,
 * skip-if-not-applicable, terminal-condition checks. It used to be swallowed by
 * `advancePhase`'s reentrancy guard (`onEnter` runs *inside* `doAdvancePhase`,
 * so `advancing` is necessarily true) — silently: no throw, no log, the phase
 * just sat there until its timeout fired.
 *
 * Every test here drives the REAL runtime through `createSessionRuntime` /
 * `advancePhase`. Invoking handlers directly is exactly how a 124-test suite
 * stayed green through this bug, so none of these do that.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGame } from '../../src/defineGame';
import { createInMemoryReplayStore } from '../../src/lib/replay';
import {
  type SessionRuntime,
  advancePhase,
  createSessionRuntime,
  destroySessionRuntime,
} from '../../src/lib/sessionRuntime';
import type { GameDefinition } from '../../src/types/models';
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

/**
 * Boots a real runtime. `logErrors` collects anything the engine logs at error
 * level so a test can assert a failure was surfaced rather than swallowed.
 */
async function boot(game: GameDefinition) {
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
  });

  if (!runtime) throw new Error('Expected createSessionRuntime() to create a runtime.');
  return { runtime, logErrors };
}

/** A phase timeout long enough that any test waiting on it would time out first. */
const NEVER = 60_000;

const base = {
  display: 'Self Advance',
  minPlayers: 1,
  maxPlayers: 4,
  rules: z.object({}),
  scoring: { mode: 'cumulative', display: { label: 'Score' } },
  sync: { mode: 'event' },
} as const;

describe('phase self-advance from onEnter', () => {
  test('lands in the next phase without waiting for the phase timeout', async () => {
    const entered: string[] = [];

    const game = defineGame({
      ...base,
      name: 'self-advance-basic',
      phases: {
        lobby: { next: 'compute', advance: 'manual' },
        // A computation, not a wait. The 60s timeout must never be reached.
        compute: { next: 'play', advance: 'timeout', timeout: NEVER, onEnter: 'computeEnter' },
        play: { next: null, advance: 'manual', onEnter: 'playEnter' },
      },
      handlers: {
        computeEnter: (ctx: any): undefined => {
          entered.push('compute');
          ctx.advancePhase();
        },
        playEnter: (): undefined => {
          entered.push('play');
        },
      },
    });

    const { runtime } = await boot(game);
    expect(runtime.phaseState.currentPhase).toBe('lobby');

    await advancePhase(runtime);

    // Before the fix this was 'compute', stuck for a full 60 seconds.
    expect(runtime.phaseState.currentPhase).toBe('play');
    expect(entered).toEqual(['compute', 'play']);
    // The abandoned phase's timer was cancelled on the way out, not leaked.
    expect(runtime.timerState.timers.size).toBe(0);
  });

  test('a chain of self-advancing phases resolves in one transition', async () => {
    const entered: string[] = [];

    const game = defineGame({
      ...base,
      name: 'self-advance-chain',
      phases: {
        lobby: { next: 'a', advance: 'manual' },
        a: { next: 'b', advance: 'timeout', timeout: NEVER, onEnter: 'hop' },
        b: { next: 'c', advance: 'timeout', timeout: NEVER, onEnter: 'hop' },
        c: { next: null, advance: 'manual', onEnter: 'land' },
      },
      handlers: {
        hop: (ctx: any): undefined => {
          entered.push(ctx.currentPhase);
          ctx.advancePhase();
        },
        land: (ctx: any): undefined => {
          entered.push(ctx.currentPhase);
        },
      },
    });

    const { runtime } = await boot(game);
    await advancePhase(runtime);

    expect(runtime.phaseState.currentPhase).toBe('c');
    expect(entered).toEqual(['a', 'b', 'c']);
  });

  test('pairs with setNextPhase — the self-advance honors the phase onEnter chose', async () => {
    const game = defineGame({
      ...base,
      name: 'self-advance-router',
      phases: {
        lobby: { next: 'router', advance: 'manual' },
        // Static `next` says fallback; onEnter routes to target instead.
        router: { next: 'fallback', advance: 'timeout', timeout: NEVER, onEnter: 'route' },
        target: { next: null, advance: 'manual' },
        fallback: { next: null, advance: 'manual' },
      },
      handlers: {
        route: (ctx: any): undefined => {
          ctx.setNextPhase('target');
          ctx.advancePhase();
        },
      },
    });

    const { runtime } = await boot(game);
    await advancePhase(runtime);

    expect(runtime.phaseState.currentPhase).toBe('target');
  });

  test('the session’s FIRST phase may self-advance from its own onEnter', async () => {
    const game = defineGame({
      ...base,
      name: 'self-advance-first',
      phases: {
        // Entered by createSessionRuntime, outside any advancePhase call.
        boot: { next: 'lobby', advance: 'timeout', timeout: NEVER, onEnter: 'bootEnter' },
        lobby: { next: null, advance: 'manual' },
      },
      handlers: {
        bootEnter: (ctx: any): undefined => {
          ctx.advancePhase();
        },
      },
    });

    const { runtime } = await boot(game);

    expect(runtime.phaseState.currentPhase).toBe('lobby');
    expect(runtime.timerState.timers.size).toBe(0);
  });

  test('a self-advance cycle fails loudly, naming the phases', async () => {
    const game = defineGame({
      ...base,
      name: 'self-advance-cycle',
      phases: {
        lobby: { next: 'ping', advance: 'manual' },
        ping: { next: 'pong', advance: 'manual', onEnter: 'bounce' },
        pong: { next: 'ping', advance: 'manual', onEnter: 'bounce' },
      },
      handlers: {
        // A → B → A forever. Without a bound this spins the event loop dead.
        bounce: (ctx: any): undefined => {
          ctx.advancePhase();
        },
      },
    });

    const { runtime } = await boot(game);

    const advance = advancePhase(runtime);
    await expect(advance).rejects.toThrow(/self-advance cycle/i);
    await advance.catch((error: unknown) => {
      const message = (error as Error).message;
      expect(message).toContain('self-advance-cycle');
      expect(message).toContain('ping');
      expect(message).toContain('pong');
    });

    // The guard is released, so the session is not wedged.
    expect(runtime.advancing).toBe(false);
    expect(runtime.pendingSelfAdvance).toBe(false);
  });

  test('a phase that both self-advances and has a timeout does not double-advance', async () => {
    const entered: string[] = [];

    const game = defineGame({
      ...base,
      name: 'self-advance-no-double',
      phases: {
        lobby: { next: 'compute', advance: 'manual' },
        // Short timeout: if the timer leaked past the self-advance it would fire
        // during the wait below and push us out of `play` into game-over.
        compute: { next: 'play', advance: 'timeout', timeout: 40, onEnter: 'computeEnter' },
        play: { next: null, advance: 'manual', onEnter: 'playEnter' },
      },
      handlers: {
        computeEnter: (ctx: any): undefined => {
          entered.push('compute');
          // Called twice on purpose — one advance, not two.
          ctx.advancePhase();
          ctx.advancePhase();
        },
        playEnter: (): undefined => {
          entered.push('play');
        },
      },
    });

    const { runtime, logErrors } = await boot(game);
    await advancePhase(runtime);

    expect(runtime.phaseState.currentPhase).toBe('play');
    expect(entered).toEqual(['compute', 'play']);

    await new Promise(resolve => setTimeout(resolve, 120));

    // Still in play: the abandoned timer never fired, and the doubled
    // ctx.advancePhase() collapsed into a single advance.
    expect(runtime.phaseState.currentPhase).toBe('play');
    expect(entered).toEqual(['compute', 'play']);
    expect(logErrors).toEqual([]);
  });
});

describe('the reentrancy guard still drops racing external advances', () => {
  test('an external advance during an in-flight transition is dropped, not replayed', async () => {
    const entered: string[] = [];
    let inSlowOnEnter: (() => void) | null = null;
    const reachedSlow = new Promise<void>(resolve => {
      inSlowOnEnter = resolve;
    });

    const game = defineGame({
      ...base,
      name: 'guard-regression',
      phases: {
        lobby: { next: 'slow', advance: 'manual' },
        // An async onEnter: the transition is genuinely in flight across an await,
        // which is the only window in which an external advance can race it.
        slow: { next: 'play', advance: 'manual', onEnter: 'slowEnter' },
        play: { next: null, advance: 'manual', onEnter: 'playEnter' },
      },
      handlers: {
        slowEnter: async () => {
          entered.push('slow');
          inSlowOnEnter?.();
          await new Promise(resolve => setTimeout(resolve, 40));
        },
        playEnter: (): undefined => {
          entered.push('play');
        },
      },
    });

    const { runtime } = await boot(game);

    const inFlight = advancePhase(runtime);
    await reachedSlow;

    // A host taps "next" (or a stale timeout fires) while we are still entering
    // `slow`. That request was aimed at the phase we already left; honoring it
    // would skip `slow` entirely. It must be dropped — this is the double-advance
    // the reentrancy guard exists to prevent, and the self-advance fix must not
    // reintroduce it.
    expect(runtime.advancing).toBe(true);
    await advancePhase(runtime);

    await inFlight;

    expect(runtime.phaseState.currentPhase).toBe('slow');
    expect(entered).toEqual(['slow']);
  });
});
