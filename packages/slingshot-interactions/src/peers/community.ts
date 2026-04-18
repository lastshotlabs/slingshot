import type { SlingshotContext } from '@lastshotlabs/slingshot-core';
import type { CommunityInteractionsPeer } from './types';

export function probeCommunityPeer(ctx: SlingshotContext): CommunityInteractionsPeer | null {
  const state = ctx.pluginState.get('slingshot-community') as
    | { interactionsPeer?: CommunityInteractionsPeer }
    | null
    | undefined;
  if (!state?.interactionsPeer) return null;
  if (typeof state.interactionsPeer.resolveMessageByKindAndId !== 'function') return null;
  if (typeof state.interactionsPeer.updateComponents !== 'function') return null;
  return state.interactionsPeer;
}
