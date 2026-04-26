/**
 * Game engine plugin factory.
 *
 * Creates a `SlingshotPlugin` that registers GameSession and GamePlayer
 * entities, mounts game-specific middleware, registers the WS endpoint,
 * and manages the game registry and session lifecycle.
 *
 * Every adapter, middleware, registry, and timer is closure-owned (Rule 3).
 * Multiple plugin instances in the same process do not share state.
 *
 * @param rawConfig - Plugin configuration. See {@link GameEnginePluginConfig}.
 * @returns A `SlingshotPlugin` ready to pass to `createApp({ plugins: [...] })`.
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type {
  AppEnv,
  PluginSetupContext,
  SlingshotEventBus,
  SlingshotPlugin,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  getActorId,
  getContext,
  getPluginState,
  resolveRepo,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import type { WsPluginEndpoint } from '@lastshotlabs/slingshot-core';
import { createEntityPlugin, registerEntityPolicy } from '@lastshotlabs/slingshot-entity';
import type { EntityPlugin, EntityPluginEntry } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { gamePlayerFactories, gameSessionFactories } from './entities/factories';
import { GamePlayer } from './entities/gamePlayer';
import { GameSession } from './entities/gameSession';
import { GameErrorCode } from './errors';
import { listAdapterRecords } from './lib/adapterQuery';
import { createCleanupState, startCleanupSweep, stopCleanupSweep } from './lib/cleanup';
import { rejectInput } from './lib/input';
import { createInMemoryReplayStore } from './lib/replay';
import { extractRulesDefaults } from './lib/rules';
import { computeLeaderboard } from './lib/scoring';
import { createSessionControls } from './lib/sessionControl';
import {
  type SessionRuntime,
  createSessionRuntime,
  destroySessionRuntime,
  handleDisconnect,
  handleReconnectFlow,
  processInputPipeline,
} from './lib/sessionRuntime';
import { buildContentValidationGuard } from './middleware/contentValidationGuard';
import { buildHostOnlyGuard } from './middleware/hostOnlyGuard';
import { buildLobbyOnlyGuard } from './middleware/lobbyOnlyGuard';
import { buildPlayerJoinGuard } from './middleware/playerJoinGuard';
import { buildPlayerLeaveGuard } from './middleware/playerLeaveGuard';
import { buildRulesValidationGuard } from './middleware/rulesValidationGuard';
import { buildSessionCreateGuard } from './middleware/sessionCreateGuard';
import { buildStartGameGuard } from './middleware/startGameGuard';
import { gamePlayerOperations } from './operations/player';
import { gameSessionOperations } from './operations/session';
import { GAME_SESSION_POLICY_KEY, createGameSessionPolicy } from './policy';
import type { GameEnginePluginConfig } from './types/config';
import type { GameDefinition, GamePlayerState } from './types/models';
import { GAME_ENGINE_PLUGIN_STATE_KEY } from './types/state';
import { GameEnginePluginConfigSchema } from './validation/config';
import { type IncomingHandlerContext, buildIncomingDispatch } from './ws/incoming';

/** Minimal session adapter shape — the subset of methods used by middleware and manual routes. */
interface SessionAdapterShape {
  getById(id: string): Promise<Record<string, unknown> | null>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
  find?(filter: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  list?(filter: Record<string, unknown>): Promise<unknown>;
}

/** Minimal player adapter shape — the subset of methods used by middleware and manual routes. */
interface PlayerAdapterShape {
  find?(filter: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  list?(filter: Record<string, unknown>): Promise<unknown>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
  create?(data: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * Cast a typed entity adapter to a minimal adapter shape.
 *
 * The typed adapter from `resolveRepo()` has strongly-typed method signatures
 * while the shape interfaces use `Record<string, unknown>` for interop with
 * middleware closures. The adapter is structurally compatible at runtime — all
 * required methods exist and accept the wider parameter types. This is a safe
 * single-step cast (not through `unknown`), narrowing to the subset used.
 */
function asSessionAdapter(adapter: object): SessionAdapterShape {
  return adapter as SessionAdapterShape;
}

function asPlayerAdapter(adapter: object): PlayerAdapterShape {
  return adapter as PlayerAdapterShape;
}

/**
 * Widen a typed entity adapter to `BareEntityAdapter` by copying enumerable
 * properties into a fresh object with an index signature.
 *
 * `BareEntityAdapter` requires `{ [key: string]: unknown }`, but typed adapters
 * from `resolveRepo()` don't declare one. Copying into a `Record<string, unknown>`
 * satisfies the structural constraint without going through `unknown`.
 */
function toBareAdapter(adapter: object): BareEntityAdapter {
  const bare: Record<string, unknown> = {};
  for (const key of Object.keys(adapter)) {
    bare[key] = (adapter as Record<string, unknown>)[key];
  }
  return bare as BareEntityAdapter;
}

/**
 * Create the game engine plugin.
 *
 * @example
 * ```ts
 * import { createGameEnginePlugin, defineGame } from 'slingshot-game-engine';
 *
 * const trivia = defineGame({ ... });
 *
 * const gameEngine = createGameEnginePlugin({
 *   games: [trivia],
 *   mountPath: '/game',
 * });
 * const app = createApp({ plugins: [gameEngine] });
 * ```
 */
export function createGameEnginePlugin(
  rawConfig: Partial<GameEnginePluginConfig> & { games?: GameDefinition[] } = {},
): SlingshotPlugin {
  // Extract games from config before validation (not part of plugin config schema)
  const { games: gameDefs = [], ...configInput } = rawConfig;

  // Validate + freeze config at construction time (Rule 10).
  const config = deepFreeze(
    validatePluginConfig(GAME_ENGINE_PLUGIN_STATE_KEY, configInput, GameEnginePluginConfigSchema),
  );

  // Closure-owned state — no module-level singletons (Rule 3).
  let sessionAdapter: SessionAdapterShape | undefined;
  let playerAdapter: PlayerAdapterShape | undefined;
  let innerPlugin: EntityPlugin | undefined;

  // Closure-owned game registry (not a module-level Map).
  const gameRegistry = new Map<string, GameDefinition>();
  for (const def of gameDefs) {
    gameRegistry.set(def.name, def);
  }

  // Closure-owned active runtimes map (Rule 3).
  const activeRuntimes = new Map<string, SessionRuntime>();

  // Default replay store (in-memory). Can be replaced via config.
  const replayStore = createInMemoryReplayStore();

  // Cleanup state
  const cleanupState = createCleanupState(config.cleanup);

  // Closure-scoped refs for teardown. Populated in setupPost.
  let onSessionStartedRef: ((payload: Record<string, unknown>) => void | Promise<void>) | null =
    null;
  let busRef: SlingshotEventBus | null = null;

  // Lazy accessor closures for middleware that runs before adapters are resolved.
  const getSessionAdapter = () => {
    if (!sessionAdapter) {
      throw new Error(
        '[slingshot-game-engine] Session adapter not resolved — middleware called before entity setup.',
      );
    }
    return sessionAdapter;
  };

  const getPlayerAdapter = () => {
    if (!playerAdapter) {
      throw new Error(
        '[slingshot-game-engine] Player adapter not resolved — middleware called before entity setup.',
      );
    }
    return playerAdapter;
  };

  const getRegistry = () => gameRegistry as ReadonlyMap<string, GameDefinition>;

  // Build named middleware closures.
  const middleware: Record<string, MiddlewareHandler> = {
    hostOnlyGuard: buildHostOnlyGuard({ getSessionAdapter }),
    lobbyOnlyGuard: buildLobbyOnlyGuard({ getSessionAdapter }),
    sessionCreateGuard: buildSessionCreateGuard({
      getRegistry,
    }),
    startGameGuard: buildStartGameGuard({
      getSessionAdapter,
      getPlayerAdapter,
      getRegistry,
    }),
    playerJoinGuard: buildPlayerJoinGuard({
      getSessionAdapter,
      getPlayerAdapter,
      getRegistry,
    }),
    playerLeaveGuard: buildPlayerLeaveGuard({
      getSessionAdapter,
      getPlayerAdapter,
    }),
    rulesValidationGuard: buildRulesValidationGuard({
      getSessionAdapter,
      getRegistry,
    }),
    contentValidationGuard: buildContentValidationGuard({
      getSessionAdapter,
      getRegistry,
    }),
  };

  // Entity entries for createEntityPlugin.
  const entities: EntityPluginEntry[] = [
    {
      config: GameSession,
      operations: gameSessionOperations.operations,
      routePath: 'sessions',
      buildAdapter(storeType: StoreType, infra: StoreInfra): BareEntityAdapter {
        const adapter = resolveRepo(gameSessionFactories, storeType, infra);
        sessionAdapter = asSessionAdapter(adapter);
        return toBareAdapter(adapter);
      },
    },
    {
      config: GamePlayer,
      operations: gamePlayerOperations.operations,
      routePath: 'players',
      parentPath: '/sessions/:sessionId',
      buildAdapter(storeType: StoreType, infra: StoreInfra): BareEntityAdapter {
        const adapter = resolveRepo(gamePlayerFactories, storeType, infra);
        playerAdapter = asPlayerAdapter(adapter);
        return toBareAdapter(adapter);
      },
    },
  ];

  return {
    name: GAME_ENGINE_PLUGIN_STATE_KEY,
    dependencies: ['slingshot-auth'],

    async setupMiddleware(ctx: PluginSetupContext) {
      // Register dispatched policy resolver before entity routes are mounted.
      registerEntityPolicy(ctx.app, GAME_SESSION_POLICY_KEY, createGameSessionPolicy());
      innerPlugin ??= createEntityPlugin({
        name: GAME_ENGINE_PLUGIN_STATE_KEY,
        mountPath: config.mountPath,
        entities,
        middleware,
      });
      await innerPlugin?.setupMiddleware?.(ctx);
    },

    async setupRoutes({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      await innerPlugin?.setupRoutes?.({ app, config: frameworkConfig, bus, events });

      const mountPath = config.mountPath;

      // ── Manual routes: Game Registry (§26.1) ─────────────────────
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

      // ── Manual routes: Session (§26.2) ───────────────────────────
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
        // Use the findByJoinCode lookup if available on the adapter
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

        // Check if player already in session
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

        // Check capacity
        if (gameDef && existingPlayers.length >= gameDef.maxPlayers) {
          return c.json(
            { error: { code: GameErrorCode.SESSION_FULL, message: 'Session is full.' } },
            409,
          );
        }

        // Check ban list (stored on session entity as JSON field)
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

        // Check spectator capacity
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

        // Create player
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

        // Return full session state (same shape as GET /game/sessions/:id).
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
          // Fall back to adapter for non-active sessions
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

        // Check player membership
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

        // Check player membership
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
    },

    async setupPost({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      await innerPlugin?.setupPost?.({ app, config: frameworkConfig, bus, events });

      if (!sessionAdapter || !playerAdapter) {
        throw new Error('[slingshot-game-engine] Adapters not resolved after entity plugin setup.');
      }

      // Capture adapter refs for callback closures.
      const capturedSessionAdapter = sessionAdapter;
      const capturedPlayerAdapter = playerAdapter;

      // Shared log object for runtime and WS callbacks.
      const log: SessionRuntime['log'] = {
        debug() {
          /* noop in production */
        },
        info() {
          /* noop in production */
        },
        warn(message, data) {
          console.warn(`[game-engine] ${message}`, data);
        },
        error(message, data) {
          console.error(`[game-engine] ${message}`, data);
        },
      };

      // ── Wire WS incoming handlers with real transport ──────────
      const endpointMap = getContext(app).wsEndpoints as Record<
        string,
        WsPluginEndpoint | undefined
      > | null;

      if (endpointMap) {
        // Wire resolveSession callback — adapter query + game registry lookup (§5.10.9)
        const resolveSession = async (sessionId: string) => {
          const session = await capturedSessionAdapter.getById(sessionId);
          if (!session) return null;
          const players = await listAdapterRecords(capturedPlayerAdapter, { sessionId });
          const gameDef = gameRegistry.get(session.gameType as string);
          if (!gameDef) return null;
          return {
            session: {
              id: session.id as string,
              gameType: session.gameType as string,
              status: session.status as string,
              hostUserId: session.hostUserId as string,
            },
            players: players.map(p => ({
              userId: p.userId as string,
              displayName: (p.displayName ?? '') as string,
              role: (p.role ?? null) as string | null,
              team: (p.team ?? null) as string | null,
              playerState: (p.playerState ?? null) as string | null,
              score: (p.score ?? 0) as number,
              connected: (p.connected ?? true) as boolean,
              isHost: (p.isHost ?? false) as boolean,
              isSpectator: (p.isSpectator ?? false) as boolean,
              joinOrder: (p.joinOrder ?? 0) as number,
            })),
            gameDef,
            runtime: activeRuntimes.get(sessionId),
          };
        };

        // Wire processInput callback — delegate to session runtime (§5.10.5)
        const processInput = async (
          sessionId: string,
          channel: string,
          userId: string,
          data: unknown,
          sequence: number,
        ) => {
          const runtime = activeRuntimes.get(sessionId);
          if (!runtime) {
            return rejectInput('SESSION_NOT_FOUND', 'No active runtime for session.', sequence);
          }
          return processInputPipeline(runtime, channel, userId, data, sequence);
        };

        // Wire handleReconnect callback — delegate to session runtime (§5.10.7)
        const handleReconnect = async (
          sessionId: string,
          userId: string,
          subscribe: (room: string) => void,
          ack: (data: unknown) => void,
          publish: (room: string, data: unknown) => void,
        ) => {
          const runtime = activeRuntimes.get(sessionId);
          if (!runtime) return;
          return handleReconnectFlow(runtime, userId, subscribe, ack, publish);
        };

        const incomingHandlers = buildIncomingDispatch({
          resolveSession,
          processInput,
          handleReconnect,
          bus,
        });

        const endpoint = (endpointMap[config.wsEndpoint] ??= {});
        const incoming: NonNullable<typeof endpoint.incoming> =
          endpoint.incoming === undefined ? {} : { ...endpoint.incoming };

        // Wire real WS transport per slingshot-chat pattern (§5.10.9)
        for (const handler of incomingHandlers) {
          incoming[handler.event] = {
            auth: 'userAuth',
            handler: (
              ws: unknown,
              payload: unknown,
              context: {
                socketId: string;
                actor: import('@lastshotlabs/slingshot-core').Actor;
                requestTenantId: string | null;
                endpoint: string;
                publish(room: string, data: unknown): void;
                subscribe(room: string): void;
                unsubscribe(room: string): void;
              },
            ) => {
              const wsSocket = ws as { send(data: string): void };
              const wsCtx: IncomingHandlerContext = {
                actorId: context.actor.id ?? '',
                socketId: context.socketId,
                payload,
                ack: data => wsSocket.send(JSON.stringify(data)),
                publish: (room, data) => context.publish(room, data),
                subscribe: room => context.subscribe(room),
                unsubscribe: room => context.unsubscribe(room),
              };
              return handler.handler(wsCtx);
            },
          };
        }
        endpoint.incoming = incoming;

        // §2 — Wire WS close handler for disconnect detection.
        // ctx.wsEndpoints is the same object reference as the server's endpoint map
        // (server.ts:508-513), so writing on.close here is read by the framework's
        // close handler (server.ts:430-436).
        // endpoint was just created via ??= above, so it always exists here.
        endpoint.on ??= {};
        endpoint.on.close = async ws => {
          const wsData = ws as {
            data: { actor: { id: string | null }; id: string; rooms: Set<string>; endpoint: string };
          };
          const userId = wsData.data.actor.id;
          if (!userId) return;

          // Find which active session this player is in and trigger disconnect.
          for (const [, runtime] of activeRuntimes) {
            if (runtime.players.has(userId)) {
              await handleDisconnect(runtime, userId);
              break;
            }
          }
        };
      }

      // §1.3 — SlingshotEventBus now supports string-indexed on/off/emit overloads,
      // so we can subscribe to dynamic event names directly without a cast.

      // Listen for game start events to initialize the session runtime.
      // Entity after-response middleware emits this after startGame op.transition
      // succeeds (gameSession.ts:88-92, applyRouteConfig.ts:336-367).
      // Payload shape: { tenantId, actorId, id, gameType } — picked from entity record.
      const onSessionStarted = async (payload: Record<string, unknown>) => {
        const sessionId = payload.id as string | undefined;
        const gameType = payload.gameType as string | undefined;

        if (!sessionId || !gameType) {
          log.error('game:session.started — missing id or gameType', { payload });
          return;
        }

        const gameDef = gameRegistry.get(gameType);
        if (!gameDef) {
          log.error(`game:session.started — unknown gameType '${gameType}'`, { sessionId });
          return;
        }

        const session = await capturedSessionAdapter.getById(sessionId);
        if (!session) {
          log.error('game:session.started — session not found', { sessionId });
          return;
        }

        const playerRecords = await listAdapterRecords(capturedPlayerAdapter, { sessionId });
        const players: GamePlayerState[] = playerRecords.map(p => ({
          userId: p.userId as string,
          displayName: (p.displayName ?? '') as string,
          role: (p.role ?? null) as string | null,
          team: (p.team ?? null) as string | null,
          playerState: (p.playerState ?? null) as string | null,
          score: (p.score ?? 0) as number,
          connected: (p.connected ?? true) as boolean,
          isHost: (p.isHost ?? false) as boolean,
          isSpectator: (p.isSpectator ?? false) as boolean,
          joinOrder: (p.joinOrder ?? 0) as number,
        }));

        const rules = (session.rules ?? {}) as Record<string, unknown>;
        const rngSeed =
          typeof session.rngSeed === 'number'
            ? session.rngSeed
            : Math.floor(Math.random() * 0x7fffffff);

        // Build publish callback for the runtime.
        // WsPublishFn JSON-serializes data internally — do NOT stringify here.
        const publish = (
          room: string,
          message: unknown,
          options?: { exclude?: ReadonlySet<string>; volatile?: boolean; trackDelivery?: boolean },
        ) => {
          const liveAppCtx = getContext(app);
          if (liveAppCtx.ws && liveAppCtx.wsPublish) {
            liveAppCtx.wsPublish(liveAppCtx.ws, config.wsEndpoint, room, message, options);
          }
        };

        const runtime = await createSessionRuntime(sessionId, gameDef, rules, players, rngSeed, {
          publish,
          replayStore,
          log,
          activeRuntimes,
        });

        if (!runtime) {
          log.warn('game:session.started — runtime creation cancelled by onGameStart hook', {
            sessionId,
          });
          return;
        }

        // Transition starting → playing now that runtime is live.
        // Direct adapter.update() for internal state changes — not a user-facing operation.
        await capturedSessionAdapter.update(sessionId, { status: 'playing' });
      };

      bus.on('game:session.started', onSessionStarted);

      // §1.5 — Store refs for teardown.
      onSessionStartedRef = onSessionStarted;
      busRef = bus;

      // Start cleanup sweep with real adapter calls.
      startCleanupSweep(cleanupState, {
        async querySessions() {
          // Query all statuses that are candidates for cleanup.
          const [abandoned, completed, lobby] = await Promise.all([
            listAdapterRecords(capturedSessionAdapter, { status: 'abandoned' }),
            listAdapterRecords(capturedSessionAdapter, { status: 'completed' }),
            listAdapterRecords(capturedSessionAdapter, { status: 'lobby' }),
          ]);
          return [...abandoned, ...completed, ...lobby].map(r => ({
            id: r.id as string,
            status: r.status as import('./types/models').SessionStatus,
            completedAt: (r.completedAt ?? null) as string | null,
            lastActivityAt: (r.lastActivityAt ?? null) as string | null,
            createdAt: r.createdAt as string,
          }));
        },
        async deleteSession(id: string) {
          destroySessionRuntime(activeRuntimes, id);
          await replayStore.deleteReplayEntries(id);
        },
      });

      // Register plugin state (Rule 16 — instance-scoped context).
      const state = deepFreeze({
        config,
        sessionAdapter,
        playerAdapter,
        gameRegistry: gameRegistry as ReadonlyMap<string, GameDefinition>,
        sessionControls: createSessionControls(activeRuntimes),
      });
      getPluginState(app).set(GAME_ENGINE_PLUGIN_STATE_KEY, state);
    },

    teardown() {
      // Unsubscribe bus listener.
      if (onSessionStartedRef && busRef) {
        busRef.off('game:session.started', onSessionStartedRef);
      }

      stopCleanupSweep(cleanupState);
      // Destroy all active runtimes on shutdown
      for (const sessionId of activeRuntimes.keys()) {
        destroySessionRuntime(activeRuntimes, sessionId);
      }
    },
  };
}

/**
 * Register a game definition with an existing game engine plugin instance.
 *
 * Call this during application setup, before the plugin's `setupRoutes` runs.
 */
export function registerGame(
  plugin: SlingshotPlugin & { _registry?: Map<string, GameDefinition> },
  definition: GameDefinition,
): void {
  // This is a convenience API. For the primary registration path,
  // pass games via `createGameEnginePlugin({ games: [...] })`.
  if (plugin._registry) {
    plugin._registry.set(definition.name, definition);
  }
}
