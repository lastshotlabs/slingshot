import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { CHAT_PLUGIN_STATE_KEY } from '@lastshotlabs/slingshot-core';
import { probeInteractionsPeer } from './probe';
import type { ChatInteractionsPeer } from './types';

export function probeChatPeer(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): ChatInteractionsPeer | null {
  return probeInteractionsPeer<ChatInteractionsPeer>(input, CHAT_PLUGIN_STATE_KEY);
}
