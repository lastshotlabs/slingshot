import { z } from 'zod';

/**
 * Zod validation schema for {@link EmojiPackageConfig}.
 *
 * Used by `createEmojiPackage()` to validate the raw config at construction time.
 */
export const emojiPackageConfigSchema = z.object({
  /**
   * Base path under which all emoji routes are mounted.
   * Defaults to `'/emoji'`.
   */
  mountPath: z.string().startsWith('/').optional(),
  /**
   * Deprecated: ignored legacy field that no longer affects runtime behavior.
   *
   * The emoji package does not generate presigned URLs itself. If this field is
   * provided, the package warns and ignores it.
   */
  presignExpirySeconds: z.number().int().positive().optional(),
});

/**
 * Fully-typed configuration for the emoji package.
 *
 * Pass a value of this type to `createEmojiPackage()`. All fields are optional.
 *
 * Permissions resolve through the `slingshot-permissions` package, which must be
 * registered before this one. Apps that need a custom permissions adapter should
 * configure it on the permissions package, not here.
 */
export type EmojiPackageConfig = z.infer<typeof emojiPackageConfigSchema>;
/** Canonical plugin configuration name. */
export type EmojiPluginConfig = EmojiPackageConfig;

/**
 * Shape of an emoji record as returned by the API.
 *
 * Matches the entity fields defined in `src/entities/emoji.ts`. The `uploadKey`
 * references a file managed by the framework upload system — the emoji package
 * does not handle file uploads directly.
 *
 * Shortcodes must match `/^[a-z0-9_]{2,32}$/` (e.g. `party_parrot`). Validated
 * by the `shortcodeGuard` middleware on the create route. Uniqueness is enforced
 * by the `[orgId, shortcode]` unique index.
 */
export interface EmojiRecord {
  /** Unique emoji identifier (UUID). */
  id: string;
  /** Organisation that owns this emoji. */
  orgId: string;
  /** Display name of the emoji. */
  name: string;
  /** Shortcode used to reference the emoji in text. Must be unique within the org. */
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
