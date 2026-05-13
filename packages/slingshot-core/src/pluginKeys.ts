/** Stable plugin-state key published by `slingshot-chat`. */
export const CHAT_PLUGIN_STATE_KEY = 'slingshot-chat' as const;

/** Stable plugin-state key published by `slingshot-community`. */
export const COMMUNITY_PLUGIN_STATE_KEY = 'slingshot-community' as const;

/**
 * Legacy string-key handle for `slingshot-assets` presence detection in
 * `pluginState`. Kept for peer guards (e.g. `slingshot-chat`,
 * `slingshot-community`) that check `getPluginState(app).has(...)` to fail
 * loudly when an optional peer is missing. The package itself does not
 * publish a runtime to this slot — consumers that need the actual runtime
 * should resolve `AssetsRuntimeCap` through the typed capability surface.
 *
 * @deprecated Use the typed `AssetsRuntimeCap` from `@lastshotlabs/slingshot-assets`.
 *   This constant remains only as a presence-detection convention until
 *   chat/community peer guards migrate to capability-provider lookups.
 */
export const ASSETS_PLUGIN_STATE_KEY = 'slingshot-assets' as const;

/** Stable plugin-state key published by `slingshot-embeds`. */
export const EMBEDS_PLUGIN_STATE_KEY = 'slingshot-embeds' as const;

/** Stable plugin-state key published by `slingshot-polls`. */
export const POLLS_PLUGIN_STATE_KEY = 'slingshot-polls' as const;

/**
 * Legacy string-key handle for `slingshot-push` runtime carried in
 * `pluginState`. The core `pushPeer` helpers (`getPushFormatterPeer`,
 * `getPushFormatterPeerOrNull`) read this slot when callers don't have a
 * typed handle. The package itself no longer publishes a runtime to this
 * slot — consumers that need the actual runtime should resolve
 * `PushRuntimeCap` through the typed capability surface.
 *
 * @deprecated Use the typed `PushRuntimeCap` from `@lastshotlabs/slingshot-push`.
 *   This constant remains only for in-tree peer helpers until they migrate
 *   to capability-provider lookups.
 */
export const PUSH_PLUGIN_STATE_KEY = 'slingshot-push' as const;
