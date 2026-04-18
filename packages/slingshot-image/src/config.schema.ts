// packages/slingshot-image/src/config.schema.ts
import { z } from 'zod';

/**
 * Zod schema for {@link ImagePluginConfig}.
 *
 * Used by `createImagePlugin()` to validate and freeze config at construction time.
 *
 * @internal
 */
export const imagePluginConfigSchema = z.object({
  allowedOrigins: z
    .array(z.string())
    .optional()
    .describe(
      'Origins allowed to request image routes. Omit to use the plugin default origin policy.',
    ),
  maxWidth: z
    .number()
    .int()
    .positive()
    .max(4096)
    .optional()
    .describe(
      'Maximum transformed image width in pixels. Omit to use the plugin default width limit.',
    ),
  maxHeight: z
    .number()
    .int()
    .positive()
    .max(4096)
    .optional()
    .describe(
      'Maximum transformed image height in pixels. Omit to use the plugin default height limit.',
    ),
  routePrefix: z
    .string()
    .startsWith('/')
    .optional()
    .describe('URL path prefix for image routes. Omit to use the plugin default route prefix.'),
  // cache is a runtime object — not validated by Zod, preserved as-is
  cache: z
    .unknown()
    .optional()
    .describe(
      'Runtime cache implementation for generated image responses. Omit to disable plugin-managed image caching.',
    ),
});

/**
 * Inferred type from the schema — used internally for validated config fields.
 * @internal
 */
export type ImagePluginConfigParsed = z.infer<typeof imagePluginConfigSchema>;
