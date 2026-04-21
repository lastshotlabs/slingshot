import { getContextOrNull } from './context/index';

export type PluginStateMap = Map<string, unknown>;

export interface PluginStateCarrier {
  readonly pluginState: PluginStateMap;
}

export interface EntityAdapterLookup {
  readonly plugin: string;
  readonly entity: string;
}

type EntityAdapterMap<TAdapter extends object = object> = Readonly<Record<string, TAdapter>>;

interface EntityAdaptersPluginState<TAdapter extends object = object> {
  readonly entityAdapters?: EntityAdapterMap<TAdapter>;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describePluginStatePath(pluginName: string): string {
  return `pluginState['${pluginName}']`;
}

function describeEntityAdaptersPath(pluginName: string): string {
  return `${describePluginStatePath(pluginName)}.entityAdapters`;
}

function resolveEntityAdaptersState(
  pluginState: PluginStateMap,
  pluginName: string,
): EntityAdaptersPluginState | null {
  const state = pluginState.get(pluginName);
  if (state === undefined) {
    return null;
  }
  if (!isPlainObject(state)) {
    throw new Error(
      `[slingshot-core] ${describePluginStatePath(pluginName)} is not mergeable. ` +
        'Expected a plain object owned by that plugin.',
    );
  }
  const entityAdapters = Reflect.get(state, 'entityAdapters');
  if (entityAdapters !== undefined && !isPlainObject(entityAdapters)) {
    throw new Error(
      `[slingshot-core] ${describeEntityAdaptersPath(pluginName)} must be a plain object when present.`,
    );
  }
  return state as EntityAdaptersPluginState;
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

/**
 * Publish canonical entity adapters into the owning plugin's state.
 *
 * The state entry is always a new frozen plain object. Existing top-level keys
 * are preserved, and `entityAdapters` is replaced with a new frozen merged map.
 * Re-publishing the same entity name with a different adapter instance is a
 * startup error so dependent plugins never observe ambiguous adapter identity.
 */
export function publishEntityAdaptersState<TAdapter extends object>(
  pluginState: PluginStateMap,
  pluginName: string,
  entityAdapters: Record<string, TAdapter>,
): Readonly<EntityAdaptersPluginState<TAdapter> & Record<string, unknown>> {
  const existingState = resolveEntityAdaptersState(pluginState, pluginName);
  const existingAdapters = existingState?.entityAdapters;
  const mergedAdapters: Record<string, TAdapter> = {
    ...((existingAdapters ?? {}) as Record<string, TAdapter>),
  };

  for (const [entityName, adapter] of Object.entries(entityAdapters)) {
    const existingAdapter = mergedAdapters[entityName];
    if (existingAdapter && existingAdapter !== adapter) {
      throw new Error(
        `[slingshot-core] Entity adapter '${entityName}' for plugin '${pluginName}' ` +
          'was already published with a different instance.',
      );
    }
    mergedAdapters[entityName] = adapter;
  }

  const nextState = Object.freeze({
    ...(existingState ?? {}),
    entityAdapters: Object.freeze({ ...mergedAdapters }),
  });
  pluginState.set(pluginName, nextState);
  return nextState;
}

/**
 * Read an entity adapter from plugin-owned state when available.
 *
 * Returns `null` when the plugin has not published that entity adapter. Throws
 * when the owning plugin's state shape is malformed.
 */
export function maybeEntityAdapter<TAdapter extends object = object>(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
  lookup: EntityAdapterLookup,
): TAdapter | null {
  const pluginState = getPluginStateOrNull(input);
  if (!pluginState) {
    return null;
  }

  const state = resolveEntityAdaptersState(pluginState, lookup.plugin);
  const adapter = state?.entityAdapters?.[lookup.entity];
  if (typeof adapter !== 'object' || adapter === null) {
    return null;
  }

  return adapter as TAdapter;
}

/**
 * Read an entity adapter from plugin-owned state.
 *
 * Throws with a startup-focused error when the provider plugin has not
 * published the requested adapter yet.
 */
export function requireEntityAdapter<TAdapter extends object = object>(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
  lookup: EntityAdapterLookup,
): TAdapter {
  const adapter = maybeEntityAdapter<TAdapter>(input, lookup);
  if (!adapter) {
    throw new Error(
      `[slingshot-core] Entity adapter '${lookup.entity}' from plugin '${lookup.plugin}' ` +
        'is not available in pluginState. Ensure the provider publishes it during setupRoutes ' +
        'and declare a plugin dependency before reading it.',
    );
  }
  return adapter;
}
