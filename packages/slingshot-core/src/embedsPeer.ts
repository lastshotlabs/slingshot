import { EMBEDS_PLUGIN_STATE_KEY } from './pluginKeys';
import type { PluginStateCarrier, PluginStateMap } from './pluginState';
import { getPluginStateOrNull } from './pluginState';

/** Cross-package handle to the embeds plugin's URL unfurling capability. */
export interface EmbedsPeer {
  unfurl(urls: string[]): Promise<unknown[]>;
}

/** Resolve the {@link EmbedsPeer} from plugin state, throwing if the embeds plugin is not registered. */
export function getEmbedsPeer(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): EmbedsPeer {
  const state = getEmbedsPeerOrNull(input);
  if (!state) {
    throw new Error('[slingshot-embeds] embeds peer is not available in pluginState');
  }
  return state;
}

/** Resolve the {@link EmbedsPeer} from plugin state, returning `null` if the embeds plugin is not available. */
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
