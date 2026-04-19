import type { EmbedsPeer, PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { getEmbedsPeerOrNull } from '@lastshotlabs/slingshot-core';

export function probeEmbedsPeer(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): EmbedsPeer | null {
  return getEmbedsPeerOrNull(input);
}
