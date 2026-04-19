import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { resolvePluginState } from '@lastshotlabs/slingshot-core';
import type { ChatInteractionsPeer } from './types';

export function probeChatPeer(
  input: PluginStateMap | PluginStateCarrier | null | undefined,
): ChatInteractionsPeer | null {
  const pluginState = resolvePluginState(input);
  const state = pluginState?.get('slingshot-chat') as
    | { interactionsPeer?: ChatInteractionsPeer }
    | null
    | undefined;
  if (!state?.interactionsPeer) return null;
  if (typeof state.interactionsPeer.resolveMessageByKindAndId !== 'function') return null;
  if (typeof state.interactionsPeer.updateComponents !== 'function') return null;
  return state.interactionsPeer;
}
