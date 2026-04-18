import type { SlingshotContext } from '@lastshotlabs/slingshot-core';
import type { ChatInteractionsPeer } from './types';

export function probeChatPeer(ctx: SlingshotContext): ChatInteractionsPeer | null {
  const state = ctx.pluginState.get('slingshot-chat') as
    | { interactionsPeer?: ChatInteractionsPeer }
    | null
    | undefined;
  if (!state?.interactionsPeer) return null;
  if (typeof state.interactionsPeer.resolveMessageByKindAndId !== 'function') return null;
  if (typeof state.interactionsPeer.updateComponents !== 'function') return null;
  return state.interactionsPeer;
}
