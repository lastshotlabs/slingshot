import { getContextOrNull } from './context/index';

const sealedPluginStates = new WeakSet<ReadonlyMap<string, unknown>>();

/**
 * Instance-scoped map of plugin name -> plugin-owned state.
 *
 * Each plugin stores its runtime state under its own {@link SlingshotPlugin.name}
 * key. Values are opaque to the framework - plugins own the shape of their
 * own entries and expose typed accessors for dependent plugins.
 *
 * The public surface is read-only. Framework-owned contexts use a guarded
 * writable implementation during bootstrap, then seal it after app finalization.
 */
export type PluginStateMap = ReadonlyMap<string, unknown>;

/**
 * Writable plugin state used internally by the framework bootstrap lifecycle.
 */
type WritablePluginStateMap = Map<string, unknown>;

function mutationError(operation: string, key?: string): Error {
  const target = key === undefined ? '' : ` for key '${key}'`;
  return new Error(
    `[slingshot-core] pluginState is sealed after app bootstrap; attempted ${operation}${target}. ` +
      'Publish plugin state during setupMiddleware/setupRoutes/setupPost or expose an explicit runtime API.',
  );
}

function isWritablePluginStateMap(value: PluginStateMap): value is WritablePluginStateMap {
  return typeof (value as { set?: unknown }).set === 'function';
}

function assertPluginStateWritable(
  pluginState: PluginStateMap,
  operation: string,
  key?: string,
): asserts pluginState is WritablePluginStateMap {
  if (sealedPluginStates.has(pluginState)) {
    throw mutationError(operation, key);
  }
  if (!isWritablePluginStateMap(pluginState)) {
    throw new Error(
      `[slingshot-core] pluginState does not support ${operation}. Use the framework-owned plugin state during bootstrap.`,
    );
  }
}

/**
 * Framework-owned plugin-state map. It behaves like a normal Map during
 * bootstrap, then rejects mutations after {@link sealPluginState}.
 */
class GuardedPluginStateMap extends Map<string, unknown> {
  constructor(entries?: Iterable<readonly [string, unknown]>) {
    super();
    if (entries) {
      for (const [key, value] of entries) {
        super.set(key, value);
      }
    }
  }

  set(key: string, value: unknown): this {
    if (sealedPluginStates.has(this)) {
      throw mutationError('set', key);
    }
    return super.set(key, value);
  }

  delete(key: string): boolean {
    if (sealedPluginStates.has(this)) {
      throw mutationError('delete', key);
    }
    return super.delete(key);
  }

  clear(): void {
    if (sealedPluginStates.has(this)) {
      throw mutationError('clear');
    }
    super.clear();
  }
}

/**
 * Create the guarded plugin-state map used by framework app contexts.
 */
export function createPluginStateMap(
  entries?: Iterable<readonly [string, unknown]>,
): PluginStateMap {
  return new GuardedPluginStateMap(entries);
}

/**
 * Publish plugin-owned state during framework bootstrap.
 */
export function publishPluginState(pluginState: PluginStateMap, key: string, value: unknown): void {
  assertPluginStateWritable(pluginState, 'set', key);
  pluginState.set(key, value);
}

/**
 * Seal plugin state after app bootstrap so late mutations fail loudly.
 */
export function sealPluginState(pluginState: PluginStateMap): void {
  sealedPluginStates.add(pluginState);
}

/**
 * Returns whether a plugin-state map has been sealed.
 */
export function isPluginStateSealed(pluginState: PluginStateMap): boolean {
  return sealedPluginStates.has(pluginState);
}

/**
 * Any object that carries a {@link PluginStateMap}.
 *
 * Used as an input type so callers can pass either a raw `PluginStateMap` or
 * any container that embeds one (e.g. {@link SlingshotContext}).
 */
export interface PluginStateCarrier {
  /** The instance-scoped plugin state map. */
  readonly pluginState: PluginStateMap;
}

/**
 * Coordinates for locating an entity adapter within plugin state.
 *
 * Used by {@link maybeEntityAdapter} and {@link requireEntityAdapter} to look
 * up a specific entity's adapter from the owning plugin's state entry.
 */
export interface EntityAdapterLookup {
  /** Name of the plugin that owns the entity adapter. */
  readonly plugin: string;
  /** Name of the entity whose adapter to retrieve. */
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

/**
 * Extract a {@link PluginStateMap} from a raw map, a carrier object, or `null`.
 *
 * Returns `null` when the input is `null`, `undefined`, or not a recognised
 * plugin-state container. Does **not** fall back to the ambient context.
 *
 * @param input - A raw `PluginStateMap`, a {@link PluginStateCarrier}, or nullish.
 * @returns The resolved map, or `null` when unavailable.
 */
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

/**
 * Resolve a {@link PluginStateMap} from the given input, falling back to the
 * ambient {@link SlingshotContext} when the input is a plain object that does
 * not directly carry plugin state.
 *
 * @param input - A raw map, carrier, context-bearing object, or nullish.
 * @returns The resolved map, or `null` when unavailable from any source.
 */
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

/**
 * Resolve a {@link PluginStateMap} from the given input, throwing when unavailable.
 *
 * Behaves identically to {@link getPluginStateOrNull} but throws instead of
 * returning `null`. Use this when plugin state is required for correct operation.
 *
 * @param input - A raw map, carrier, or context-bearing object.
 * @returns The resolved plugin state map.
 * @throws When plugin state cannot be resolved from any source.
 */
export function getPluginState(
  input: PluginStateMap | PluginStateCarrier | object,
): PluginStateMap {
  const pluginState = getPluginStateOrNull(input);
  if (!pluginState) {
    throw new Error('[slingshot-core] pluginState is not available for this app');
  }
  return pluginState;
}

/**
 * Read the {@link PluginStateMap} from a Hono request context variable.
 *
 * Looks up `c.get('slingshotCtx')` and resolves plugin state from the
 * resulting carrier. Returns `null` when the context variable is absent.
 *
 * @param c - A Hono-style context with a `get` accessor.
 * @returns The resolved map, or `null` when unavailable.
 */
export function getPluginStateFromRequestOrNull(c: {
  get(key: string): unknown;
}): PluginStateMap | null {
  return getPluginStateOrNull(c.get('slingshotCtx') as PluginStateCarrier | null | undefined);
}

/**
 * Read the {@link PluginStateMap} from a Hono request context variable, throwing
 * when unavailable.
 *
 * Behaves identically to {@link getPluginStateFromRequestOrNull} but throws
 * instead of returning `null`. Use this inside route handlers where plugin state
 * is guaranteed to be present.
 *
 * @param c - A Hono-style context with a `get` accessor.
 * @returns The resolved plugin state map.
 * @throws When plugin state is not available on the request.
 */
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
  publishPluginState(pluginState, pluginName, nextState);
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
