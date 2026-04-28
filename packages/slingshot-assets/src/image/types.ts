/**
 * Supported output image formats for the asset image handler.
 */
export type ImageFormat = 'avif' | 'webp' | 'jpeg' | 'png' | 'original';

/**
 * Options controlling how an image is transformed.
 */
export interface ImageTransformOptions {
  /** Target output width in pixels. */
  readonly width: number;
  /** Target output height in pixels. Preserves aspect ratio when omitted. */
  readonly height?: number;
  /** Requested output format. */
  readonly format: ImageFormat;
  /** Compression quality from 1 to 100. */
  readonly quality: number;
  /** Maximum allowed width from plugin config. */
  readonly maxWidth: number;
  /** Maximum allowed height from plugin config. */
  readonly maxHeight: number;
  /** Hard ceiling for transform wall-clock time. */
  readonly timeoutMs: number;
}

/**
 * Error thrown when transformation exceeds the configured wall-clock budget.
 */
export class ImageTransformTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Image transform exceeded ${timeoutMs}ms`);
    this.name = 'ImageTransformTimeoutError';
  }
}

/**
 * Error thrown when source bytes exceed the configured input size limit.
 */
export class ImageInputTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Image source bytes exceed maxInputBytes=${maxBytes}`);
    this.name = 'ImageInputTooLargeError';
  }
}

/**
 * Error thrown when a source image URL resolves to a private/loopback IP.
 *
 * Surfaced when `safeFetch` rejects the resolved IP — protects against the
 * DNS-rebinding TOCTOU window between origin allowlist validation and the
 * actual outbound HTTP request.
 */
export class ImageSourceBlockedError extends Error {
  constructor(
    public ip: string,
    public reason: string,
  ) {
    super(`Image source blocked: resolved IP ${ip} is not allowed (${reason})`);
    this.name = 'ImageSourceBlockedError';
  }
}

/**
 * Error thrown when DNS resolution for a source image hostname fails.
 */
export class ImageSourceDnsError extends Error {
  constructor(public hostname: string) {
    super(`Image source DNS resolve failed: ${hostname}`);
    this.name = 'ImageSourceDnsError';
  }
}

/**
 * Result of a successful image transform.
 */
export interface ImageTransformResult {
  /** Resulting image bytes. */
  readonly buffer: ArrayBuffer;
  /** MIME type of the returned bytes. */
  readonly contentType: string;
  /** Optional warning header value for degraded responses. */
  readonly warningHeader?: string;
}

/**
 * Error thrown when a requested transform exceeds configured limits.
 */
export class ImageTransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageTransformError';
  }
}

/**
 * Cached transformed image entry.
 */
export interface ImageCacheEntry {
  /** Transformed image bytes. */
  readonly buffer: ArrayBuffer;
  /** MIME type of the cached image. */
  readonly contentType: string;
  /** Optional warning header propagated from transform fallback mode. */
  readonly warningHeader?: string;
  /** Unix timestamp in milliseconds when the cache entry was generated. */
  readonly generatedAt: number;
}

/**
 * Cache adapter contract for transformed images.
 */
export interface ImageCacheAdapter {
  /**
   * Read a cached image entry.
   *
   * @param key - Deterministic cache key for the requested transform.
   * @returns The cached entry, or `null` when no entry exists.
   */
  get(key: string): Promise<ImageCacheEntry | null>;

  /**
   * Store a transformed image entry.
   *
   * @param key - Deterministic cache key for the requested transform.
   * @param entry - Transformed image payload to store.
   */
  set(key: string, entry: ImageCacheEntry): Promise<void>;

  /**
   * Optional health snapshot of the cache. Implementations may expose entry
   * count and eviction counters for observability.
   */
  getHealth?(): ImageCacheHealth;
}

/**
 * Point-in-time observability snapshot for an image cache adapter.
 */
export interface ImageCacheHealth {
  /** Current number of cached entries. */
  readonly size: number;
  /** Cumulative number of LRU evictions performed since the cache was created. */
  readonly evictionCount: number;
  /**
   * Cumulative number of TTL-based evictions performed since the cache was
   * created (entries dropped on access because they had expired). Omitted for
   * adapters that do not implement TTL eviction.
   */
  readonly ttlEvictionCount?: number;
}
