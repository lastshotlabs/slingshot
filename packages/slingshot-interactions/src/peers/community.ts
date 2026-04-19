import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { COMMUNITY_PLUGIN_STATE_KEY } from '@lastshotlabs/slingshot-core';
import { probeInteractionsPeer } from './probe';
import type { CommunityInteractionsPeer } from './types';

export function probeCommunityPeer(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): CommunityInteractionsPeer | null {
  return probeInteractionsPeer<CommunityInteractionsPeer>(input, COMMUNITY_PLUGIN_STATE_KEY);
}
