/**
 * Manifest-aware runtime wiring for the game engine.
 *
 * Creates the runtime registries and hooks for config-driven bootstrap.
 * Captures adapters after resolution and wires them into the game
 * engine's closure-owned state.
 *
 * Used by `createEntityPlugin({ manifestRuntime })` for runtime wiring.
 */
import type {
  EntityManifestRuntime,
  EntityPluginAfterAdaptersContext,
} from '@lastshotlabs/slingshot-entity';
import {
  createEntityHandlerRegistry,
  createEntityPluginHookRegistry,
} from '@lastshotlabs/slingshot-entity';
import type { GameDefinition } from '../types/models';

/** Arguments for creating the game engine manifest runtime. */
export interface GameEngineManifestRuntimeArgs {
  /** Game definitions to register in config-driven mode. */
  games?: GameDefinition[];

  /**
   * Callback fired after adapters are resolved.
   * Use this to capture adapter references for runtime use.
   */
  onAdaptersCaptured?: (adapters: { sessionAdapter: unknown; playerAdapter: unknown }) => void;
}

/**
 * Create the config-driven runtime for the game engine.
 *
 * @returns An `EntityManifestRuntime` with custom handler and hook registries.
 */
export function createGameEngineManifestRuntime(
  args: GameEngineManifestRuntimeArgs = {},
): EntityManifestRuntime {
  const customHandlers = createEntityHandlerRegistry();
  const hooks = createEntityPluginHookRegistry();

  // Capture adapters after resolution
  hooks.register('game.captureAdapters', (ctx: EntityPluginAfterAdaptersContext) => {
    const sessionAdapter = ctx.adapters.GameSession;
    const playerAdapter = ctx.adapters.GamePlayer;

    args.onAdaptersCaptured?.({
      sessionAdapter,
      playerAdapter,
    });
  });

  return {
    customHandlers,
    hooks,
  };
}
