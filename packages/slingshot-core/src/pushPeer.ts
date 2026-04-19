import type { NotificationRecord } from './notificationsPeer';
import { PUSH_PLUGIN_STATE_KEY } from './pluginKeys';
import type { PluginStateCarrier, PluginStateMap } from './pluginState';
import { getPluginStateOrNull } from './pluginState';

export interface PushMessageLike {
  readonly title: string;
  readonly body?: string;
  readonly data?: Record<string, unknown>;
  readonly icon?: string;
  readonly badge?: string;
  readonly url?: string;
}

export type PushFormatterPeerFn = (
  notification: NotificationRecord,
  defaults?: Partial<PushMessageLike>,
) => PushMessageLike;

export interface PushFormatterPeer {
  registerFormatter(type: string, formatter: PushFormatterPeerFn): void;
}

export function getPushFormatterPeer(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): PushFormatterPeer {
  const state = getPushFormatterPeerOrNull(input);
  if (!state) {
    throw new Error('[slingshot-push] push formatter peer is not available in pluginState');
  }
  return state;
}

export function getPushFormatterPeerOrNull(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): PushFormatterPeer | null {
  const pluginState = getPluginStateOrNull(input);
  const state = pluginState?.get(PUSH_PLUGIN_STATE_KEY) as
    | { registerFormatter?: PushFormatterPeer['registerFormatter'] }
    | null
    | undefined;
  if (!state || typeof state.registerFormatter !== 'function') {
    return null;
  }
  return state as PushFormatterPeer;
}
