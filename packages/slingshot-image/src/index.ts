// packages/slingshot-image/src/index.ts

/**
 * @lastshotlabs/slingshot-image
 *
 * Image optimization plugin for slingshot. Registers a `GET /_snapshot/image`
 * handler that resizes, converts, and caches images on the fly.
 *
 * Backed by `sharp` when installed; falls back to serving originals when absent.
 */

export { createImagePlugin } from './plugin';
export { createMemoryImageCache } from './cache';
export { ImageTransformError } from './types';
export type {
  ImageFormat,
  ImageTransformOptions,
  ImageTransformResult,
  ImageCacheAdapter,
  ImageCacheEntry,
  ImagePluginConfig,
} from './types';
