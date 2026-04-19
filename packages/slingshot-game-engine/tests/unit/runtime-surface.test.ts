import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { GameErrorCode } from '../../src/errors';
import { loadContent } from '../../src/lib/content';
import {
  acquireLease,
  createLeaseState,
  getLeaseHolder,
  isLeaseOwner,
  releaseAllLeases,
  releaseLease,
} from '../../src/lib/sessionLease';
import {
  deserializeMap,
  deserializeSet,
  serializeGameState,
  serializeMap,
  serializeSet,
} from '../../src/lib/serialize';
import { gameEngineManifest } from '../../src/manifest/gameEngineManifest';
import { createGameEngineManifestRuntime } from '../../src/manifest/runtime';
import {
  LobbyUpdateInputSchema,
  PlayerKickInputSchema,
  PlayerRoleAssignInputSchema,
  PlayerTeamAssignInputSchema,
} from '../../src/validation/player';
import { buildWsHostOnlyGuard } from '../../src/ws/hostOnly';

afterEach(() => {
  mock.restore();
});

describe('loadContent', () => {
  test('enforces required content and validates custom payloads against the game schema', async () => {
    const gameDef = {
      content: {
        required: true,
        schema: z.object({ rounds: z.number().int().positive() }),
      },
    } as any;

    await expect(loadContent(gameDef, null)).rejects.toMatchObject({
      code: GameErrorCode.CONTENT_LOAD_FAILED,
    });

    const resolved = await loadContent(gameDef, {
      provider: 'custom',
      data: { rounds: 3 },
    });

    expect(resolved).toEqual({ provider: 'custom', data: { rounds: 3 } });
    expect(Object.isFrozen(resolved?.data)).toBe(true);

    await expect(
      loadContent(gameDef, {
        provider: 'custom',
        data: { rounds: 0 },
      }),
    ).rejects.toMatchObject({
      code: GameErrorCode.CONTENT_VALIDATION_FAILED,
    });
  });

  test('validates named providers, freezes resolved content, and surfaces provider failures', async () => {
    const load = mock(async (input: unknown) => ({ prompt: `deck:${String((input as any).deckId)}` }));
    const validate = mock((data: unknown) => (data as { prompt: string }).prompt.length > 5);
    const gameDef = {
      content: {
        required: false,
        schema: z.object({ prompt: z.string().min(5) }),
        providers: {
          deck: {
            inputSchema: z.object({ deckId: z.string().min(1) }),
            load,
            validate,
          },
          broken: {
            load: async () => {
              throw new Error('upstream unavailable');
            },
          },
        },
      },
    } as any;

    const resolved = await loadContent(gameDef, {
      provider: 'deck',
      input: { deckId: 'alpha' },
    });

    expect(load).toHaveBeenCalledWith({ deckId: 'alpha' });
    expect(validate).toHaveBeenCalledWith({ prompt: 'deck:alpha' });
    expect(resolved).toEqual({ provider: 'deck', data: { prompt: 'deck:alpha' } });
    expect(Object.isFrozen(resolved?.data)).toBe(true);

    await expect(loadContent(gameDef, { provider: 'deck', input: {} })).rejects.toMatchObject({
      code: GameErrorCode.CONTENT_VALIDATION_FAILED,
    });

    await expect(loadContent(gameDef, { provider: 'missing' })).rejects.toMatchObject({
      code: GameErrorCode.CONTENT_PROVIDER_NOT_FOUND,
    });

    await expect(loadContent(gameDef, { provider: 'broken' })).rejects.toMatchObject({
      code: GameErrorCode.CONTENT_LOAD_FAILED,
    });
  });
});

describe('serialize helpers', () => {
  test('round-trips maps and sets and deep-serializes nested game state', () => {
    const originalMap = new Map<string, number>([
      ['alice', 10],
      ['bob', 20],
    ]);
    const originalSet = new Set(['lobby', 'play']);

    expect(serializeMap(originalMap)).toEqual({ alice: 10, bob: 20 });
    expect([...deserializeMap({ alice: 10, bob: 20 }).entries()]).toEqual([
      ['alice', 10],
      ['bob', 20],
    ]);
    expect(serializeSet(originalSet)).toEqual(['lobby', 'play']);
    expect([...deserializeSet(['lobby', 'play'])]).toEqual(['lobby', 'play']);

    const state = serializeGameState({
      scoreboard: new Map([
        ['alice', { points: 3, badges: new Set(['fastest']) }],
        ['bob', { points: 1, badges: new Set(['survivor']) }],
      ]),
      history: [new Set(['round-1'])],
    });

    expect(state).toEqual({
      scoreboard: {
        alice: { points: 3, badges: ['fastest'] },
        bob: { points: 1, badges: ['survivor'] },
      },
      history: [['round-1']],
    });
  });
});

