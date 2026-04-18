import { HTTPException } from 'hono/http-exception';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import type { Asset, ImageConfig } from '../types';
import { buildCacheKey } from './cache';
import { transformImage } from './transform';
import type {
  ImageCacheAdapter,
  ImageCacheEntry,
  ImageFormat,
  ImageTransformResult,
} from './types';
import { ImageTransformError } from './types';

/**
 * Hard upper bound for image transform dimensions.
 */
export const ABSOLUTE_MAX_DIMENSION = 4096;

/**
 * Resolved image configuration with defaults applied.
 */
export interface ResolvedImageConfig {
  /** Allowed remote origins for URL-backed assets. */
  readonly allowedOrigins: readonly string[];
  /** Maximum output width. */
  readonly maxWidth: number;
  /** Maximum output height. */
  readonly maxHeight: number;
}

/**
 * Request parameters for image serving.
 */
export interface ServeImageParams {
  /** Asset ID from the entity operation path. */
  readonly id: string;
  /** Requested width query param. */
  readonly w: unknown;
  /** Requested height query param. */
  readonly h?: unknown;
  /** Requested format query param. */
  readonly f?: unknown;
  /** Requested quality query param. */
  readonly q?: unknown;
}

function streamToArrayBuffer(stream: ReadableStream): Promise<ArrayBuffer> {
  return new Response(stream).arrayBuffer();
}

function coercePositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > ABSOLUTE_MAX_DIMENSION) {
    throw new HTTPException(400, {
      message: `Invalid ${field}: must be an integer between 1 and ${ABSOLUTE_MAX_DIMENSION}.`,
    });
  }
  return parsed;
}

function coerceOptionalHeight(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return coercePositiveInteger(value, 'height');
}

function parseQuality(value: unknown): number {
  if (value === undefined || value === null || value === '') return 75;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 75;
  return Math.min(100, Math.max(1, Math.trunc(parsed)));
}

/**
 * Parse a requested image format string.
 *
 * @param raw - Requested format parameter.
 * @returns A supported image format, defaulting to `'original'`.
 */
export function parseImageFormat(raw: unknown): ImageFormat {
  switch (raw) {
    case 'avif':
    case 'webp':
    case 'jpeg':
    case 'png':
    case 'original':
      return raw;
    default:
      return 'original';
  }
}

/**
 * Validate a URL-backed asset source against allowed origins.
 *
 * Relative URLs are always allowed. Absolute URLs must use `http:` or `https:`
 * and must match one of the configured hostnames.
 *
 * @param rawUrl - Source URL to validate.
 * @param allowedOrigins - Allowed remote hostnames.
 * @returns The validated URL, or `null` when disallowed.
 */
export function validateSourceUrl(
  rawUrl: string,
  allowedOrigins: readonly string[],
): string | null {
  if (!rawUrl) return null;
  if (rawUrl.startsWith('/')) return rawUrl;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }

  return allowedOrigins.includes(parsed.hostname) ? rawUrl : null;
}

/**
 * Fetch bytes from a validated URL-backed asset source.
 *
 * Relative URLs are resolved against the current host when provided, otherwise
 * `http://localhost:3000`.
 *
 * @param sourceUrl - Validated source URL.
 * @param requestHostHeader - Current request host header, when available.
 * @returns Image bytes and resolved content type.
 */
export async function fetchSourceImage(
  sourceUrl: string,
  requestHostHeader?: string,
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  const fetchUrl = sourceUrl.startsWith('/')
    ? `http://${requestHostHeader ?? 'localhost:3000'}${sourceUrl}`
    : sourceUrl;

  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new HTTPException(502, {
      message: `Failed to fetch source image: ${response.status} ${response.statusText}`,
    });
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  return {
    buffer: await response.arrayBuffer(),
    contentType: contentType.split(';')[0]?.trim() ?? 'application/octet-stream',
  };
}

/**
 * Fetch bytes for a storage-backed asset.
 *
 * @param storage - Storage adapter used by the assets plugin.
 * @param asset - Asset record to load.
 * @returns Image bytes and content type for the stored asset.
 */
