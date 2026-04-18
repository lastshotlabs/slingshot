import { z } from 'zod';

const ChannelAuthConfigSchema = z.enum(['userAuth', 'bearer', 'none']);

const ChannelPermissionConfigSchema = z.object({
  requires: z.string().min(1),
  ownerField: z.string().optional(),
  or: z.string().optional(),
  scope: z.record(z.string(), z.string()).optional(),
});

const ChannelForwardConfigSchema = z.object({
  events: z.array(z.string().min(1)).min(1),
  idField: z.string().optional(),
});

const ChannelReceiveConfigSchema = z.object({
  events: z.array(z.string().min(1)).min(1),
  toRoom: z.boolean().optional(),
  excludeSender: z.boolean().optional(),
});

const EntityChannelDeclarationSchema = z.object({
  auth: ChannelAuthConfigSchema.optional(),
  permission: ChannelPermissionConfigSchema.optional(),
  middleware: z.array(z.string()).optional(),
  forward: ChannelForwardConfigSchema.optional(),
  presence: z.boolean().optional(),
  receive: ChannelReceiveConfigSchema.optional(),
});

/**
 * Zod schema for validating an `EntityChannelConfig` input at runtime.
 *
 * Used by plugin bootstrap and `validateEntityChannelConfig` to catch misconfigured
 * WebSocket channel declarations before server startup. Enforces that `channels` is
 * a non-empty record and that all sub-schemas conform to their expected shapes.
 */
export const entityChannelConfigSchema = z.object({
  channels: z
    .record(z.string(), EntityChannelDeclarationSchema)
    .refine(record => Object.keys(record).length > 0, {
      message: 'channels must not be empty',
    }),
});

/**
 * The input type accepted by `entityChannelConfigSchema`.
 *
 * Equivalent to {@link EntityChannelConfig} from `entityChannelConfig.ts` but
 * reflects Zod's input-side coercions (i.e., what you pass *in* before parsing).
 * Use this type when working with raw or partially-typed config objects that will
 * be validated before use — for example, configs read from JSON files or passed
 * across module boundaries without prior validation.
 *
 * @remarks
 * In practice `EntityChannelConfigInput` and `EntityChannelConfig` are structurally
 * identical because the schema contains no transformations. Prefer importing
 * `EntityChannelConfig` directly when your config object is already validated.
 */
export type EntityChannelConfigInput = z.input<typeof entityChannelConfigSchema>;

/**
 * Validate an entity channel config object against {@link entityChannelConfigSchema}.
 *
 * Returns `{ success: true }` on valid input, or `{ success: false, errors }` with
 * structured Zod validation errors on failure. Never throws — all error information is
 * returned in the result object so callers can surface messages without try/catch.
 *
 * Call this during plugin bootstrap or server startup to catch misconfigured channel
 * declarations before any WebSocket routes are registered.
 *
 * @param config - The raw config object to validate. Typed as `unknown` so it is safe
 *   to pass configs read from JSON, user input, or untyped module exports.
 * @returns An object with `success: true` when validation passes, or
 *   `{ success: false, errors: ZodError }` on failure. Access `errors.format()` for
 *   a nested error map or `errors.issues` for the flat issue list.
 *
 * @remarks
 * This function does not throw. If you need the validated, typed value rather than a
 * boolean result, use `entityChannelConfigSchema.parse(config)` directly (which does throw).
 *
 * @example
 * ```ts
 * import { validateEntityChannelConfig } from '@lastshotlabs/slingshot-core';
 *
 * const result = validateEntityChannelConfig(rawChannelConfig);
 * if (!result.success) {
 *   console.error('Invalid channel config:', result.errors?.format());
 *   process.exit(1);
 * }
 * // rawChannelConfig is safe to use as EntityChannelConfig from here.
 * ```
 */
export function validateEntityChannelConfig(config: unknown): {
  success: boolean;
  errors?: z.ZodError;
} {
  const result = entityChannelConfigSchema.safeParse(config);
  return result.success ? { success: true } : { success: false, errors: result.error };
}
