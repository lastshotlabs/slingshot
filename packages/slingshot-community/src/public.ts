/**
 * Public contract for `slingshot-community`.
 *
 * Cross-package consumers (notably `slingshot-interactions` for component-tree
 * resolution) resolve `CommunityInteractionsPeerCap` through
 * `ctx.capabilities.require(...)`.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';

export const Community = definePackageContract('slingshot-community');

/**
 * Cross-package peer surface used by `slingshot-interactions` (and other
 * component-aware consumers) to resolve community-owned message trees and
 * apply component updates returned by interaction dispatchers.
 */
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

export const CommunityInteractionsPeerCap =
  Community.capability<CommunityInteractionsPeer>('interactionsPeer');
