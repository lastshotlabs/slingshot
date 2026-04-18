/** Stable plugin-state key used in `ctx.pluginState`. */
export const DEEP_LINKS_PLUGIN_STATE_KEY = 'slingshot-deep-links' as const;

/** Type of the stable deep-links plugin-state key. */
export type DeepLinksPluginStateKey = typeof DEEP_LINKS_PLUGIN_STATE_KEY;
