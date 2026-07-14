/**
 * Channel input reaches the process handler with schema `.default()`s applied,
 * and a throwing handler is surfaced, not swallowed.
 *
 * The bug this pins: `processInputPipeline` validated input with `safeParse`
 * (which applies defaults) but then forwarded the RAW wire object to the
 * process handler. A channel field declared `.default([])` therefore arrived
 * `undefined`, a handler that read it threw, and the throw propagated out of the
 * pipeline with no ack and no log — the player tapped the button and the phase
 * hung until timeout. It was invisible to every test that called handlers
 * directly rather than driving `processInputPipeline`, which is why these tests
 * drive the real pipeline and assert on the returned ack + runtime observations.
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
  processInputPipeline,
} from '../../src/lib/sessionRuntime';
import type { GamePlayerState, ProcessHandlerContext } from '../../src/types/models';

const activeRuntimeMaps: Array<Map<string, SessionRuntime>> = [];
const loggedErrors: Array<{ message: string; data?: unknown }> = [];

afterEach(() => {
  for (const activeRuntimes of activeRuntimeMaps.splice(0)) {
    for (const sessionId of [...activeRuntimes.keys()]) {
      destroySessionRuntime(activeRuntimes, sessionId);
    }
  }
  loggedErrors.length = 0;
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

/** Captures what the process handler actually received, for assertions. */
const seen: { data: unknown } = { data: undefined };

/**
 * A channel whose schema has an optional-with-default field — the exact shape
 * (`dossierEntry.facts`) that surfaced the bug. `collect` and `race` modes both
 * flow through the single Step-9 handler dispatch, so testing one mode plus a
 * mode-crossing case is sufficient; the pipeline does not branch by mode there.
 */
const defaultedSchema = z.object({
  facts: z.array(z.string()).default([]),
  note: z.string().default('unset'),
});

function buildGame() {
  return defineGame({
    name: 'defaults-test',
    display: 'Defaults Test',
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
          submit: {
            mode: 'collect' as const,
            from: 'all-players' as const,
            relay: 'none' as const,
            schema: defaultedSchema,
            process: 'onSubmit',
          },
          race: {
            mode: 'race' as const,
            from: 'all-players' as const,
            relay: 'none' as const,
            schema: defaultedSchema,
            process: 'onRace',
          },
          boom: {
            mode: 'collect' as const,
            from: 'all-players' as const,
            relay: 'none' as const,
            schema: z.object({ x: z.number().default(0) }),
            process: 'onBoom',
          },
        },
      },
    },
    handlers: {
      // Reads the defaulted fields directly — throws if they are undefined,
      // which is precisely how the original bug manifested. Params are `unknown`
      // to match `HandlerFunction`'s `(ctx, ...args: unknown[])` signature.
      onSubmit(_ctx: ProcessHandlerContext, ...args: unknown[]): undefined {
        const d = args[1] as { facts: string[]; note: string };
        seen.data = { factsLength: d.facts.length, note: d.note };
        return undefined;
      },
      onRace(_ctx: ProcessHandlerContext, ...args: unknown[]): undefined {
        const d = args[1] as { facts: string[]; note: string };
        seen.data = { factsLength: d.facts.length, note: d.note };
        return undefined;
      },
      onBoom() {
        throw new Error('handler exploded on purpose');
      },
    },
  });
}

async function createHarness() {
  const activeRuntimes = new Map<string, SessionRuntime>();
  activeRuntimeMaps.push(activeRuntimes);
  seen.data = undefined;

  const runtime = await createSessionRuntime('session-1', buildGame(), {}, [makePlayer()], 1234, {
    publish() {},
    replayStore: createInMemoryReplayStore(),
    log: {
      debug() {},
      info() {},
      warn() {},
      // Capture rather than throw — the handler-error test needs to observe it.
      error(message: string, data?: unknown): void {
        loggedErrors.push({ message, data });
      },
    },
    activeRuntimes,
  });

  if (!runtime) throw new Error('Expected createSessionRuntime() to create a runtime.');
  // lobby → play opens the channels.
  await advancePhase(runtime);
  return runtime;
}

describe('channel input schema defaults', () => {
  test('a defaulted field omitted from the payload reaches the handler as its default', async () => {
    const runtime = await createHarness();

    const ack = await processInputPipeline(runtime, 'submit', 'host-user', {}, 1);

    expect(ack.accepted).toBeTrue();
    // The handler ran and saw the defaults, not `undefined` (which would have thrown).
    expect(seen.data).toEqual({ factsLength: 0, note: 'unset' });
    expect(loggedErrors).toHaveLength(0);
  });

  test('a provided field is preserved while the sibling default fills in', async () => {
    const runtime = await createHarness();

    const ack = await processInputPipeline(
      runtime,
      'submit',
      'host-user',
      { facts: ['a', 'b'] },
      1,
    );

    expect(ack.accepted).toBeTrue();
    expect(seen.data).toEqual({ factsLength: 2, note: 'unset' });
  });

  test('defaults are applied on a second channel mode too (race)', async () => {
    const runtime = await createHarness();

    const ack = await processInputPipeline(runtime, 'race', 'host-user', {}, 1);

    expect(ack.accepted).toBeTrue();
    expect(seen.data).toEqual({ factsLength: 0, note: 'unset' });
  });
});

describe('process handler errors are surfaced, not swallowed', () => {
  test('a throwing handler is logged and nacked instead of vanishing', async () => {
    const runtime = await createHarness();

    const ack = await processInputPipeline(runtime, 'boom', 'host-user', {}, 1);

    // The client is told it failed rather than left waiting on silence.
    expect(ack.accepted).toBeFalse();
    expect(ack.code).toBe('HANDLER_ERROR');

    // And the failure is loud: one error log naming the handler, with the cause.
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]!.message).toContain('onBoom');
    expect(loggedErrors[0]!.message).toContain('boom');
    expect((loggedErrors[0]!.data as Error)?.message).toContain('handler exploded on purpose');
  });
});
