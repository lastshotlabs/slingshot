import { getContextOrNull } from './context/index';

export type PluginStateMap = Map<string, unknown>;

export interface PluginStateCarrier {
  readonly pluginState: PluginStateMap;
}

function isPluginStateMap(value: unknown): value is PluginStateMap {
  return value instanceof Map;
}

function isPluginStateCarrier(value: unknown): value is PluginStateCarrier {
  if (typeof value !== 'object' || value === null || !('pluginState' in value)) {
    return false;
  }
  return isPluginStateMap((value as { pluginState?: unknown }).pluginState);
}

export function resolvePluginState(
  input: PluginStateMap | PluginStateCarrier | null | undefined,
): PluginStateMap | null {
  if (isPluginStateMap(input)) {
    return input;
  }
  if (isPluginStateCarrier(input)) {
    return input.pluginState;
  }
  return null;
}

export function getPluginStateOrNull(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): PluginStateMap | null {
  const direct = resolvePluginState(
    input as PluginStateMap | PluginStateCarrier | null | undefined,
  );
  if (direct) {
    return direct;
  }
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  return getContextOrNull(input)?.pluginState ?? null;
}

export function getPluginState(
  input: PluginStateMap | PluginStateCarrier | object,
): PluginStateMap {
  const pluginState = getPluginStateOrNull(input);
  if (!pluginState) {
    throw new Error('[slingshot-core] pluginState is not available for this app');
  }
  return pluginState;
}

export function getPluginStateFromRequestOrNull(c: {
  get(key: string): unknown;
}): PluginStateMap | null {
  return getPluginStateOrNull(c.get('slingshotCtx') as PluginStateCarrier | null | undefined);
}

export function getPluginStateFromRequest(c: { get(key: string): unknown }): PluginStateMap {
  const pluginState = getPluginStateFromRequestOrNull(c);
  if (!pluginState) {
    throw new Error('[slingshot-core] pluginState is not available on this request');
  }
  return pluginState;
}