describe('session leases', () => {
  test('tracks ownership in single-instance mode without an adapter', async () => {
    const state = createLeaseState('instance-a');

    expect(await acquireLease(state, 'session-1')).toBe(true);
    expect(isLeaseOwner(state, 'session-1')).toBe(true);
    expect(await getLeaseHolder(state, 'session-1')).toBe('instance-a');

    await releaseLease(state, 'session-1');

    expect(isLeaseOwner(state, 'session-1')).toBe(false);
    expect(await getLeaseHolder(state, 'session-1')).toBeNull();
  });

  test('renews adapter-backed leases, detects lease loss, and releases all owned sessions', async () => {
    const intervalCallbacks: Array<() => Promise<void> | void> = [];
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof globalThis.setInterval);
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    const acquireOrRenew = mock(async () => acquireOrRenew.mock.calls.length < 2);
    const release = mock(async () => true);
    const getHolder = mock(async () => 'instance-a');
    const state = createLeaseState(
      'instance-a',
      { acquireOrRenew, release, getHolder },
      30_000,
      15_000,
    );
    const lost: string[] = [];

    expect(await acquireLease(state, 'session-1', sessionId => lost.push(sessionId))).toBe(true);
    expect(state.renewalHandles.size).toBe(1);

    await intervalCallbacks[0]?.();

    expect(lost).toEqual(['session-1']);
    expect(isLeaseOwner(state, 'session-1')).toBe(false);
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(await getLeaseHolder(state, 'session-2')).toBe('instance-a');

    acquireOrRenew.mockImplementation(async () => true);
    await acquireLease(state, 'session-2');
    await releaseAllLeases(state);

    expect(release).toHaveBeenCalledWith('session-2', 'instance-a');
    expect(state.ownedSessions.size).toBe(0);

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});

describe('manifest/runtime wiring', () => {
  test('declares game entities and captures adapters through the manifest hook registry', async () => {
    expect(gameEngineManifest.manifestVersion).toBe(1);
    expect(gameEngineManifest.namespace).toBe('game');
    expect(gameEngineManifest.hooks?.afterAdapters).toEqual([{ handler: 'game.captureAdapters' }]);
    expect(Object.keys(gameEngineManifest.entities)).toEqual(['GameSession', 'GamePlayer']);

    let captured: { sessionAdapter: unknown; playerAdapter: unknown } | null = null;
    const runtime = createGameEngineManifestRuntime({
      onAdaptersCaptured(adapters) {
        captured = adapters;
      },
    });

    expect(runtime.customHandlers.list()).toEqual([]);
    const hook = runtime.hooks.resolve('game.captureAdapters');

    await hook({
      app: {} as any,
      bus: {} as any,
      pluginName: 'game-engine',
      adapters: {
        GameSession: { kind: 'session' } as any,
        GamePlayer: { kind: 'player' } as any,
      },
      permissions: null,
    });

    expect(captured).toEqual({
      sessionAdapter: { kind: 'session' },
      playerAdapter: { kind: 'player' },
    });
  });
});

describe('player validation and ws host-only guard', () => {
  test('applies defaults and validates lobby/player payloads', () => {
    expect(PlayerKickInputSchema.parse({})).toEqual({ ban: false });
    expect(PlayerTeamAssignInputSchema.parse({ team: 'red' })).toEqual({ team: 'red' });
    expect(PlayerRoleAssignInputSchema.parse({ role: 'spectator' })).toEqual({
      role: 'spectator',
    });
    expect(
      LobbyUpdateInputSchema.parse({
        rules: { rounds: 5 },
        preset: 'speed',
        content: { provider: 'deck', input: { difficulty: 'hard' } },
      }),
    ).toEqual({
      rules: { rounds: 5 },
      preset: 'speed',
      content: { provider: 'deck', input: { difficulty: 'hard' } },
    });

    expect(() => PlayerRoleAssignInputSchema.parse({ role: 'admin' })).toThrow();
    expect(() => LobbyUpdateInputSchema.parse({ content: { provider: '' } })).toThrow();
  });

  test('acks host-only websocket actions when the caller is not the host', async () => {
    const acknowledgements: unknown[] = [];
    const guard = buildWsHostOnlyGuard({
      isHost: async (_sessionId, userId) => userId === 'host-user',
    });

    expect(await guard('session-1', 'host-user', ack => acknowledgements.push(ack))).toBe(true);
    expect(await guard('session-1', 'guest-user', ack => acknowledgements.push(ack))).toBe(false);
    expect(acknowledgements).toEqual([
      {
        type: 'game:error',
        sessionId: 'session-1',
        code: GameErrorCode.HOST_ONLY,
        message: 'Only the host can perform this action.',
      },
    ]);
  });
});
