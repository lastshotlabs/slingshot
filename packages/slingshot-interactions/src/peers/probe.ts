import type {
  PluginStateCarrier,
  PluginStateMap,
  PublishedInteractionsPeer,
} from '@lastshotlabs/slingshot-core';
import { getPublishedInteractionsPeerOrNull } from '@lastshotlabs/slingshot-core';
import type { InteractionsPeer } from './types';

export function probeInteractionsPeer<TPeer extends InteractionsPeer>(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
  pluginKey: string,
): TPeer | null {
  return getPublishedInteractionsPeerOrNull<TPeer & PublishedInteractionsPeer>(input, pluginKey);
}
