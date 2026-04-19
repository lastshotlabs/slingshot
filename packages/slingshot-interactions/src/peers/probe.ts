import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { getPluginStateOrNull } from '@lastshotlabs/slingshot-core';
import type { InteractionsPeer } from './types';

function isInteractionsPeer(value: unknown): value is InteractionsPeer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'resolveMessageByKindAndId') === 'function' &&
    typeof Reflect.get(value, 'updateComponents') === 'function'
  );
}

export function probeInteractionsPeer<TPeer extends InteractionsPeer>(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
  pluginKey: string,
): TPeer | null {
  const pluginState = getPluginStateOrNull(input);
  const state = pluginState?.get(pluginKey) as { interactionsPeer?: unknown } | null | undefined;
  if (!isInteractionsPeer(state?.interactionsPeer)) {
    return null;
  }
  return state.interactionsPeer as TPeer;
}
