/**
 * Game engine plugin route registration.
 *
 * Extracted from plugin.ts for maintainability. Contains the Game Registry
 * routes (types listing, detail, rules-schema) and the Session routes
 * (join-by-code, runtime state view, replay log).
 *
 * @internal — not exported from the package public API.
 */
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { getActorId } from '@lastshotlabs/slingshot-core';
import { GameErrorCode } from './errors';
import { listAdapterRecords } from './lib/adapterQuery';
import { extractRulesDefaults } from './lib/rules';
import { computeLeaderboard } from './lib/scoring';
import type { SessionRuntime } from './lib/sessionRuntime';
import type { ReplayStore } from './types/adapters';
import type { GameDefinition } from './types/models';

/** Minimal session adapter shape used by routes. */
export interface SessionAdapterShape {
  getById(id: string): Promise<Record<string, unknown> | null>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
  find?(filter: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  list?(filter: Record<string, unknown>): Promise<unknown>;
}

/** Minimal player adapter shape used by routes. */
export interface PlayerAdapterShape {
  find?(filter: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  list?(filter: Record<string, unknown>): Promise<unknown>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
  create?(data: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Dependencies injected into route registration. */
export interface PluginRouteDeps {
  mountPath: string;
  gameRegistry: ReadonlyMap<string, GameDefinition>;
  activeRuntimes: Map<string, SessionRuntime>;
  replayStore: ReplayStore;
  getSessionAdapter: () => SessionAdapterShape;
  getPlayerAdapter: () => PlayerAdapterShape;
}

/**
 * Register game registry routes at `{mountPath}/types`.
 *
 * @internal
 */
export function mountGameRegistryRoutes(app: Hono<AppEnv>, deps: PluginRouteDeps): void {
  const { mountPath, gameRegistry } = deps;
  const registryRoutes = new Hono<AppEnv>();

  registryRoutes.get('/', c => {
    const tagsParam = c.req.query('tags');
    const filterTags = tagsParam ? tagsParam.split(',').map(t => t.trim()) : null;

    const games: Array<Record<string, unknown>> = [];
    for (const def of gameRegistry.values()) {
      if (filterTags && !filterTags.some(t => def.tags.includes(t))) {
        continue;
      }
      games.push({
        name: def.name,
        display: def.display,
        description: def.description || null,
        version: def.version || null,
        icon: def.icon || null,
        tags: [...def.tags],
        minPlayers: def.minPlayers,
        maxPlayers: def.maxPlayers,
        allowSpectators: def.allowSpectators,
      });
    }
    return c.json({ games });
  });

  registryRoutes.get('/:name', c => {
    const name = c.req.param('name');
    const def = gameRegistry.get(name);
    if (!def) {
      return c.json(
        { error: { code: GameErrorCode.GAME_TYPE_NOT_FOUND, message: 'Game type not found.' } },
        404,
      );
    }

    const roles =
      Object.keys(def.roles).length > 0
        ? Object.fromEntries(
            Object.entries(def.roles).map(([k, v]) => [
              k,
              {
                display: v.display ?? k,
                count: typeof v.count === 'function' ? 'dynamic' : v.count,
              },
            ]),
          )
        : null;

    const teams = def.teams
      ? {
          count: typeof def.teams.count === 'function' ? 'dynamic' : def.teams.count,
          names: def.teams.names ?? null,
          assignmentMode: def.teams.assignment,
        }
      : null;

    const presets = Object.keys(def.presets).length > 0 ? def.presets : null;
    const contentProviders = def.content?.providers ? Object.keys(def.content.providers) : [];
    const rulesDefaults = extractRulesDefaults(def.rules);

    return c.json({
      name: def.name,
      display: def.display,
      description: def.description || null,
      version: def.version || null,
      icon: def.icon || null,
      tags: [...def.tags],
      minPlayers: def.minPlayers,
      maxPlayers: def.maxPlayers,
      allowSpectators: def.allowSpectators,
      maxSpectators: def.maxSpectators,
      roles,
      teams,
      presets,
      contentProviders,
      rulesSchema: def.rules,
      rulesDefaults,
    });
  });

  registryRoutes.get('/:name/rules-schema', c => {
    const name = c.req.param('name');
    const def = gameRegistry.get(name);
    if (!def) {
      return c.json(
        { error: { code: GameErrorCode.GAME_TYPE_NOT_FOUND, message: 'Game type not found.' } },
        404,
      );
    }

    const defaults = extractRulesDefaults(def.rules);
    const presets =
      Object.keys(def.presets).length > 0
        ? Object.fromEntries(Object.entries(def.presets).map(([k, v]) => [k, v]))
        : null;

    return c.json({
      schema: def.rules,
      defaults,
      presets,
    });
  });

  app.route(`${mountPath}/types`, registryRoutes);
}

/**
 * Register session routes at `{mountPath}/sessions`.
 *
 * @internal
 */
export function mountGameSessionRoutes(app: Hono<AppEnv>, deps: PluginRouteDeps): void {
  const {
    mountPath,
    gameRegistry,
    activeRuntimes,
    replayStore,
    getSessionAdapter,
    getPlayerAdapter,
  } = deps;
  const sessionRoutes = new Hono<AppEnv>();

  // POST /game/sessions/join/:code — join by code
  sessionRoutes.post('/join/:code', async c => {
    const code = c.req.param('code');
    const userId = getActorId(c);

    if (!userId) {
      return c.json(
        { error: { code: GameErrorCode.UNAUTHORIZED, message: 'Authentication required.' } },
        401,
      );
    }

    const adapter = getSessionAdapter();
    const sessions = adapter.find ? await adapter.find({ joinCode: code }) : [];
    const session = sessions.at(0) ?? null;

    if (!session) {
      return c.json(
        { error: { code: GameErrorCode.SESSION_NOT_FOUND, message: 'Session not found.' } },
        404,
      );
    }

    if (session.status !== 'lobby') {
      return c.json(
        {
          error: {
            code: GameErrorCode.SESSION_NOT_IN_LOBBY,
            message: 'Session is not in lobby.',
          },
        },
        409,
      );
    }

    const pAdapter = getPlayerAdapter();
    const existingPlayers = await listAdapterRecords(pAdapter, {
      sessionId: session.id as string,
    });

    if (existingPlayers.some(p => p.userId === userId)) {
      return c.json(
        {
          error: {
            code: GameErrorCode.PLAYER_ALREADY_IN_SESSION,
            message: 'Already in session.',
          },
        },
        409,
      );
    }

    const gameDef = gameRegistry.get(session.gameType as string);

    if (gameDef && existingPlayers.length >= gameDef.maxPlayers) {
      return c.json(
        { error: { code: GameErrorCode.SESSION_FULL, message: 'Session is full.' } },
        409,
      );
    }

    const bannedUsers = (session.bannedUsers as string[] | undefined) ?? [];
    if (bannedUsers.includes(userId)) {
      return c.json(
        {
          error: {
            code: GameErrorCode.PLAYER_BANNED,
            message: 'You are banned from this session.',
          },
        },
        409,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const asSpectator = body.asSpectator === true;

    if (asSpectator && gameDef) {
      const currentSpectators = existingPlayers.filter(p => p.isSpectator === true);
      if (currentSpectators.length >= gameDef.maxSpectators) {
        return c.json(
          {
            error: {
              code: GameErrorCode.SESSION_SPECTATORS_FULL,
              message: 'Spectator slots full.',
            },
          },
          409,
        );
      }
    }

    if (pAdapter.create) {
      await pAdapter.create({
        sessionId: session.id as string,
        userId,
        displayName: userId,
        isSpectator: asSpectator,
        isHost: false,
        score: 0,
        connected: true,
        joinOrder: existingPlayers.length + 1,
      });
    }

    const allPlayers = await listAdapterRecords(pAdapter, {
      sessionId: session.id as string,
    });
    return c.json({
      sessionId: session.id,
      joinCode: session.joinCode,
      gameType: session.gameType,
      status: session.status,
      hostUserId: session.hostUserId,
      rules: session.rules ?? {},
      currentPhase: session.currentPhase ?? null,
      currentSubPhase: session.currentSubPhase ?? null,
      currentRound: session.currentRound ?? 0,
      gameState: {},
      privateState: null,
      players: allPlayers.map(p => ({
        userId: p.userId,
        displayName: p.displayName,
        builtInRole: p.isHost ? 'host' : p.isSpectator ? 'spectator' : 'player',
        gameRole: p.role ?? null,
        team: p.team ?? null,
        playerState: p.playerState ?? null,
        isConnected: p.connected ?? true,
        score: p.score ?? 0,
        joinedAt: p.joinedAt,
      })),
      activeChannels: [],
      phaseEndsAt: null,
      winResult: session.winResult ?? null,
      createdAt: session.createdAt,
      startedAt: session.startedAt ?? null,
      completedAt: session.completedAt ?? null,
    });
  });

  // GET /game/sessions/:id/state — runtime state view
  sessionRoutes.get('/:id/state', async c => {
    const sessionId = c.req.param('id');
    const userId = getActorId(c);

    if (!userId) {
      return c.json(
        { error: { code: GameErrorCode.UNAUTHORIZED, message: 'Authentication required.' } },
        401,
      );
    }

    const runtime = activeRuntimes.get(sessionId);
    if (!runtime) {
      const adapter = getSessionAdapter();
      const session = await adapter.getById(sessionId);
      if (!session) {
        return c.json(
          { error: { code: GameErrorCode.SESSION_NOT_FOUND, message: 'Session not found.' } },
          404,
        );
      }
      return c.json({
        gameState: session.gameState ?? {},
        privateState: null,
        currentPhase: session.currentPhase ?? null,
        currentSubPhase: session.currentSubPhase ?? null,
        currentRound: session.currentRound ?? 0,
        phaseEndsAt: null,
        activeChannels: [],
        scores: [],
      });
    }

    if (!runtime.players.has(userId)) {
      return c.json(
        {
          error: {
            code: GameErrorCode.PLAYER_NOT_IN_SESSION,
            message: 'Not a player in this session.',
          },
        },
        403,
      );
    }

    const activeChannels = [...runtime.channels.entries()]
      .filter(([, ch]) => ch.open)
      .map(([name, ch]) => ({
        name,
        mode: ch.mode,
        endsAt: ch.endsAt,
      }));

    const scores = computeLeaderboard(runtime.scoreState);

    return c.json({
      gameState: runtime.gameState,
      privateState: runtime.privateStateManager.get(userId),
      currentPhase: runtime.phaseState.currentPhase,
      currentSubPhase: runtime.phaseState.currentSubPhase,
      currentRound: runtime.currentRound,
      phaseEndsAt: runtime.phaseState.phaseTimerId
        ? (runtime.timerState.timers.get(runtime.phaseState.phaseTimerId)?.endsAt ?? null)
        : null,
      activeChannels,
      scores,
    });
  });

  // GET /game/sessions/:id/replay — replay log
  sessionRoutes.get('/:id/replay', async c => {
    const sessionId = c.req.param('id');
    const userId = getActorId(c);

    if (!userId) {
      return c.json(
        { error: { code: GameErrorCode.UNAUTHORIZED, message: 'Authentication required.' } },
        401,
      );
    }

    const adapter = getSessionAdapter();
    const session = await adapter.getById(sessionId);
    if (!session) {
      return c.json(
        { error: { code: GameErrorCode.SESSION_NOT_FOUND, message: 'Session not found.' } },
        404,
      );
    }

    if (session.status !== 'completed' && session.status !== 'abandoned') {
      return c.json(
        {
          error: {
            code: GameErrorCode.SESSION_NOT_COMPLETED,
            message: 'Replay only available for completed or abandoned sessions.',
          },
        },
        409,
      );
    }

    const pAdapter = getPlayerAdapter();
    const players = await listAdapterRecords(pAdapter, { sessionId });
    if (!players.some(p => p.userId === userId) && session.hostUserId !== userId) {
      return c.json(
        {
          error: {
            code: GameErrorCode.PLAYER_NOT_IN_SESSION,
            message: 'Not a player in this session.',
          },
        },
        403,
      );
    }

    const from = Number(c.req.query('from') ?? 0);
    const limit = Number(c.req.query('limit') ?? 1000);

    const result = await replayStore.getReplayEntries(sessionId, from, limit);
    return c.json(result);
  });

  app.route(`${mountPath}/sessions`, sessionRoutes);
}
