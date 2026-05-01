/**
 * Instance-scoped map of plugin name -> plugin-owned state.
 *
 * Each plugin stores its runtime state under its own plugin name key. Values are
 * opaque to the framework; plugins own their state shape and expose typed
 * accessors for dependent plugins.
 */
export type PluginStateMap = ReadonlyMap<string, unknown>;

/**
 * Any object that carries a {@link PluginStateMap}.
 */
export interface PluginStateCarrier {
  /** The instance-scoped plugin state map. */
  readonly pluginState: PluginStateMap;
}

/**
 * Coordinates for locating an entity adapter within plugin state.
 */
export interface EntityAdapterLookup {
  /** Name of the plugin that owns the entity adapter. */
  readonly plugin: string;
  /** Name of the entity whose adapter to retrieve. */
  readonly entity: string;
}
