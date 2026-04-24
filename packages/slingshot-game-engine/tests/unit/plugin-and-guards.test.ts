import { describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { defineGame } from '../../src/defineGame';
import { GameError, GameErrorCode } from '../../src/errors';
import { listAdapterRecords } from '../../src/lib/adapterQuery';
import {
  DEFAULT_CLEANUP_CONFIG,
  createCleanupState,
  isSessionExpired,
  runSweep,
  startCleanupSweep,
  stopCleanupSweep,
} from '../../src/lib/cleanup';
import { buildContentValidationGuard } from '../../src/middleware/contentValidationGuard';
import { buildHostOnlyGuard } from '../../src/middleware/hostOnlyGuard';
import { buildLobbyOnlyGuard } from '../../src/middleware/lobbyOnlyGuard';
import { buildPlayerJoinGuard } from '../../src/middleware/playerJoinGuard';
import { buildPlayerLeaveGuard } from '../../src/middleware/playerLeaveGuard';
import { buildRulesValidationGuard } from '../../src/middleware/rulesValidationGuard';
import { buildSessionCreateGuard } from '../../src/middleware/sessionCreateGuard';
import { buildStartGameGuard } from '../../src/middleware/startGameGuard';
import { ClientToServerMessageSchema, GameInputMessageSchema } from '../../src/validation/input';
import {
  SessionCreateInputSchema,
  SessionJoinByCodeInputSchema,
  SessionUpdateContentInputSchema,
} from '../../src/validation/session';

const gameDef = defineGame({
  name: 'plugin-test',
  display: 'Plugin Test',
  minPlayers: 2,
  maxPlayers: 4,
  allowSpectators: true,
  maxSpectators: 1,
  rules: z.object({
    rounds: z.number().int().min(1).default(3),
  }),
  presets: {
    speed: { rounds: 5 },
  },
  content: {
    required: false,
    schema: z.object({ deckId: z.string() }),
    providers: {
      deck: {
        inputSchema: z.object({ deckId: z.string().min(1) }),
        load: async () => ({ deckId: 'alpha' }),
      },
    },
  },
  phases: {
    lobby: { next: 'play', advance: 'manual' },
    play: { next: null, advance: 'manual' },
  },
  handlers: {},
});

function createContext(options: {
  params?: Record<string, string | undefined>;
  body?: unknown;
  values?: Record<string, unknown>;
}) {
  const params = options.params ?? {};
  const values = options.values ?? {};
  return {
    req: {
      param(name: string) {
        return params[name];
      },
      async json() {
        return options.body;
      },
    },
    get(name: string) {
      return values[name];
    },
  } as any;
}

describe('public plugin surface', () => {
  test('exports the public runtime entry points and validates plugin config', async () => {
    const mod = await import('../../src/index');

    expect(mod.GAME_ENGINE_PLUGIN_STATE_KEY).toBe('slingshot-game-engine');
    expect(mod.gameSessionFactories).toBeDefined();
    expect(mod.gamePlayerFactories).toBeDefined();
    expect(mod.GameEnginePluginConfigSchema.parse({})).toMatchObject({
      mountPath: '/game',
      wsEndpoint: 'game',
    });

    const plugin = mod.createGameEnginePlugin({ games: [gameDef] });
    expect(plugin.name).toBe('slingshot-game-engine');
    expect(plugin.dependencies).toContain('slingshot-auth');

    expect(() => mod.createGameEnginePlugin({ mountPath: 'game' as any })).toThrow();
  });
});

describe('adapter query and cleanup helpers', () => {
  test('reads records through find() and list()', async () => {
    await expect(
      listAdapterRecords(
        {
          find: async filter => [filter],
        },
        { sessionId: 'one' },
      ),
    ).resolves.toEqual([{ sessionId: 'one' }]);

    await expect(
      listAdapterRecords(
        {
          list: async () => ({ items: [{ sessionId: 'two' }] }),
        },
        { sessionId: 'two' },
      ),
    ).resolves.toEqual([{ sessionId: 'two' }]);
  });

  test('evaluates expiration windows and runs cleanup sweeps with archive support', async () => {
    const now = Date.parse('2026-04-19T12:00:00.000Z');
    const state = createCleanupState({ archive: true, completedTtl: 1000 });

    expect(state.config).toEqual({ ...DEFAULT_CLEANUP_CONFIG, archive: true, completedTtl: 1000 });
    expect(
      isSessionExpired(
        {
          id: 'completed',
          status: 'completed',
          completedAt: '2026-04-19T11:59:58.000Z',
          lastActivityAt: null,
          createdAt: '2026-04-19T11:50:00.000Z',
        },
        state.config,
        now,
      ),
    ).toBe(true);
    expect(
      isSessionExpired(
        {
          id: 'active',
          status: 'playing',
          completedAt: null,
          lastActivityAt: '2026-04-19T11:59:59.500Z',
          createdAt: '2026-04-19T11:50:00.000Z',
        },
        state.config,
        now,
      ),
    ).toBe(false);

    const archived: string[] = [];
    const deleted: string[] = [];
    const infos: string[] = [];
    const errors: string[] = [];

    await expect(
      runSweep(state, {
        async querySessions() {
          return [
            {
              id: 'completed',
              status: 'completed',
              completedAt: '2026-04-19T11:59:58.000Z',
              lastActivityAt: null,
              createdAt: '2026-04-19T11:50:00.000Z',
            },
          ];
        },
        async archiveSession(sessionId) {
          archived.push(sessionId);
        },
        async deleteSession(sessionId) {
          deleted.push(sessionId);
        },
        log: {
          info(message) {
            infos.push(message);
          },
          error(message) {
            errors.push(message);
          },
        },
      }),
    ).resolves.toEqual({ cleaned: 1, errors: 0 });

    expect(archived).toEqual(['completed']);
    expect(deleted).toEqual(['completed']);
    expect(infos[0]).toContain('Cleaned up session completed');
    expect(errors).toEqual([]);
  });

  test('starts and stops the cleanup timer and reports query failures', async () => {
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation((() => {
      return 123 as unknown as ReturnType<typeof setInterval>;
    }) as typeof globalThis.setInterval);
    const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    const state = createCleanupState({ sweepInterval: 500 });
    startCleanupSweep(state, {
      querySessions: async () => [],
      deleteSession: async () => {},
    });

    expect(state.running).toBe(true);
    expect(intervalSpy).toHaveBeenCalled();

    const errors: string[] = [];
    await expect(
      runSweep(state, {
        async querySessions() {
          throw new Error('db offline');
        },
        async deleteSession() {},
        log: {
          info() {},
          error(message) {
            errors.push(message);
          },
        },
      }),
    ).resolves.toEqual({ cleaned: 0, errors: 1 });

    expect(errors).toEqual(['Cleanup sweep failed to query sessions']);

    stopCleanupSweep(state);
    expect(state.running).toBe(false);
    expect(clearSpy).toHaveBeenCalledWith(123);

    intervalSpy.mockRestore();
    clearSpy.mockRestore();
  });
});

describe('validation schemas', () => {
  test('validates session and websocket payload contracts', () => {
    expect(
      SessionCreateInputSchema.parse({
        gameType: 'plugin-test',
        rules: { rounds: 4 },
        content: { provider: 'deck', input: { deckId: 'alpha' } },
      }),
    ).toEqual({
      gameType: 'plugin-test',
      rules: { rounds: 4 },
      content: { provider: 'deck', input: { deckId: 'alpha' } },
    });
    expect(SessionJoinByCodeInputSchema.parse({ code: 'ABCD' })).toEqual({ code: 'ABCD' });
    expect(SessionUpdateContentInputSchema.parse({ provider: 'deck' })).toEqual({
      provider: 'deck',
    });

    expect(
      GameInputMessageSchema.parse({
        type: 'game:input',
        sessionId: 'session-1',
        channel: 'buzz',
        data: { answer: 'A' },
        sequence: 3,
      }),
    ).toEqual({
      type: 'game:input',
      sessionId: 'session-1',
      channel: 'buzz',
      data: { answer: 'A' },
      sequence: 3,
    });
    expect(
      ClientToServerMessageSchema.parse({
        type: 'game:stream.subscribe',
        sessionId: 'session-1',
        channel: 'state',
      }),
    ).toEqual({
      type: 'game:stream.subscribe',
      sessionId: 'session-1',
      channel: 'state',
    });

    expect(() => SessionJoinByCodeInputSchema.parse({ code: 'oops' })).toThrow();
    expect(() => GameInputMessageSchema.parse({ type: 'game:input' })).toThrow();
  });
});

describe('rest middleware guards', () => {
  test('host and lobby guards enforce session ownership and status', async () => {
    const sessionAdapter = {
      async getById(id: string) {
        return id === 'missing'
          ? null
          : { id, hostUserId: 'host-user', status: id === 'lobby' ? 'lobby' : 'playing' };
      },
    };

    const next = mock(async () => {});

    await expect(
      buildHostOnlyGuard({ getSessionAdapter: () => sessionAdapter })(
        createContext({
          params: { id: 'session-1' },
          values: {
            actor: Object.freeze({
              id: 'host-user',
              kind: 'user',
              tenantId: null,
              sessionId: null,
              roles: null,
              claims: {},
            }),
          },
        }),
        next,
      ),
    ).resolves.toBeUndefined();
    expect(next).toHaveBeenCalled();

    await expect(
      buildHostOnlyGuard({ getSessionAdapter: () => sessionAdapter })(
        createContext({
          params: { id: 'session-1' },
          values: {
            actor: Object.freeze({
              id: 'guest-user',
              kind: 'user',
              tenantId: null,
              sessionId: null,
              roles: null,
              claims: {},
            }),
          },
        }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      buildLobbyOnlyGuard({ getSessionAdapter: () => sessionAdapter })(
        createContext({ params: { id: 'lobby' } }),
        async () => {},
      ),
    ).resolves.toBeUndefined();

    await expect(
      buildLobbyOnlyGuard({ getSessionAdapter: () => sessionAdapter })(
        createContext({ params: { id: 'session-1' } }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  test('rules and content guards validate update bodies against the resolved game definition', async () => {
    const adapter = {
      async getById() {
        return {
          id: 'session-1',
          gameType: 'plugin-test',
          rules: { rounds: 3 },
        };
      },
    };
    const registry = new Map([[gameDef.name, gameDef]]);

    await expect(
      buildRulesValidationGuard({
        getSessionAdapter: () => adapter,
        getRegistry: () => registry,
      })(
        createContext({
          params: { id: 'session-1' },
          body: { rules: { rounds: 5 } },
        }),
        async () => {},
      ),
    ).resolves.toBeUndefined();

    await expect(
      buildRulesValidationGuard({
        getSessionAdapter: () => adapter,
        getRegistry: () => registry,
      })(
        createContext({
          params: { id: 'session-1' },
          body: { rules: { rounds: 0 } },
        }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      buildContentValidationGuard({
        getSessionAdapter: () => adapter,
        getRegistry: () => registry,
      })(
        createContext({
          params: { id: 'session-1' },
          body: { contentProvider: 'deck', contentInput: { deckId: 'alpha' } },
        }),
        async () => {},
      ),
    ).resolves.toBeUndefined();

    await expect(
      buildContentValidationGuard({
        getSessionAdapter: () => adapter,
        getRegistry: () => registry,
      })(
        createContext({
          params: { id: 'session-1' },
          body: { contentProvider: 'missing' },
        }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('session creation resolves presets and start-game validates player counts', async () => {
    const body: Record<string, unknown> = {
      gameType: 'plugin-test',
      preset: 'speed',
      rules: { rounds: 7 },
      content: { provider: 'deck', input: { deckId: 'alpha' } },
    };

    await expect(
      buildSessionCreateGuard({
        getRegistry: () => new Map([[gameDef.name, gameDef]]),
      })(
        createContext({
          body,
          values: {
            actor: Object.freeze({
              id: 'host-user',
              kind: 'user',
              tenantId: null,
              sessionId: null,
              roles: null,
              claims: {},
            }),
          },
        }),
        async () => {},
      ),
    ).resolves.toBeUndefined();

    expect(body.hostUserId).toBe('host-user');
    expect(body.contentConfig).toEqual({ provider: 'deck', input: { deckId: 'alpha' } });
    expect(body.rules).toEqual({ rounds: 7 });
    expect(body.joinCode).toMatch(/^[A-Z2-9]{4}$/);

    await expect(
      buildStartGameGuard({
        getSessionAdapter: () => ({
          async getById() {
            return { id: 'session-1', gameType: 'plugin-test' };
          },
        }),
        getPlayerAdapter: () => ({
          async find(filter) {
            if (filter.sessionId === 'session-1') {
              return [{ userId: 'host-user', isSpectator: false }];
            }
            return [];
          },
        }),
        getRegistry: () => new Map([[gameDef.name, gameDef]]),
      })(createContext({ params: { id: 'session-1' } }), async () => {}),
    ).rejects.toBeInstanceOf(GameError);
  });

  test('player join and leave guards enforce capacity and transfer host ownership', async () => {
    const joinBody: Record<string, unknown> = {};
    const playerRows = [
      { id: 'p1', userId: 'host-user', isHost: true, isSpectator: false, joinOrder: 1 },
      { id: 'p2', userId: 'guest-user', isHost: false, isSpectator: false, joinOrder: 2 },
    ];
    const sessionUpdates: Array<Record<string, unknown>> = [];
    const playerUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];

    await expect(
      buildPlayerJoinGuard({
        getSessionAdapter: () => ({
          async getById() {
            return { id: 'session-1', gameType: 'plugin-test', status: 'lobby' };
          },
        }),
        getPlayerAdapter: () => ({
          async list(filter) {
            if (filter.userId === 'fresh-user') return [];
            if (filter.sessionId === 'session-1') return playerRows;
            return [];
          },
        }),
        getRegistry: () => new Map([[gameDef.name, gameDef]]),
      })(
        createContext({
          params: { id: 'session-1' },
          body: joinBody,
          values: {
            actor: Object.freeze({
              id: 'fresh-user',
              kind: 'user',
              tenantId: null,
              sessionId: null,
              roles: null,
              claims: {},
            }),
          },
        }),
        async () => {},
      ),
    ).resolves.toBeUndefined();

    expect(joinBody.sessionId).toBe('session-1');
    expect(joinBody.userId).toBe('fresh-user');
    expect(joinBody.joinOrder).toBe(2);

    await expect(
      buildPlayerLeaveGuard({
        getSessionAdapter: () => ({
          async getById() {
            return { id: 'session-1', hostUserId: 'host-user', status: 'lobby' };
          },
          async update(id, data) {
            sessionUpdates.push({ id, ...data });
            return null;
          },
        }),
        getPlayerAdapter: () => ({
          async list() {
            return playerRows;
          },
          async update(id, data) {
            playerUpdates.push({ id, data });
            return null;
          },
        }),
      })(
        createContext({
          params: { id: 'session-1', userId: 'host-user' },
        }),
        async () => {},
      ),
    ).resolves.toBeUndefined();

    expect(playerUpdates).toEqual([{ id: 'p2', data: { isHost: true } }]);
    expect(sessionUpdates).toEqual([{ id: 'session-1', hostUserId: 'guest-user' }]);
  });
});
