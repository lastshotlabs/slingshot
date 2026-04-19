import type {
  PluginStateCarrier,
  PluginStateMap,
  PushFormatterPeerFn,
} from '@lastshotlabs/slingshot-core';
import { getPushFormatterPeerOrNull } from '@lastshotlabs/slingshot-core';

export interface PushFormatterRegistry {
  registerFormatter(type: string, formatter: PushFormatterPeerFn): void;
}

export function probePushFormatterRegistry(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): PushFormatterRegistry | null {
  return getPushFormatterPeerOrNull(input) as PushFormatterRegistry | null;
}
