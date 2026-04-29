import { HTTPException } from 'hono/http-exception';
import {
  SafeFetchBlockedError,
  SafeFetchDnsError,
  type SafeFetchOptions,
  type StorageAdapter,
  createSafeFetch,
} from '@lastshotlabs/slingshot-core';
import type { Asset, ImageConfig } from '../types';
import { buildCacheKey } from './cache';
import { transformImageStream } from './transform';
import type { ImageCacheAdapter, ImageCacheEntry, ImageFormat } from './types';
import {
  ImageInputTooLargeError,
  ImageSourceBlockedError,
  ImageSourceDnsError,
  ImageTransformError,
  ImageTransformTimeoutError,
} from './types';

/**
 * Hard upper bound for image transform dimensions.
 */
export const ABSOLUTE_MAX_DIMENSION = 4096;

/**
 * Default cap for source image bytes loaded into memory before transform.
 */
export const DEFAULT_MAX_INPUT_BYTES = 25 * 1024 * 1024;

/**
 * Default wall-clock timeout for an image transform pipeline.
 */
export const DEFAULT_TRANSFORM_TIMEOUT_MS = 10_000;

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
  /** Hard ceiling on source bytes (defends against image-bomb DoS). */
  readonly maxInputBytes: number;
  /** Wall-clock budget for the Sharp pipeline. */
  readonly transformTimeoutMs: number;
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

/**
 * Read a `ReadableStream` into an `ArrayBuffer`, aborting if total bytes
 * read would exceed `maxBytes`. Throws `ImageInputTooLargeError` on overflow.
 */
async function streamToBoundedArrayBuffer(
  stream: ReadableStream,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // already cancelled or stream closed — ignore
        }
        throw new ImageInputTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // lock already released — ignore
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
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
 * and must match one of the configured origins exactly, including scheme and
 * explicit port.
 *
 * @param rawUrl - Source URL to validate.
 * @param allowedOrigins - Allowed remote origins.
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

  return allowedOrigins.includes(parsed.origin) ? rawUrl : null;
}

/**
 * Optional safeFetch overrides for {@link fetchSourceImage} (typically used
 * in tests to inject a deterministic resolver / IP-allow predicate without
 * hitting real DNS).
 */
export type FetchSourceImageOverrides = Pick<SafeFetchOptions, 'isIpAllowed' | 'resolveHost'> & {
  /** When provided, this fetch is used directly. Skips safeFetch construction. */
  fetchImpl?: typeof fetch;
};

/**
 * Fetch bytes from a validated URL-backed asset source.
 *
 * Absolute URLs are pinned to a single resolved IP via `createSafeFetch`,
 * which blocks loopback, link-local, private, and multicast IPs by default —
 * eliminating the DNS-rebinding TOCTOU window between origin-allowlist
 * validation and the outbound HTTP request.
 *
 * Relative URLs are resolved against the current request host (or
 * `http://localhost:3000` when none is provided) and use plain `fetch`,
 * since they intentionally target the local server.
 *
 * The fetch is bounded by `maxBytes` and `timeoutMs` to defend against
 * slow-loris and image-bomb attacks.
 *
 * @param sourceUrl - Validated source URL.
 * @param requestHostHeader - Current request host header, when available.
 * @param maxBytes - Hard cap on source bytes.
 * @param timeoutMs - Wall-clock budget for the fetch + read.
 * @param overrides - Optional safeFetch overrides for testing.
 * @returns Image bytes and resolved content type.
 * @throws {ImageSourceBlockedError} When the resolved IP is not allowed.
 * @throws {ImageSourceDnsError} When DNS resolution fails.
 */
export async function fetchSourceImage(
  sourceUrl: string,
  requestHostHeader: string | undefined,
  maxBytes: number,
  timeoutMs: number,
  overrides?: FetchSourceImageOverrides,
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  const isRelative = sourceUrl.startsWith('/');
  const fetchUrl = isRelative
    ? `http://${requestHostHeader ?? 'localhost:3000'}${sourceUrl}`
    : sourceUrl;

  let fetchImpl: typeof fetch;
  if (overrides?.fetchImpl) {
    fetchImpl = overrides.fetchImpl;
  } else if (isRelative) {
    // Relative URLs intentionally target the local server — use plain fetch
    // (which would otherwise be blocked by safeFetch's loopback default).
    fetchImpl = globalThis.fetch as typeof fetch;
  } else {
    const safeFetchOptions: SafeFetchOptions = {
      headersTimeoutMs: timeoutMs,
      bodyTimeoutMs: timeoutMs,
    };
    if (overrides?.isIpAllowed) safeFetchOptions.isIpAllowed = overrides.isIpAllowed;
    if (overrides?.resolveHost) safeFetchOptions.resolveHost = overrides.resolveHost;
    fetchImpl = createSafeFetch(safeFetchOptions);
  }

  let response: Response;
  try {
    response = await fetchImpl(fetchUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof SafeFetchBlockedError) {
      throw new ImageSourceBlockedError(err.ip, err.reason);
    }
    if (err instanceof SafeFetchDnsError) {
      throw new ImageSourceDnsError(err.hostname);
    }
    throw err;
  }
  if (!response.ok) {
    throw new HTTPException(502, {
      message: `Failed to fetch source image: ${response.status} ${response.statusText}`,
    });
  }

  const declaredLength = Number(response.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HTTPException(413, {
      message: `Source image exceeds maximum input size (${declaredLength} > ${maxBytes} bytes).`,
    });
  }

  if (!response.body) {
    throw new HTTPException(502, { message: 'Source image response has no body.' });
  }

  const buffer = await streamToBoundedArrayBuffer(response.body, maxBytes);
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  return {
    buffer,
    contentType: contentType.split(';')[0]?.trim() ?? 'application/octet-stream',
  };
}

