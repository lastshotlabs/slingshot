import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { getPluginStateOrNull } from '@lastshotlabs/slingshot-core';

const EMBEDS_PLUGIN_STATE_KEY = 'slingshot-embeds' as const;

export interface EmbedsPeer {
  unfurl(urls: string[]): Promise<unknown[]>;
}

export function probeEmbedsPeer(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): EmbedsPeer | null {
  const pluginState = getPluginStateOrNull(input);
  const state = pluginState?.get(EMBEDS_PLUGIN_STATE_KEY) as
    | { unfurl?: EmbedsPeer['unfurl'] }
    | null
    | undefined;
  if (!state || typeof state.unfurl !== 'function') {
    return null;
  }
  return state as EmbedsPeer;
}
