import type { PermissionEvaluator } from '@lastshotlabs/slingshot-core';
import { COMMUNITY_PLUGIN_STATE_KEY as CORE_COMMUNITY_PLUGIN_STATE_KEY } from '@lastshotlabs/slingshot-core';
import type { CommunityInteractionsPeer } from '../public';

/**
 * Plugin state key for slingshot-community.
 *
 * Single-sourced constant — no magic string `'slingshot-community'` in
 * cross-package contracts.
 */
export const COMMUNITY_PLUGIN_STATE_KEY = CORE_COMMUNITY_PLUGIN_STATE_KEY;

export type { CommunityInteractionsPeer };

export interface CommunityPluginState {
  readonly config: unknown;
  readonly evaluator: PermissionEvaluator;
  readonly interactionsPeer: CommunityInteractionsPeer;
}
