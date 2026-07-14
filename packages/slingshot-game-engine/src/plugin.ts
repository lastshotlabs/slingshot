/**
 * Game engine package factory.
 *
 * Creates a `SlingshotPackageDefinition` that registers the GameSession and
 * GamePlayer entities, wires game-specific guard middleware, mounts the
 * game-registry and session routes, registers the WS endpoint, and manages
 * the closure-owned game registry, active session runtimes, replay store,
 * and cleanup sweep.
 *
 * Every adapter ref, middleware closure, registry, and timer is owned by the
 * factory's closure (Rule 3) — multiple package instances in the same process
 * do not share state.
 *
 * @param rawConfig - Package configuration. See {@link GameEnginePluginConfig}.
 * @returns A `SlingshotPackageDefinition` ready to pass to
 *   `createApp({ packages: [...] })`.
 */
import type { MiddlewareHandler } from 'hono';
import type {
  HookServices,
  PluginSetupContext,
  SlingshotEventBus,
  SlingshotPackageDefinition,
} from '@lastshotlabs/slingshot-core';
import {
  buildHookServices,
  createConsoleLogger,
  deepFreeze,
  definePackage,
  getContext,
  getPluginState,
  provideCapability,
  publishPluginState,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { registerEntityPolicy } from '@lastshotlabs/slingshot-entity';
import { buildGameEngineEntityModules } from './entities/modules';
import type { GameEngineAdapterRefs } from './entities/modules';
import { listAdapterRecords } from './lib/adapterQuery';
import { createCleanupState, startCleanupSweep, stopCleanupSweep } from './lib/cleanup';
import { createDisplayTokenMiddleware, resolveContextSigningSecret } from './lib/displayRuntime';
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
import {
  type PlayerAdapterShape,
  type SessionAdapterShape,
  mountGameRegistryRoutes,
  mountGameSessionRoutes,
} from './pluginRoutes';
import { wireWsEndpoint } from './pluginWs';
import { GAME_SESSION_POLICY_KEY, createGameSessionPolicy } from './policy';
import { GameEngineRuntimeCap } from './public';
import type { GameEnginePluginConfig } from './types/config';
import type { GameDefinition, GamePlayerState } from './types/models';
import { GAME_ENGINE_PLUGIN_STATE_KEY } from './types/state';
import { GameEnginePluginConfigSchema } from './validation/config';

/**
 * Create the game engine package.
 *
 * @example
 * ```ts
 * import { createGameEnginePackage, defineGame } from 'slingshot-game-engine';
 *
 * const trivia = defineGame({ ... });
 *
 * const gameEngine = createGameEnginePackage({
 *   games: [trivia],
 *   mountPath: '/game',
 * });
 * const app = createApp({ packages: [gameEngine] });
 * ```
 */
export function createGameEnginePackage(
  rawConfig: Partial<GameEnginePluginConfig> & { games?: GameDefinition[] } = {},
): SlingshotPackageDefinition {
  // Extract games from config before validation (not part of plugin config schema)
  const { games: gameDefs = [], ...configInput } = rawConfig;

  // Validate + freeze config at construction time (Rule 10).
  const config = deepFreeze(
    validatePluginConfig('slingshot-game-engine', configInput, GameEnginePluginConfigSchema),
  );

  // ─── Closure-owned adapter refs (Rule 3 — no globals) ─────────────────────
  const refs: GameEngineAdapterRefs = {};

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

  // Hoisted runtime ref read by the declarative `GameEngineRuntimeCap`
  // resolver. Populated in setupPost; resolver throws a clear "not ready"
  // error when read earlier.
  let runtimeStateRef: import('./types/state').GameEnginePluginState | undefined;

  // Long-lived Proxy view published through `GameEngineRuntimeCap`.
  // Constructed once per package instance so consumers reading the cap at
  // different lifecycle phases observe a stable reference (===). The
  // framework calls `provider.resolve()` twice (setupMiddleware + setupPost)
  // and republishes the cap slot each time; returning the same Proxy from
  // both calls keeps identity stable. All access defers to the live
  // `runtimeStateRef`; method access is bound to the live ref so destructured
  // references work; `has` reflects the live ref's surface; symbol/`then`
  // reads return `undefined` so capability publication and `await` probes
  // don't error before the runtime is wired.
  type GameEnginePluginState = import('./types/state').GameEnginePluginState;
  const runtimeTarget = Object.create(null) as GameEnginePluginState;
  const runtimeView: GameEnginePluginState = new Proxy<GameEnginePluginState>(runtimeTarget, {
    get(_target, property) {
      if (typeof property === 'symbol' || property === 'then') return undefined;
      if (!runtimeStateRef) {
        throw new Error(
          `[slingshot-game-engine] runtime.${String(property)} accessed before setupPost completed; resolve GameEngineRuntimeCap from setupPost or later.`,
        );
      }
      const value = Reflect.get(runtimeStateRef as object, property);
      return typeof value === 'function' ? value.bind(runtimeStateRef) : value;
    },
    has(_target, property) {
      if (!runtimeStateRef) return false;
      return Reflect.has(runtimeStateRef as object, property);
    },
    ownKeys() {
      if (!runtimeStateRef) return [];
      return Reflect.ownKeys(runtimeStateRef as object);
    },
    getOwnPropertyDescriptor(_target, property) {
      if (!runtimeStateRef) return undefined;
      return Reflect.getOwnPropertyDescriptor(runtimeStateRef as object, property);
    },
  });

  // Lazy accessor closures for middleware that runs before adapters are resolved.
  const getSessionAdapter = (): SessionAdapterShape => {
    if (!refs.session) {
      throw new Error(
        '[slingshot-game-engine] Session adapter not resolved — middleware called before entity setup.',
      );
    }
    return refs.session;
  };

  const getPlayerAdapter = (): PlayerAdapterShape => {
    if (!refs.player) {
      throw new Error(
        '[slingshot-game-engine] Player adapter not resolved — middleware called before entity setup.',
      );
    }
    return refs.player;
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

  // Build entity modules eagerly.
  const { sessionModule, playerModule } = buildGameEngineEntityModules({ refs });

  return definePackage({
    name: GAME_ENGINE_PLUGIN_STATE_KEY,
    mountPath: config.mountPath,
    dependencies: ['slingshot-auth'],
    entities: [sessionModule, playerModule],
    capabilities: {
      provides: [
        // Always return the same long-lived `runtimeView` Proxy. The framework
        // calls `provider.resolve()` twice (once at `setupMiddleware`, once at
        // `setupPost`) and republishes the cap slot each time — returning a
        // single stable reference means consumers reading the cap at any
        // lifecycle phase observe `===` identity. Field access defers to the
        // live `runtimeStateRef` and throws a clear error if reached before
        // setupPost has run.
        provideCapability(GameEngineRuntimeCap, () => runtimeView),
      ],
    },
    middleware,

    async setupMiddleware({ app }: PluginSetupContext) {
      // Register dispatched policy resolver before entity routes are mounted.
      registerEntityPolicy(app, GAME_SESSION_POLICY_KEY, createGameSessionPolicy());
    },

    async setupRoutes({ app }: PluginSetupContext) {
      // Mount the package-level routes (registry endpoints + session
      // routes). The entity routes themselves are mounted by the framework's
      // package compiler once `wiring.buildAdapter` returns.
      const routeDeps = {
        mountPath: config.mountPath,
        gameRegistry: gameRegistry as ReadonlyMap<string, GameDefinition>,
        activeRuntimes,
        replayStore,
        getSessionAdapter,
        getPlayerAdapter,
      };

      // Resolve a display (TV) token on any request that carries one, BEFORE the
      // game routes run, so `getDisplaySessionId(c)` is available to them and to
      // any app route mounted after us. An absent token is a no-op; an invalid
      // one is a loud 401 rather than a silent downgrade to anonymous — a
      // silently-ignored token is exactly the bug this feature exists to fix.
      app.use(`${config.mountPath}/*`, createDisplayTokenMiddleware({ getSessionAdapter }));

      mountGameRegistryRoutes(app, routeDeps);
      mountGameSessionRoutes(app, routeDeps);
    },

    async setupPost({ app, bus }: PluginSetupContext) {
      if (!refs.session || !refs.player) {
        throw new Error('[slingshot-game-engine] Adapters not resolved after entity plugin setup.');
      }

      // Capture adapter refs for callback closures.
      const capturedSessionAdapter = refs.session;
      const capturedPlayerAdapter = refs.player;

      // Shared log object for runtime and WS callbacks. Routed through the
      // workspace logger boundary so production deployments can pipe to their
      // structured log sink instead of writing directly to stdout/stderr.
      const packageLogger = createConsoleLogger({ base: { plugin: 'slingshot-game-engine' } });

      // ── ctx.services — the route from a game handler to a framework capability
      //
      // This is `ProcessHandlerContext.services`, and until now NOTHING supplied
      // it: the type, the getter and the docs all existed, and the value was
      // `undefined` in every game, always. So no game could resolve a framework
      // capability from a handler — which is exactly why hotseat's LLM never
      // generated a card in production (the AI client was registered, booted and
      // pre-warmed; the handler that had to *find* it saw nothing, and silently
      // dealt from the house deck). Hundreds of tests were green because every
      // one called the deck function directly; none drove the handler.
      //
      // Built once, read lazily per handler call. `TestGameHarness` does NOT
      // supply it, so `ctx.services` stays `undefined` in sims — which is what
      // keeps them hermetic and lets a game take its no-credentials path in tests.
      const hookServices = buildHookServices({
        app,
        pluginState: getContext(app).pluginState,
        bus,
        logger: packageLogger,
        pluginName: 'slingshot-game-engine',
      });
      const getHookServices = (): HookServices | undefined => hookServices;
      const log: SessionRuntime['log'] = {
        debug() {
          /* noop in production */
        },
        info() {
          /* noop in production */
        },
        warn(message, data) {
          packageLogger.warn(message, data as Record<string, unknown> | undefined);
        },
        error(message, data) {
          packageLogger.error(message, data as Record<string, unknown> | undefined);
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
          displaySecret: resolveContextSigningSecret(app),
        });
      }

      // §1.3 — SlingshotEventBus now supports string-indexed on/off/emit overloads,
      // so we can subscribe to dynamic event names directly without a cast.

      // Listen for game start events to initialize the session runtime.
      // Entity after-response middleware emits this after startGame op.transition
      // succeeds. Payload shape: { tenantId, actorId, id, gameType }.
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
          // Hands every game handler `ctx.services` — the capability lookup that
          // was declared, documented, and never once supplied.
          getHookServices,
          initialGameState: (session.gameState ?? null) as Record<string, unknown> | null,
          // Natural completion: persist terminal session state and surface the
          // app-bus event so server-side listeners (e.g. an owning "match"
          // record) hear about it — the WS broadcast alone only reaches clients.
          onCompleted: async (winResult, leaderboard, finalGameState) => {
            const completedAt = new Date().toISOString();
            await capturedSessionAdapter.update(sessionId, {
              status: 'completed',
              completedAt,
              // Persist the terminal game state — durable records (results
              // screens, replays, owning "match" rows) need the finished
              // game, not whatever was last written during play.
              ...(finalGameState ? { gameState: finalGameState } : {}),
            });
            bus.emit('game:session.completed', {
              id: sessionId,
              gameType: session.gameType as string,
              winResult,
              leaderboard,
            });
          },
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
        sessionAdapter: capturedSessionAdapter,
        playerAdapter: capturedPlayerAdapter,
        gameRegistry: gameRegistry as ReadonlyMap<string, GameDefinition>,
        sessionControls: createSessionControls(activeRuntimes, {
          sessionAdapter: capturedSessionAdapter as never,
          playerAdapter: capturedPlayerAdapter as never,
        }),
      });
      // Legacy plugin-state slot — preserved for back-compat with consumers
      // that read the runtime via `getPluginState(app).get(GAME_ENGINE_PLUGIN_STATE_KEY)`.
      // New code should resolve `GameEngineRuntimeCap` through `ctx.capabilities`.
      publishPluginState(getPluginState(app), GAME_ENGINE_PLUGIN_STATE_KEY, state);
      // Populate the hoisted ref so the declarative GameEngineRuntimeCap
      // resolver stops throwing.
      runtimeStateRef = state;
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
  });
}
