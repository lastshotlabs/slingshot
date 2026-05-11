/**
 * @module @lastshotlabs/slingshot-emoji
 *
 * Custom emoji management package for slingshot.
 *
 * Provides CRUD routes for custom emoji with org-scoped shortcode uniqueness,
 * permission-guarded access, and event-driven notifications. Emoji assets are
 * managed by the framework upload system — this package stores only the
 * `uploadKey` reference.
 *
 * @example
 * ```ts
 * import { createEmojiPackage } from '@lastshotlabs/slingshot-emoji';
 *
 * export default defineApp({
 *   plugins: [createPermissionsPlugin({ adapter })],
 *   packages: [createEmojiPackage({ mountPath: '/emoji' })],
 * });
 * ```
 */
export { createEmojiPackage } from './plugin';
export { EmojiEntity, emojiOperations, emojiModule } from './entities/emoji';
export { shortcodeGuard } from './middleware/shortcodeGuard';
export { emojiPackageConfigSchema } from './types';
export type { EmojiPackageConfig, EmojiRecord } from './types';
