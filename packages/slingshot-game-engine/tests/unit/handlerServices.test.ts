/**
 * `ctx.services` must reach a game handler.
 *
 * ## The bug this pins
 *
 * `ProcessHandlerContext.services` is a getter over a late-bound accessor
 * (`getHookServices`). The type existed, the getter existed, the docs existed —
 * and **nothing ever supplied the accessor**. `buildHandlerDeps()` did not set it;
 * `SessionRuntime` had no field for it. So `ctx.services` was `undefined` in every
 * game, always, and **no game on this platform could resolve a framework
 * capability from a handler.**
 *
 * That is why hotseat's LLM never generated a single card in production. The AI
 * client was registered, booted and pre-warmed; the handler that had to *find* it
 * looked into an empty socket and silently dealt from the house deck. A feature
 * that was 100% documented and 0% wired.
 *
 * Hundreds of tests stayed green because every one of them called the generation
 * function DIRECTLY. None drove the handler that has to resolve the client. These
 * tests drive the REAL runtime, through `createSessionRuntime`, which is the same
 * path the plugin uses.
 *
 * The second test is as important as the first: with no accessor supplied,
 * `ctx.services` must stay `undefined`. `TestGameHarness` relies on that to keep
 * the engine sims hermetic, and games rely on it to take a no-credentials
 * fallback path in tests. The intent was always "undefined in the harness" — it
 * had merely become "undefined everywhere".
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { HookServices } from '@lastshotlabs/slingshot-core';
import { defineGame } from '../../src/defineGame';
import { createInMemoryReplayStore } from '../../src/lib/replay';
import { type SessionRuntime, createSessionRuntime } from '../../src/lib/sessionRuntime';
import type { GamePlayerState } from '../../src/types/models';

const base = {
  display: 'Services Probe',
  minPlayers: 1,
  maxPlayers: 4,
  rules: z.object({}),
  scoring: { mode: 'cumulative', display: { label: 'Score' } },
  sync: { mode: 'event' },
} as const;

function makePlayer(): GamePlayerState {
  return {
    userId: 'u1',
    displayName: 'Ana',
    role: null,
    team: null,
    playerState: null,
    score: 0,
    connected: true,
    isHost: true,
    isSpectator: false,
    joinOrder: 0,
  } as GamePlayerState;
}

/** A stand-in for the AI client — or any framework capability a real game needs. */
function fakeHookServices(answer: string): HookServices {
  return {
    capabilities: {
      require: () => ({ answer }),
      maybe: () => ({ answer }),
    },
    entities: { get: () => undefined },
  } as unknown as HookServices;
}

async function runWith(
  getHookServices: (() => HookServices | undefined) | undefined,
): Promise<{ sawServices: boolean; answer: string | null }> {
  const seen = { sawServices: false, answer: null as string | null };

  const game = defineGame({
    ...base,
    name: 'services-probe',
    phases: {
      // A phase that is a computation, not a wait — the exact shape of hotseat's
      // deck-prep, and exactly where it needed the capability.
      prep: { next: null, advance: 'manual', onEnter: 'prepEnter' },
    },
    handlers: {
      prepEnter: async (ctx: any) => {
        seen.sawServices = ctx.services !== undefined;
        const cap = ctx.services?.capabilities.maybe({} as never) as { answer: string } | undefined;
        seen.answer = cap?.answer ?? null;
      },
    },
  });

  const activeRuntimes = new Map<string, SessionRuntime>();
  await createSessionRuntime('sess-1', game, {}, [makePlayer()], 1234, {
    publish: () => {},
    replayStore: createInMemoryReplayStore(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    activeRuntimes,
    getHookServices,
  });

  return seen;
}

describe('ctx.services reaches a game handler', () => {
  test('a handler CAN resolve a capability when the runtime supplies services', async () => {
    const seen = await runWith(() => fakeHookServices('the-oracle-spoke'));
    expect(seen.sawServices).toBe(true);
    expect(seen.answer).toBe('the-oracle-spoke');
  });

  test('with NO accessor, ctx.services stays undefined — sims remain hermetic', async () => {
    const seen = await runWith(undefined);
    expect(seen.sawServices).toBe(false);
    expect(seen.answer).toBe(null);
  });
});
