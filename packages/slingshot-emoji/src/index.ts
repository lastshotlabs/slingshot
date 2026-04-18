/**
 * @module @lastshotlabs/slingshot-emoji
 *
 * Custom emoji management plugin for slingshot.
 *
 * Provides CRUD routes for custom emoji with org-scoped shortcode uniqueness,
 * permission-guarded access, and event-driven notifications. Emoji assets are
 * managed by the framework upload system — this plugin stores only the
 * `uploadKey` reference.
 *
 * @example
 * ```ts
 * import { createEmojiPlugin } from '@lastshotlabs/slingshot-emoji';
 *
 * const emoji = createEmojiPlugin({ mountPath: '/emoji' });
 * ```
 */
export { createEmojiPlugin } from './plugin';
export { emojiManifest } from './emoji';
export { emojiPluginConfigSchema } from './types';
export type { EmojiPluginConfig, EmojiRecord } from './types';
