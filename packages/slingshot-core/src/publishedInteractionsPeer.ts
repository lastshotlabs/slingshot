import type { PluginStateCarrier, PluginStateMap } from './pluginState';
import { getPluginStateOrNull } from './pluginState';

export interface PublishedInteractionsPeer {
  resolveMessageByKindAndId(kind: string, id: string): Promise<{ components?: unknown } | null>;
  updateComponents(kind: string, id: string, components: ReadonlyArray<unknown>): Promise<void>;
}

function isPublishedInteractionsPeer(value: unknown): value is PublishedInteractionsPeer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'resolveMessageByKindAndId') === 'function' &&
    typeof Reflect.get(value, 'updateComponents') === 'function'
  );
}

export function getPublishedInteractionsPeerOrNull<TPeer extends PublishedInteractionsPeer>(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
  pluginKey: string,
): TPeer | null {
  const pluginState = getPluginStateOrNull(input);
  const state = pluginState?.get(pluginKey) as { interactionsPeer?: unknown } | null | undefined;
  if (!isPublishedInteractionsPeer(state?.interactionsPeer)) {
    return null;
  }
  return state.interactionsPeer as TPeer;
}
