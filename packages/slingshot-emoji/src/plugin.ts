import type {
  DynamicEventBus,
  PermissionsState,
  PluginSetupContext,
  SlingshotPlugin,
  StorageAdapter,
} from '@lastshotlabs/slingshot-core';
import {
  getContext,
  getPermissionsStateOrNull,
  getPluginState,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import { emojiManifest } from './emoji';
import type { EmojiPluginConfig } from './types';
import { emojiPluginConfigSchema } from './types';

/** Enforces shortcode format: lowercase alphanumeric + underscores, 2–32 chars. */
const SHORTCODE_RE = /^[a-z0-9_]{2,32}$/;

/**
 * Create the emoji plugin for custom emoji management.
 *
 * Wires the Emoji entity through `createEntityPlugin()` using the manifest-driven
 * zero-code path. Routes are permission-guarded and emit events on create/delete.
 *
 * The emoji plugin does NOT handle file uploads. Clients use the framework upload
 * system (presign, upload, then POST emoji metadata with `uploadKey`).
 *
 * **Permissions resolution:** `permissions` in config is optional. When omitted,
 * the plugin reads `PermissionsState` from `ctx.pluginState` (keyed by
 * `PERMISSIONS_STATE_KEY`), which is populated by `createPermissionsPlugin()`
 * during its `setupMiddleware` phase. Declare `'slingshot-permissions'` as a
 * dependency so the framework guarantees ordering.
 *
 * **Shortcode validation:** Shortcodes must match `/^[a-z0-9_]{2,32}$/` (lowercase
 * alphanumeric + underscores, 2–32 chars). Validated by middleware on the create
 * route — returns 400 with a clear error message if the shortcode is invalid.
 *
 * **Delete cascade:** When an emoji is deleted, the plugin subscribes to the
 * `emoji:emoji.deleted` event and calls `storageAdapter.delete(uploadKey)` to
 * remove the uploaded file. Requires `slingshot-uploads` to be registered and
 * a storage adapter to be configured. When no storage adapter is configured,
 * a warning is logged and the cascade is skipped.
 *
 * @param rawConfig - Plugin configuration. Validated against the Zod schema at
 *   construction time; throws if any required field is missing or mis-typed.
 *   All fields are optional.
 * @returns A `SlingshotPlugin` suitable for passing to `createApp()`.
 *
 * @throws {Error} If `rawConfig` fails the Zod schema validation.
 * @throws {Error} If `permissions` is omitted and `PERMISSIONS_STATE_KEY` is
 *   absent from `ctx.pluginState` when `setupMiddleware` runs.
 *
 * @remarks
 * The plugin declares a dependency on `'slingshot-auth'` (always) and
 * `'slingshot-permissions'` (when `permissions` is not provided explicitly).
 *
 * @example
 * ```ts
 * import { createEmojiPlugin } from '@lastshotlabs/slingshot-emoji';
 *
 * // With permissions resolved from pluginState (recommended):
 * const emoji = createEmojiPlugin({});
 *
 * // With explicit permissions:
 * const emoji = createEmojiPlugin({
 *   permissions: { evaluator, registry, adapter },
 *   mountPath: '/custom-emoji',
 * });
 * ```
 */
export function createEmojiPlugin(rawConfig: unknown): SlingshotPlugin {
  const explicitPermissions = (rawConfig as Partial<EmojiPluginConfig> | undefined)?.permissions;

  const config = validatePluginConfig('slingshot-emoji', rawConfig, emojiPluginConfigSchema);

  const frozenConfig = Object.freeze({ ...config });
  if (frozenConfig.presignExpirySeconds !== undefined) {
    console.warn(
      '[slingshot-emoji] `presignExpirySeconds` is deprecated and ignored. Emoji asset URLs are owned by the upload/storage layer.',
    );
  }

  // Inner entity plugin — created in setupMiddleware after permissions are resolved.
  let innerPlugin: SlingshotPlugin | undefined;
  let teardownDeleteCascade: (() => void) | undefined;

  return {
    name: 'slingshot-emoji',
    dependencies:
      explicitPermissions != null
        ? ['slingshot-auth']
        : ['slingshot-auth', 'slingshot-permissions'],

    async setupMiddleware({ app, config: frameworkConfig, bus }: PluginSetupContext) {
      // Resolve permissions — explicit config wins, pluginState fallback.
      const permissions: PermissionsState | undefined =
        explicitPermissions ??
        getPermissionsStateOrNull(getPluginState(app)) ??
        (() => {
          throw new Error(
            '[slingshot-emoji] No permissions available. Either pass `permissions` ' +
              'in the plugin config or register createPermissionsPlugin() before this plugin.',
          );
        })();

      const mountPath = frozenConfig.mountPath ?? '/emoji';

      // Shortcode validation middleware — runs before the entity create route handler.
      // Registered here so it is always ahead of the entity plugin's route registration.
      app.use(mountPath, async (c, next) => {
        if (c.req.method !== 'POST') return next();
        const rawBody: unknown = await c.req.json().catch(() => null);
        const shortcode =
          rawBody != null && typeof rawBody === 'object' && 'shortcode' in rawBody
            ? (rawBody as { shortcode: unknown }).shortcode
            : undefined;
        if (typeof shortcode === 'string' && !SHORTCODE_RE.test(shortcode)) {
          return c.json(
            {
              error: 'Invalid shortcode',
              detail:
                'Shortcode must be 2–32 characters and contain only lowercase letters, digits, and underscores.',
            },
            400,
          );
        }
        return next();
      });

      innerPlugin = createEntityPlugin({
        name: 'slingshot-emoji',
        mountPath,
        manifest: emojiManifest,
        permissions,
      });

      if (innerPlugin.setupMiddleware) {
        await innerPlugin.setupMiddleware({ app, config: frameworkConfig, bus });
      }
    },

    async setupRoutes({ app, config: frameworkConfig, bus }: PluginSetupContext) {
      await innerPlugin?.setupRoutes?.({ app, config: frameworkConfig, bus });
    },

    async setupPost({ app, config: frameworkConfig, bus }: PluginSetupContext) {
      await innerPlugin?.setupPost?.({ app, config: frameworkConfig, bus });

      // Delete cascade — remove the uploaded file when an emoji is deleted.
      const storageAdapter = getContext(app).upload?.adapter as StorageAdapter | null | undefined;
      if (!storageAdapter) {
        console.warn(
          '[slingshot-emoji] No storage adapter configured — emoji delete will not cascade to storage.',
        );
        return;
      }

      // Cast bus for string-keyed subscriptions (same pattern used by wiring helpers).
      const dynamicBus = bus as unknown as Pick<DynamicEventBus, 'on' | 'off'>;

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
      teardownDeleteCascade = () => {
        dynamicBus.off('emoji:emoji.deleted', deletedHandler);
      };
    },

    async teardown() {
      teardownDeleteCascade?.();
      await innerPlugin?.teardown?.();
    },
  };
}
