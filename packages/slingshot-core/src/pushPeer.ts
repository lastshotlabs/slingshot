import type { NotificationRecord } from './notificationsPeer';
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
  // Read the contract slot the slingshot-push plugin writes via `registerPluginCapabilities`.
  // The capability name used inside slingshot-push for the bundled runtime is `pushRuntime`;
  // we duck-check `registerFormatter` so older legacy publishes (state-key only) still work
  // when test fixtures use the old shape.
  const slot = pluginState?.get('slingshot:package:capabilities:slingshot-push') as
    | Record<string, unknown>
    | undefined;
  const runtime = (slot?.pushRuntime ?? slot) as
    | { registerFormatter?: PushFormatterPeer['registerFormatter'] }
    | undefined;
  if (runtime && typeof runtime.registerFormatter === 'function') {
    return runtime as PushFormatterPeer;
  }
  // Legacy state-key fallback for fixtures that publish PushPluginState directly under
  // `'slingshot-push'`.
  const legacy = pluginState?.get('slingshot-push') as
    | { registerFormatter?: PushFormatterPeer['registerFormatter'] }
    | undefined;
  if (legacy && typeof legacy.registerFormatter === 'function') {
    return legacy as PushFormatterPeer;
  }
  return null;
}
