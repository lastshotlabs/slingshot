import type {
  NotificationRecord,
  PluginStateCarrier,
  PluginStateMap,
} from '@lastshotlabs/slingshot-core';
import { getPushFormatterPeerOrNull } from '@lastshotlabs/slingshot-core';

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
  return getPushFormatterPeerOrNull(input) as PushFormatterRegistrar | null;
}
