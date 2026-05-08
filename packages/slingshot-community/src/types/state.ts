import { definePluginStateKey } from '@lastshotlabs/slingshot-core';
import type { PermissionEvaluator } from '@lastshotlabs/slingshot-core';
import { COMMUNITY_PLUGIN_STATE_KEY as CORE_COMMUNITY_PLUGIN_STATE_KEY } from '@lastshotlabs/slingshot-core';
import type { CommunityInteractionsPeer } from '../public';

/**
 * Plugin state key for slingshot-community (string form).
 *
 * Single-sourced constant — no magic string `'slingshot-community'` in
 * cross-package contracts. Kept for back-compat with consumers that use
 * `pluginState.get(COMMUNITY_PLUGIN_STATE_KEY)` directly.
 *
 * New code should prefer the typed reference {@link CommunityPluginStateRef}
 * with `readPluginState` / `publishPluginState` so the value type is checked
 * at the call site.
 */
export const COMMUNITY_PLUGIN_STATE_KEY = CORE_COMMUNITY_PLUGIN_STATE_KEY;

export type { CommunityInteractionsPeer };

/**
 * Plugin runtime state published by `createCommunityPlugin()`.
 *
 * `entityAdapters` is published into this same slot by the inner entity plugin
 * via `publishEntityAdaptersState` and is the canonical adapter surface
 * `requireEntityAdapter(...)` consults. It's typed as a record here so the
 * plugin's own publish merge preserves it without needing to know each entity
 * adapter's full type at this seam.
 */
export interface CommunityPluginState {
  readonly config: unknown;
  readonly evaluator: PermissionEvaluator;
  readonly interactionsPeer: CommunityInteractionsPeer;
  readonly entityAdapters?: Readonly<Record<string, unknown>>;
}

/**
 * Typed plugin-state reference for slingshot-community.
 *
 * Use with the typed `readPluginState` / `publishPluginState` overloads:
 *
 * ```ts
 * import { readPluginState, publishPluginState } from '@lastshotlabs/slingshot-core';
 * import { CommunityPluginStateRef } from '@lastshotlabs/slingshot-community';
 *
 * const state = readPluginState(pluginState, CommunityPluginStateRef);
 * publishPluginState(pluginState, CommunityPluginStateRef, { ...state, evaluator });
 * ```
 */
export const CommunityPluginStateRef =
  definePluginStateKey<CommunityPluginState>(COMMUNITY_PLUGIN_STATE_KEY);
