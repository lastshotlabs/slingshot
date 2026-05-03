import {
  CHAT_PLUGIN_STATE_KEY as CORE_CHAT_PLUGIN_STATE_KEY,
  definePluginStateKey,
} from '@lastshotlabs/slingshot-core';
import type { ChatPluginState } from './types';

/**
 * Plugin state key for slingshot-chat.
 *
 * Single-sourced constant — no magic string `'slingshot-chat'` anywhere in
 * cross-package contracts (cold-start invariant #7).
 */
export const CHAT_PLUGIN_STATE_KEY = CORE_CHAT_PLUGIN_STATE_KEY;

/** Typed plugin-state key for the chat runtime slot. */
export const CHAT_RUNTIME_KEY = definePluginStateKey<ChatPluginState>(CHAT_PLUGIN_STATE_KEY);
