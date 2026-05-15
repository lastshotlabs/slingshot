/**
 * Stable plugin-state key published by `slingshot-chat`. Used by the
 * interactions peer bridge (`probeChatPeer`) to discover chat's published
 * `interactionsPeer`.
 *
 * @internal Cross-package code should resolve `ChatInteractionsPeerCap`
 * instead of reading the slot directly.
 */
export const CHAT_PLUGIN_STATE_KEY = 'slingshot-chat' as const;

/**
 * Stable plugin-state key published by `slingshot-community`. Used by the
 * interactions peer bridge (`probeCommunityPeer`) to discover community's
 * published `interactionsPeer`.
 *
 * @internal Cross-package code should resolve `CommunityInteractionsPeerCap`
 * instead of reading the slot directly.
 */
export const COMMUNITY_PLUGIN_STATE_KEY = 'slingshot-community' as const;

/** Stable plugin-state key published by `slingshot-embeds`. */
export const EMBEDS_PLUGIN_STATE_KEY = 'slingshot-embeds' as const;
