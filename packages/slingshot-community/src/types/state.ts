import type { PermissionEvaluator } from '@lastshotlabs/slingshot-core';

/**
 * Plugin state key for slingshot-community.
 *
 * Single-sourced constant — no magic string `'slingshot-community'` in
 * cross-package contracts.
 */
export const COMMUNITY_PLUGIN_STATE_KEY = 'slingshot-community' as const;

export interface CommunityInteractionsPeer {
  readonly peerKind: 'community';
  resolveMessageByKindAndId(
    kind: 'chat:message' | 'community:thread' | 'community:reply' | 'community:post',
    id: string,
  ): Promise<{ readonly components?: unknown } | null>;
  updateComponents(
    kind: 'chat:message' | 'community:thread' | 'community:reply' | 'community:post',
    id: string,
    components: ReadonlyArray<unknown>,
  ): Promise<void>;
}

export interface CommunityPluginState {
  readonly config: unknown;
  readonly evaluator: PermissionEvaluator;
  readonly interactionsPeer: CommunityInteractionsPeer;
}