export async function fetchStoredImage(
  storage: StorageAdapter,
  asset: Asset,
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  const stored = await storage.get(asset.key);
  if (!stored) {
    throw new HTTPException(404, { message: 'Asset content not found' });
  }

  return {
    buffer: await streamToArrayBuffer(stored.stream),
    contentType: stored.mimeType ?? asset.mimeType ?? 'application/octet-stream',
  };
}

function isUrlBackedAssetKey(key: string): boolean {
  return key.startsWith('/') || /^https?:\/\//.test(key);
}

function buildResponseHeaders(
  result: ImageTransformResult | ImageCacheEntry,
  cacheStatus: 'HIT' | 'MISS',
): Headers {
  const headers = new Headers({
    'Content-Type': result.contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Image-Cache': cacheStatus,
  });
  if (result.warningHeader) {
    headers.set('X-Image-Warning', result.warningHeader);
  }
  return headers;
}

/**
 * Resolve and normalize the image config section from assets plugin config.
 *
 * @param config - Raw image config from `AssetsPluginConfig`.
 * @returns Resolved config with defaults, or `null` when image serving is disabled.
 */
export function resolveImageConfig(config: ImageConfig | undefined): ResolvedImageConfig | null {
  if (!config) return null;
  return Object.freeze({
    allowedOrigins: config.allowedOrigins ?? [],
    maxWidth: config.maxWidth ?? ABSOLUTE_MAX_DIMENSION,
    maxHeight: config.maxHeight ?? ABSOLUTE_MAX_DIMENSION,
  });
}

/**
 * Serve an optimized image response for an asset.
 *
 * The asset is usually read from storage by `asset.key`. If the key itself is a
 * relative or absolute URL, the request is SSRF-validated and fetched remotely.
 *
 * @param deps - Asset source, storage adapter, cache, and request params.
 * @returns A binary `Response` containing the transformed image.
 */
export async function createServeImageResponse(deps: {
  asset: Asset;
  storage: StorageAdapter;
  cache: ImageCacheAdapter;
  imageConfig: ResolvedImageConfig;
  params: ServeImageParams;
  requestHostHeader?: string;
}): Promise<Response> {
  const { asset, storage, cache, imageConfig, params, requestHostHeader } = deps;

  const width = coercePositiveInteger(params.w, 'width');
  const height = coerceOptionalHeight(params.h);
  const format = parseImageFormat(params.f);
  const quality = parseQuality(params.q);
  const cacheKey = buildCacheKey(asset.key, width, height, format, quality);

  const cached = await cache.get(cacheKey);
  if (cached) {
    return new Response(cached.buffer, {
      headers: buildResponseHeaders(cached, 'HIT'),
    });
  }

  let source: { buffer: ArrayBuffer; contentType: string };
  if (isUrlBackedAssetKey(asset.key)) {
    const validatedUrl = validateSourceUrl(asset.key, imageConfig.allowedOrigins);
    if (!validatedUrl) {
      throw new HTTPException(400, {
        message:
          'Invalid or disallowed image URL. Only relative paths and approved origins are permitted.',
      });
    }
    source = await fetchSourceImage(validatedUrl, requestHostHeader);
  } else {
    source = await fetchStoredImage(storage, asset);
  }

  let result: ImageTransformResult;
  try {
    result = await transformImage(source.buffer, source.contentType, {
      width,
      height,
      format,
      quality,
      maxWidth: imageConfig.maxWidth,
      maxHeight: imageConfig.maxHeight,
    });
  } catch (error: unknown) {
    if (error instanceof ImageTransformError) {
      throw new HTTPException(400, { message: error.message });
    }
    throw error;
  }

  const cacheEntry: ImageCacheEntry = {
    buffer: result.buffer,
    contentType: result.contentType,
    ...(result.warningHeader ? { warningHeader: result.warningHeader } : {}),
    generatedAt: Date.now(),
  };
  await cache.set(cacheKey, cacheEntry);

  return new Response(result.buffer, {
    headers: buildResponseHeaders(result, 'MISS'),
  });
}
