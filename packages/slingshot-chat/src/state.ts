/**
 * Plugin state key for slingshot-chat.
 *
 * Consumers look up chat state via
 * `ctx.pluginState.get(CHAT_PLUGIN_STATE_KEY)`.
 *
 * Single-sourced constant — no magic string `'slingshot-chat'` anywhere in
 * cross-package contracts (cold-start invariant #7).
 */
export const CHAT_PLUGIN_STATE_KEY = 'slingshot-chat' as const;
