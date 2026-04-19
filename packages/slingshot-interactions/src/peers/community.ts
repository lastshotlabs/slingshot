import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { probeInteractionsPeer } from './probe';
import type { CommunityInteractionsPeer } from './types';

const COMMUNITY_PLUGIN_STATE_KEY = 'slingshot-community' as const;

export function probeCommunityPeer(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): CommunityInteractionsPeer | null {
  return probeInteractionsPeer<CommunityInteractionsPeer>(input, COMMUNITY_PLUGIN_STATE_KEY);
}
