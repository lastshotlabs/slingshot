import { EMBEDS_PLUGIN_STATE_KEY } from './pluginKeys';
import type { PluginStateCarrier, PluginStateMap } from './pluginState';
import { getPluginStateOrNull } from './pluginState';

export interface EmbedsPeer {
  unfurl(urls: string[]): Promise<unknown[]>;
}

export function getEmbedsPeer(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): EmbedsPeer {
  const state = getEmbedsPeerOrNull(input);
  if (!state) {
    throw new Error('[slingshot-embeds] embeds peer is not available in pluginState');
  }
  return state;
}

export function getEmbedsPeerOrNull(
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
