// packages/slingshot-image/src/plugin.ts
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { createMemoryImageCache } from './cache';
import { imagePluginConfigSchema } from './config.schema';
import { buildImageRouter } from './routes';
import type { ImageCacheAdapter, ImagePluginConfig } from './types';

/** Default values for optional config fields. */
const DEFAULTS = {
  allowedOrigins: [] as readonly string[],
  maxWidth: 4096,
  maxHeight: 4096,
  routePrefix: '/_snapshot/image',
} as const;

/**
 * Create the `slingshot-image` plugin.
 *
 * Registers a `GET /_snapshot/image` handler on the Hono app that resizes,
 * converts, and caches image responses. Backed by `sharp` when installed;
 * falls back to serving originals with a warning when `sharp` is absent.
 *
 * **SSRF protection:** The `url` query parameter is validated against
 * `config.allowedOrigins` before any network fetch is attempted. Relative URLs
 * (starting with `/`) are always allowed and resolved against localhost.
 * Absolute URLs are only allowed when their hostname is in `allowedOrigins`.
 *
 * **Factory pattern (Rule 3):** Each call to `createImagePlugin()` creates a
 * fresh, isolated cache instance. No shared mutable state between plugin
 * instances or app instances.
 *
 * @param rawConfig - Plugin configuration. Validated and frozen at construction
 *   time — throws `ZodError` if required fields fail validation.
 * @returns A `SlingshotPlugin` for use with `createApp({ plugins: [...] })`.
 *
 * @throws {ZodError} If `rawConfig` fails schema validation.
 *
 * @example
 * ```ts
 * import { createImagePlugin } from '@lastshotlabs/slingshot-image';
 *
 * const app = await createApp({
 *   plugins: [
 *     createImagePlugin({
 *       allowedOrigins: ['cdn.example.com'],
 *       maxWidth: 2048,
 *       maxHeight: 2048,
 *     }),
 *   ],
 * });
 * ```
 */
export function createImagePlugin(rawConfig?: ImagePluginConfig): SlingshotPlugin {
  // Validate config with Zod (Rule 12: validate and freeze at boundary)
  const validated = imagePluginConfigSchema.parse(rawConfig ?? {});

  // Resolve final config with defaults applied
  const resolvedConfig: Readonly<
    Required<Pick<ImagePluginConfig, 'allowedOrigins' | 'maxWidth' | 'maxHeight' | 'routePrefix'>>
  > = Object.freeze({
    allowedOrigins: validated.allowedOrigins ?? DEFAULTS.allowedOrigins,
    maxWidth: validated.maxWidth ?? DEFAULTS.maxWidth,
    maxHeight: validated.maxHeight ?? DEFAULTS.maxHeight,
    routePrefix: validated.routePrefix ?? DEFAULTS.routePrefix,
  });

  // Closure-owned cache — created once per factory call (Rule 3)
  const cache: ImageCacheAdapter = rawConfig?.cache ?? createMemoryImageCache();

  return {
    name: 'slingshot-image',

    setupRoutes({ app }: PluginSetupContext) {
      buildImageRouter(app, resolvedConfig, cache);
    },
  };
}
