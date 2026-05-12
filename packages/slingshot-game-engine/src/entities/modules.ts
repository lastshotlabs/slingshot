/**
 * Package-authoring entity modules for the game-engine package.
 *
 * Each entity uses `wiring: { mode: 'manual', buildAdapter }` so the package
 * factory can resolve the config-driven adapter and publish it into the shared
 * {@link GameEngineAdapterRefs} bag for downstream consumers — guard middleware,
 * the WS endpoint wiring, the cleanup sweep, and the `setupPost` runtime
 * initializer.
 *
 * @internal
 */
import type { StoreInfra, StoreType } from '@lastshotlabs/slingshot-core';
import { RESOLVE_ENTITY_FACTORIES, resolveRepo } from '@lastshotlabs/slingshot-core';
import { createEntityFactories, entity } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';
import { GamePlayer } from './gamePlayer';
import { GameSession } from './gameSession';
import { gamePlayerOperations } from '../operations/player';
import { gameSessionOperations } from '../operations/session';
import type { PlayerAdapterShape, SessionAdapterShape } from '../pluginRoutes';

type EntityFactoryCreator = typeof createEntityFactories;

/**
 * Resolve a config-driven adapter through the framework's standard-wiring
 * code path so manual-wiring entities here behave the same as the default
 * factory pipeline.
 */
function resolveStandardAdapter(args: {
  config: Parameters<typeof createEntityFactories>[0];
  operations?: Parameters<typeof createEntityFactories>[1];
  storeType: StoreType;
  infra: StoreInfra;
}): BareEntityAdapter {
  const creator = Reflect.get(args.infra as object, RESOLVE_ENTITY_FACTORIES) as
    | EntityFactoryCreator
    | undefined;
  const factoryCreator = creator ?? createEntityFactories;
  const factories = args.operations
    ? factoryCreator(args.config, args.operations)
    : factoryCreator(args.config);
  return resolveRepo(factories, args.storeType, args.infra) as unknown as BareEntityAdapter;
}

/**
 * Shared adapter ref bag populated by each entity module's
 * `wiring.buildAdapter` callback during bootstrap.
 *
 * Guard middleware, custom-op handlers, WS wiring, and the cleanup sweep all
 * read through these refs at request time so each package instance keeps its
 * own adapters (Rule 3 — closure-owned state, no globals).
 */
export interface GameEngineAdapterRefs {
  session?: SessionAdapterShape;
  player?: PlayerAdapterShape;
  /** Wider view of the session adapter used to satisfy `BareEntityAdapter` consumers. */
  sessionBare?: BareEntityAdapter;
  /** Wider view of the player adapter used to satisfy `BareEntityAdapter` consumers. */
  playerBare?: BareEntityAdapter;
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

export interface BuildGameEngineEntityModulesArgs {
  /** Shared adapter refs populated as each entity is wired. */
  refs: GameEngineAdapterRefs;
}

/**
 * Build the GameSession and GamePlayer entity modules ready for
 * `definePackage({ entities: [...] })`.
 */
export function buildGameEngineEntityModules(args: BuildGameEngineEntityModulesArgs) {
  const { refs } = args;

  const sessionModule = entity({
    config: GameSession,
    operations: gameSessionOperations,
    path: 'sessions',
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: GameSession,
          operations: gameSessionOperations.operations,
          storeType,
          infra,
        });
        refs.session = adapter as unknown as SessionAdapterShape;
        const bare = toBareAdapter(adapter);
        refs.sessionBare = bare;
        return bare;
      },
    },
  });

  const playerModule = entity({
    config: GamePlayer,
    operations: gamePlayerOperations,
    path: 'players',
    parentPath: '/sessions/:sessionId',
    wiring: {
      mode: 'manual',
      buildAdapter: (storeType, infra) => {
        const adapter = resolveStandardAdapter({
          config: GamePlayer,
          operations: gamePlayerOperations.operations,
          storeType,
          infra,
        });
        refs.player = adapter as unknown as PlayerAdapterShape;
        const bare = toBareAdapter(adapter);
        refs.playerBare = bare;
        return bare;
      },
    },
  });

  return { sessionModule, playerModule };
}
