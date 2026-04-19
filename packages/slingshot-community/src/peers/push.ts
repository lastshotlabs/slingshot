import type {
  NotificationRecord,
  PluginStateCarrier,
  PluginStateMap,
} from '@lastshotlabs/slingshot-core';
import { getPluginStateOrNull } from '@lastshotlabs/slingshot-core';

const PUSH_PLUGIN_STATE_KEY = 'slingshot-push' as const;

export type PushFormatterFn = (notification: NotificationRecord) => {
  title: string;
  body?: string;
  url?: string;
  data?: Record<string, unknown>;
};

export interface PushFormatterRegistrar {
  registerFormatter(type: string, fn: PushFormatterFn): void;
}

export function probePushFormatterRegistrar(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): PushFormatterRegistrar | null {
  const pluginState = getPluginStateOrNull(input);
  const state = pluginState?.get(PUSH_PLUGIN_STATE_KEY) as
    | { registerFormatter?: PushFormatterRegistrar['registerFormatter'] }
    | null
    | undefined;
  if (!state || typeof state.registerFormatter !== 'function') {
    return null;
  }
  return state as PushFormatterRegistrar;
}
