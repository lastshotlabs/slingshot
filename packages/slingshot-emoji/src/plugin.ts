import type { DynamicEventBus, StorageAdapter } from '@lastshotlabs/slingshot-core';
import {
  type SlingshotPackageDefinition,
  definePackage,
  getContext,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { emojiModule } from './entities/emoji';
import { shortcodeGuard } from './middleware/shortcodeGuard';
import type { EmojiPackageConfig } from './types';
import { emojiPackageConfigSchema } from './types';

/**
 * Create the emoji package: custom emoji metadata management with org-scoped
 * shortcode uniqueness, permission-guarded CRUD, and event-driven notifications.
 *
 * Emoji assets are managed by the framework upload system — this package stores
 * only the `uploadKey` reference. The `update` route is intentionally disabled
 * (emojis are immutable; delete and re-upload to change).
 *
 * Permissions resolve through the `slingshot-permissions` package, which must be
 * registered before this one. Shortcodes must match `/^[a-z0-9_]{2,32}$/`; the
 * `shortcodeGuard` middleware enforces this on the create route and returns 400
 * with a clear error when violated.
 *
 * When the framework upload system is configured (`ctx.upload.adapter` is set),
 * the package subscribes to `emoji:emoji.deleted` and removes the uploaded file
 * via `storageAdapter.delete(uploadKey)`. When no storage adapter is configured,
 * a warning is logged and the cascade is skipped.
 *
 * @example
 * ```ts
 * import { createEmojiPackage } from '@lastshotlabs/slingshot-emoji';
 *
 * export default defineApp({
 *   packages: [createPermissionsPackage({ adapter: permissionsAdapter })],
 *   packages: [createEmojiPackage({})],
 * });
 * ```
 */
export function createEmojiPackage(rawConfig: unknown): SlingshotPackageDefinition {
  const config: EmojiPackageConfig = validatePluginConfig(
    'slingshot-emoji',
    rawConfig,
    emojiPackageConfigSchema,
  );
  const frozenConfig = Object.freeze({ ...config });
  if (frozenConfig.presignExpirySeconds !== undefined) {
    console.warn(
      '[slingshot-emoji] `presignExpirySeconds` is deprecated and ignored. Emoji asset URLs are owned by the upload/storage layer.',
    );
  }

  let teardownDeleteCascade: (() => void) | undefined;

  return definePackage({
    name: 'slingshot-emoji',
    mountPath: frozenConfig.mountPath ?? '/emoji',
    dependencies: ['slingshot-auth', 'slingshot-permissions'],
    entities: [emojiModule],
    middleware: { shortcodeGuard },
    setupPost(ctx) {
      const storageAdapter = getContext(ctx.app).upload?.adapter as
        | StorageAdapter
        | null
        | undefined;
      if (!storageAdapter) {
        console.warn(
          '[slingshot-emoji] No storage adapter configured — emoji delete will not cascade to storage.',
        );
        return;
      }

      const dynamicBus = ctx.bus as unknown as Pick<DynamicEventBus, 'on' | 'off'>;
      const deletedHandler = async (payload: unknown) => {
        const uploadKey = (payload as Record<string, unknown>).uploadKey as string | undefined;
        if (!uploadKey) {
          console.warn(
            '[slingshot-emoji] emoji:emoji.deleted payload missing uploadKey — skipping delete.',
          );
          return;
        }
        await storageAdapter.delete(uploadKey);
      };
      dynamicBus.on('emoji:emoji.deleted', deletedHandler);
      teardownDeleteCascade = () => dynamicBus.off('emoji:emoji.deleted', deletedHandler);
    },
    teardown() {
      teardownDeleteCascade?.();
      teardownDeleteCascade = undefined;
    },
  });
}
