import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { resolvePluginState } from '@lastshotlabs/slingshot-core';
import type { CommunityInteractionsPeer } from './types';

export function probeCommunityPeer(
  input: PluginStateMap | PluginStateCarrier | null | undefined,
): CommunityInteractionsPeer | null {
  const pluginState = resolvePluginState(input);
  const state = pluginState?.get('slingshot-community') as
    | { interactionsPeer?: CommunityInteractionsPeer }
    | null
    | undefined;
  if (!state?.interactionsPeer) return null;
  if (typeof state.interactionsPeer.resolveMessageByKindAndId !== 'function') return null;
  if (typeof state.interactionsPeer.updateComponents !== 'function') return null;
  return state.interactionsPeer;
}
