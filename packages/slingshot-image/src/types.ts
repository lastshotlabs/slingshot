// packages/slingshot-image/src/types.ts

/**
 * Supported output image formats for the image optimization handler.
 */
export type ImageFormat = 'avif' | 'webp' | 'jpeg' | 'png' | 'original';

/**
 * Options controlling how an image is transformed.
 */
export interface ImageTransformOptions {
  /** Target output width in pixels. Integer 1–4096. */
  readonly width: number;
  /** Target output height in pixels. Integer 1–4096. Optional — preserves aspect ratio when omitted. */
  readonly height?: number;
  /**
   * Output format.
   * @default 'original'
   */
  readonly format: ImageFormat;
  /**
   * Compression quality 1–100.
   * @default 75
   */
  readonly quality: number;
  /** Maximum allowed width from plugin config. Used for validation. */
  readonly maxWidth: number;
  /** Maximum allowed height from plugin config. Used for validation. */
  readonly maxHeight: number;
}

/**
 * The result of a successful image transformation.
 */
export interface ImageTransformResult {
  /** Transformed image bytes. */
  readonly buffer: ArrayBuffer;
  /** MIME type of the resulting image (e.g. `'image/webp'`). */
  readonly contentType: string;
}

/**
 * Error thrown when image transform parameters violate configured limits.
 */
export class ImageTransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageTransformError';
  }
}

/**
 * A cached image entry stored by the cache adapter.
 */
export interface ImageCacheEntry {
  /** Transformed image bytes. */
  readonly buffer: ArrayBuffer;
  /** MIME type of the cached image. */
  readonly contentType: string;
  /** Unix timestamp (ms) when this entry was generated. */
  readonly generatedAt: number;
}

/**
 * Cache adapter interface for image responses.
 *
 * Implement this to plug in custom storage (Redis, file system, etc.).
 * The default implementation uses an in-memory LRU map.
 */
export interface ImageCacheAdapter {
  /**
   * Retrieve a cached entry by key.
   * Returns `null` when the key is not present.
   */
  get(key: string): Promise<ImageCacheEntry | null>;
  /**
   * Store an entry under the given key.
   */
  set(key: string, entry: ImageCacheEntry): Promise<void>;
}

/**
 * Configuration for `createImagePlugin()`.
 */
export interface ImagePluginConfig {
  /**
   * Hostnames allowed as image sources for absolute URLs.
   * Relative URLs (starting with `/`) are always allowed.
   *
   * @example `['cdn.example.com', 'assets.example.com']`
   * @default []
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * Maximum output width in pixels.
   * @default 4096
   */
  readonly maxWidth?: number;
  /**
   * Maximum output height in pixels.
   * @default 4096
   */
  readonly maxHeight?: number;
  /**
   * URL prefix for the image optimization route.
   * @default '/_snapshot/image'
   */
  readonly routePrefix?: string;
  /**
   * Cache adapter for transformed images.
   * Defaults to an in-memory LRU cache with 500 entries.
   */
  readonly cache?: ImageCacheAdapter;
}
