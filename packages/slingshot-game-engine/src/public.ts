/**
 * Public contract for `slingshot-game-engine`.
 *
 * Cross-package consumers resolve `GameEngineRuntimeCap` through
 * `ctx.capabilities.require(...)` to read the active game-engine state
 * (session controls, registry, adapters). For backward compatibility the
 * runtime is also published to `pluginState` under `GAME_ENGINE_PLUGIN_STATE_KEY`
 * — that path is preserved during the bridge period.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { GameEnginePluginState } from './types/state';

/** Provider-owned package contract for `slingshot-game-engine`. */
export const GameEngine = definePackageContract('slingshot-game-engine');

/**
 * Capability handle for the game-engine runtime state.
 *
 * Cross-package consumers resolve it via
 * `ctx.capabilities.require(GameEngineRuntimeCap)`. The legacy
 * `GAME_ENGINE_PLUGIN_STATE_KEY` plugin-state slot is still published in
 * parallel during the bridge period; new consumers should prefer the cap.
 */
export const GameEngineRuntimeCap =
  GameEngine.capability<GameEnginePluginState>('runtime');
