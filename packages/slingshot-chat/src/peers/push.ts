import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { getPluginStateOrNull } from '@lastshotlabs/slingshot-core';

const PUSH_PLUGIN_STATE_KEY = 'slingshot-push' as const;

export interface PushFormatterRegistry {
  registerFormatter(
    type: string,
    formatter: (
      notification: { targetId: string; data?: Readonly<Record<string, unknown>> },
      defaults?: { icon?: string },
    ) => { title: string; body: string; data?: Record<string, unknown>; icon?: string },
  ): void;
}

export function probePushFormatterRegistry(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): PushFormatterRegistry | null {
  const pluginState = getPluginStateOrNull(input);
  const state = pluginState?.get(PUSH_PLUGIN_STATE_KEY) as
    | { registerFormatter?: PushFormatterRegistry['registerFormatter'] }
    | null
    | undefined;
  if (!state || typeof state.registerFormatter !== 'function') {
    return null;
  }
  return state as PushFormatterRegistry;
}
