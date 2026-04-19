import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { probeInteractionsPeer } from './probe';
import type { ChatInteractionsPeer } from './types';

const CHAT_PLUGIN_STATE_KEY = 'slingshot-chat' as const;

export function probeChatPeer(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): ChatInteractionsPeer | null {
  return probeInteractionsPeer<ChatInteractionsPeer>(input, CHAT_PLUGIN_STATE_KEY);
}