/**
 * Fetch bytes for a storage-backed asset, bounded by `maxBytes`.
 *
 * The size is checked against `asset.size` (when known from the entity record)
 * and again against the storage adapter's reported `size`, BEFORE streaming
 * any bytes into memory. This rejects oversized assets with 413 instead of
 * loading the full payload and OOM-ing.
 *
 * @param storage - Storage adapter used by the assets plugin.
 * @param asset - Asset record to load.
 * @param maxBytes - Hard cap on source bytes.
 * @returns Image bytes and content type for the stored asset.
 */
export async function fetchStoredImage(
  storage: StorageAdapter,
  asset: Asset,
  maxBytes: number,
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  if (asset.size != null && asset.size > maxBytes) {
    throw new HTTPException(413, {
      message: `Stored asset exceeds maximum input size (${asset.size} > ${maxBytes} bytes).`,
    });
  }

  const stored = await storage.get(asset.key);
  if (!stored) {
    throw new HTTPException(404, { message: 'Asset content not found' });
  }

  // Storage adapter may know the size even when the entity record does not.
  // Reject oversized assets BEFORE we begin reading bytes.
  if (typeof stored.size === 'number' && stored.size > maxBytes) {
    try {
      await stored.stream.cancel();
    } catch {
      // ignore
    }
    throw new HTTPException(413, {
      message: `Stored asset exceeds maximum input size (${stored.size} > ${maxBytes} bytes).`,
    });
  }

  return {
    buffer: await streamToBoundedArrayBuffer(stored.stream, maxBytes),
    contentType: stored.mimeType ?? asset.mimeType ?? 'application/octet-stream',
  };
}

function isUrlBackedAssetKey(key: string): boolean {
  return key.startsWith('/') || /^https?:\/\//.test(key);
}

function buildResponseHeaders(
  result: { contentType: string; warningHeader?: string },
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
    maxInputBytes: config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    transformTimeoutMs: config.transformTimeoutMs ?? DEFAULT_TRANSFORM_TIMEOUT_MS,
  });
}

