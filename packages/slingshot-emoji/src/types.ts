import { z } from 'zod';
import type {
  PermissionEvaluator,
  PermissionRegistry,
  PermissionsAdapter,
} from '@lastshotlabs/slingshot-core';

/**
 * Zod validation schema for {@link EmojiPluginConfig}.
 *
 * Used by `createEmojiPlugin()` to validate the raw config object at
 * construction time via `validatePluginConfig()`. Exported so callers can
 * pre-validate config before passing it in.
 *
 * @example
 * ```ts
 * import { emojiPluginConfigSchema } from '@lastshotlabs/slingshot-emoji';
 *
 * const result = emojiPluginConfigSchema.safeParse(rawConfig);
 * if (!result.success) console.error(result.error.issues);
 * ```
 */
export const emojiPluginConfigSchema = z.object({
  /**
   * Base path under which all emoji routes are mounted.
   * Defaults to `'/emoji'`.
   */
  mountPath: z.string().startsWith('/').optional(),
  /**
   * Permission evaluator, registry, and adapter from `@lastshotlabs/slingshot-core`.
   *
   * When omitted, the plugin reads shared permissions state from
   * `ctx.pluginState` (populated by `createPermissionsPlugin()`). Declare
   * `'slingshot-permissions'` as a dependency — or pass this explicitly — to
   * ensure the state is available before the plugin's `setupMiddleware` runs.
   */
  permissions: z
    .object({
      evaluator: z.custom<PermissionEvaluator>(v => v != null && typeof v === 'object', {
        message: 'Expected a PermissionEvaluator instance',
      }),
      registry: z.custom<PermissionRegistry>(v => v != null && typeof v === 'object', {
        message: 'Expected a PermissionRegistry instance',
      }),
      adapter: z.custom<PermissionsAdapter>(v => v != null && typeof v === 'object', {
        message: 'Expected a PermissionsAdapter instance',
      }),
    })
    .loose()
    .optional(),
  /**
   * Deprecated: ignored legacy field that no longer affects runtime behavior.
   *
   * The emoji package does not generate presigned URLs itself. If this field is
   * provided, the plugin warns and ignores it.
   */
  presignExpirySeconds: z.number().int().positive().optional(),
});

/**
 * Fully-typed configuration for the emoji plugin.
 *
 * Inferred from {@link emojiPluginConfigSchema}. Pass a value of this type
 * to `createEmojiPlugin()`. All fields are optional.
 *
 * @remarks
 * **Field summary:**
 *
 * - `mountPath` - Base path for all emoji routes. Defaults to `'/emoji'`.
 * - `permissions` - Optional explicit permission evaluator, registry, and adapter.
 *   When omitted, the plugin reads shared permissions state from `ctx.pluginState`
 *   (populated by `createPermissionsPlugin()`).
 * - `presignExpirySeconds` - Deprecated legacy field. Ignored when provided.
 *
 * @example
 * ```ts
 * import type { EmojiPluginConfig } from '@lastshotlabs/slingshot-emoji';
 *
 * const config: EmojiPluginConfig = {
 *   mountPath: '/emoji',
 *   presignExpirySeconds: 1800, // warns and is ignored
 * };
 * ```
 */
export type EmojiPluginConfig = z.infer<typeof emojiPluginConfigSchema>;

/**
 * Shape of an emoji record as returned by the API.
 *
 * Matches the entity fields defined in the emoji manifest. The `uploadKey`
 * references a file managed by the framework upload system — the emoji plugin
 * does not handle file uploads directly.
 *
 * @remarks
 * Shortcodes must match `/^[a-z0-9_]{2,32}$/` (e.g. `party_parrot`). Validated
 * by middleware in `createEmojiPlugin()` on the create route. Uniqueness is also
 * enforced by the `[orgId, shortcode]` unique index.
 */
export interface EmojiRecord {
  /** Unique emoji identifier (UUID). */
  id: string;
  /** Organisation that owns this emoji. */
  orgId: string;
  /** Display name of the emoji. */
  name: string;
  /**
   * Shortcode used to reference the emoji in text (e.g. `party_parrot`).
   * Must be unique within the org. Format: `/^[a-z0-9_]{2,32}$/`.
   */
  shortcode: string;
  /** Optional grouping category. */
  category?: string;
  /** Whether the emoji is an animated image. */
  animated: boolean;
  /** Storage key referencing the uploaded file in the framework upload system. */
  uploadKey: string;
  /** User ID of the creator. */
  createdBy: string;
  /** Timestamp when the emoji was created. */
  createdAt: Date;
}
