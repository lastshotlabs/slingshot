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
import type { MiddlewareHandler } from 'hono';
import type {
  PluginSetupContext,
  SlingshotEventBus,
  SlingshotPlugin,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  getContext,
  getPluginState,
  publishPluginState,
  resolveRepo,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin, registerEntityPolicy } from '@lastshotlabs/slingshot-entity';
import type { EntityPlugin, EntityPluginEntry } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { gamePlayerFactories, gameSessionFactories } from './entities/factories';
import { GamePlayer } from './entities/gamePlayer';
import { GameSession } from './entities/gameSession';
import { listAdapterRecords } from './lib/adapterQuery';
import { createCleanupState, startCleanupSweep, stopCleanupSweep } from './lib/cleanup';
import { createInMemoryReplayStore } from './lib/replay';
import { createSessionControls } from './lib/sessionControl';
import {
  type SessionRuntime,
  createSessionRuntime,
  destroySessionRuntime,
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
import {
  type PlayerAdapterShape,
  type SessionAdapterShape,
  mountGameRegistryRoutes,
  mountGameSessionRoutes,
} from './pluginRoutes';
import { wireWsEndpoint } from './pluginWs';
import { GAME_SESSION_POLICY_KEY, createGameSessionPolicy } from './policy';
import type { GameEnginePluginConfig } from './types/config';
import type { GameDefinition, GamePlayerState } from './types/models';
import { GAME_ENGINE_PLUGIN_STATE_KEY } from './types/state';
import { GameEnginePluginConfigSchema } from './validation/config';

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

      // Route registration is delegated to pluginRoutes.ts for maintainability.
      const routeDeps = {
        mountPath: config.mountPath,
        gameRegistry: gameRegistry as ReadonlyMap<string, GameDefinition>,
        activeRuntimes,
        replayStore,
        getSessionAdapter,
        getPlayerAdapter,
      };

      mountGameRegistryRoutes(app, routeDeps);
      mountGameSessionRoutes(app, routeDeps);
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
      // WS wiring is delegated to pluginWs.ts for maintainability.
      const endpointMap = getContext(app).wsEndpoints as Record<
        string,
        import('@lastshotlabs/slingshot-core').WsPluginEndpoint | undefined
      > | null;

      if (endpointMap) {
        wireWsEndpoint({
          wsEndpoint: config.wsEndpoint,
          endpointMap,
          gameRegistry: gameRegistry as ReadonlyMap<string, GameDefinition>,
          activeRuntimes,
          sessionAdapter: capturedSessionAdapter,
          playerAdapter: capturedPlayerAdapter,
          bus,
        });
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
        // Non-security: this is a Mulberry32 game-RNG seed for deterministic
        // gameplay (shuffles, dice rolls). It is NOT a credential and a
        // weak/predictable seed has no security impact — `Math.random()` is fine.
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
      publishPluginState(getPluginState(app), GAME_ENGINE_PLUGIN_STATE_KEY, state);
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