/**
 * Serve an optimized image response for an asset.
 *
 * The asset is usually read from storage by `asset.key`. If the key itself is a
 * relative or absolute URL, the request is SSRF-validated and fetched remotely.
 *
 * Source bytes are streamed with a hard `maxInputBytes` cap and the Sharp
 * pipeline is bounded by `transformTimeoutMs`. Cache keys are scoped by
 * tenant and owner to prevent cross-tenant leakage.
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
  const cacheKey = buildCacheKey({
    tenantId: asset.tenantId ?? null,
    ownerUserId: asset.ownerUserId ?? null,
    source: asset.key,
    width,
    height,
    format,
    quality,
  });

  let cached: ImageCacheEntry | null = null;
  try {
    cached = await cache.get(cacheKey);
  } catch {
    // Cache read failure is non-fatal — proceed to transform
  }
  if (cached) {
    return new Response(cached.buffer, {
      headers: buildResponseHeaders(cached, 'HIT'),
    });
  }

  // Source fetch + transform share a single wall-clock budget. If reading the
  // source from storage hangs (slow network, frozen adapter), the budget fires
  // and we surface 504 to the caller rather than tying up the request thread.
  let source: { buffer: ArrayBuffer; contentType: string };
  const sourceTimeoutController = new AbortController();
  const sourceTimer = setTimeout(
    () => sourceTimeoutController.abort(),
    imageConfig.transformTimeoutMs,
  );
  try {
    const sourcePromise = (async () => {
      if (isUrlBackedAssetKey(asset.key)) {
        const validatedUrl = validateSourceUrl(asset.key, imageConfig.allowedOrigins);
        if (!validatedUrl) {
          throw new HTTPException(400, {
            message:
              'Invalid or disallowed image URL. Only relative paths and approved origins are permitted.',
          });
        }
        return fetchSourceImage(
          validatedUrl,
          requestHostHeader,
          imageConfig.maxInputBytes,
          imageConfig.transformTimeoutMs,
        );
      }
      return fetchStoredImage(storage, asset, imageConfig.maxInputBytes);
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      sourceTimeoutController.signal.addEventListener(
        'abort',
        () => reject(new ImageTransformTimeoutError(imageConfig.transformTimeoutMs)),
        { once: true },
      );
    });

    source = await Promise.race([sourcePromise, timeoutPromise]);
  } catch (error: unknown) {
    if (error instanceof ImageInputTooLargeError) {
      throw new HTTPException(413, { message: error.message });
    }
    if (error instanceof ImageTransformTimeoutError) {
      throw new HTTPException(504, { message: error.message });
    }
    if (error instanceof ImageSourceBlockedError) {
      throw new HTTPException(400, { message: error.message });
    }
    if (error instanceof ImageSourceDnsError) {
      throw new HTTPException(502, { message: error.message });
    }
    throw error;
  } finally {
    clearTimeout(sourceTimer);
  }

  let transform: Awaited<ReturnType<typeof transformImageStream>>;
  try {
    transform = await transformImageStream(source.buffer, source.contentType, {
      width,
      height,
      format,
      quality,
      maxWidth: imageConfig.maxWidth,
      maxHeight: imageConfig.maxHeight,
      timeoutMs: imageConfig.transformTimeoutMs,
      maxBufferBytes: imageConfig.maxInputBytes,
    });
  } catch (error: unknown) {
    if (error instanceof ImageTransformError) {
      throw new HTTPException(400, { message: error.message });
    }
    throw error;
  }

  // Wall-clock timeout for the transform pipeline. If the transform hangs
  // (malformed input, decoder deadlock), abort the pipeline and return 504.
  // The race resolves when the pipeline produces its first byte; once the
  // response is streaming, the AbortController is no longer needed.
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    timeoutController.abort();
    transform.abort();
  }, imageConfig.transformTimeoutMs);

  // Wait for the first chunk so timeouts surface as 504 instead of a streamed
  // error response. We do this by tee()ing once more and reading the first chunk
  // off one branch while keeping the other for the response body.
  const [probeBranch, bodyBranch] = transform.stream.tee();
  let firstChunk: Uint8Array | null = null;
  let probeDone: boolean;
  try {
    const probeReader = probeBranch.getReader();
    const probeRead = probeReader.read();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutController.signal.addEventListener(
        'abort',
        () => reject(new ImageTransformTimeoutError(imageConfig.transformTimeoutMs)),
        { once: true },
      );
    });
    try {
      const result = await Promise.race([probeRead, timeoutPromise]);
      firstChunk = result.done ? null : (result.value as Uint8Array);
      probeDone = result.done;
    } finally {
      try {
        probeReader.releaseLock();
      } catch {
        // ignore
      }
      // Drain the probe branch in the background so the tee() consumer doesn't
      // back up. We don't care about the bytes — they're already in bodyBranch.
      void probeBranch.cancel().catch(() => {});
    }
  } catch (error: unknown) {
    clearTimeout(timeoutHandle);
    if (error instanceof ImageTransformTimeoutError) {
      throw new HTTPException(504, { message: error.message });
    }
    if (error instanceof ImageTransformError) {
      throw new HTTPException(400, { message: error.message });
    }
    throw error;
  }
  clearTimeout(timeoutHandle);

  // Cache asynchronously; failures are non-fatal.
  void transform.cachePromise
    .then(async cachedBuffer => {
      if (cachedBuffer == null) return;
      const cacheEntry: ImageCacheEntry = {
        buffer: cachedBuffer,
        contentType: transform.contentType,
        ...(transform.warningHeader ? { warningHeader: transform.warningHeader } : {}),
        generatedAt: Date.now(),
      };
      try {
        await cache.set(cacheKey, cacheEntry);
      } catch {
        // Cache write failure is non-fatal — the response already streamed.
      }
    })
    .catch(() => {
      // ignore — caching is best-effort
    });

  // Compose response stream: first chunk (if any) prepended in front of the
  // remaining body branch. This preserves the streaming property — we only
  // bufferred a single chunk to detect timeouts.
  const responseStream =
    firstChunk == null && probeDone
      ? bodyBranch
      : new ReadableStream<Uint8Array>({
          async start(controller) {
            if (firstChunk != null) {
              controller.enqueue(firstChunk);
            }
            const reader = bodyBranch.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value instanceof Uint8Array) controller.enqueue(value);
              }
              controller.close();
            } catch (err) {
              try {
                controller.error(err);
              } catch {
                // ignore
              }
            } finally {
              try {
                reader.releaseLock();
              } catch {
                // ignore
              }
            }
          },
          cancel() {
            void bodyBranch.cancel().catch(() => {});
            transform.abort();
          },
        });

  return new Response(responseStream, {
    headers: buildResponseHeaders(
      {
        contentType: transform.contentType,
        ...(transform.warningHeader ? { warningHeader: transform.warningHeader } : {}),
      },
      'MISS',
    ),
  });
}
