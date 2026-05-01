// packages/slingshot-image/src/routes.ts
import type { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { buildCacheKey } from './cache';
import { loadSharp, transformImage } from './transform';
import type { ImageCacheAdapter, ImageFormat, ImagePluginConfig } from './types';
import { ImageTransformError } from './types';

/** Hard upper bounds enforced regardless of config. */
const ABSOLUTE_MAX_DIMENSION = 4096;

/**
 * Validate the `url` query parameter against the configured allowed origins.
 *
 * - Relative URLs (starting with `/`) are always allowed.
 * - Absolute URLs are allowed only if their hostname is in `allowedOrigins`.
 *
 * Returns the validated URL string, or `null` when rejected (SSRF protection).
 *
 * @internal
 */
function validateSourceUrl(rawUrl: string, allowedOrigins: readonly string[]): string | null {
  if (!rawUrl) return null;

  // Relative URLs always allowed
  if (rawUrl.startsWith('/')) return rawUrl;

  // Absolute URL — must have an allowed origin
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Invalid URL — reject
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }

  if (allowedOrigins.includes(parsed.hostname)) {
    return rawUrl;
  }

  return null;
}

/**
 * Fetch image bytes from a source URL.
 *
 * Relative URLs are resolved through the in-process app so they cannot be
 * redirected by an incoming `Host` header.
 *
 * @internal
 */
async function fetchSourceImage(
  app: Hono<AppEnv>,
  sourceUrl: string,
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  const response = sourceUrl.startsWith('/')
    ? await app.request(new Request(`http://slingshot.local${sourceUrl}`))
    : await fetch(sourceUrl);
  if (!response.ok) {
    const fetchTarget = sourceUrl.startsWith('/') ? `app:${sourceUrl}` : sourceUrl;
    throw new Error(
      `[slingshot-image] Failed to fetch source image: ${response.status} ${response.statusText} (${fetchTarget})`,
    );
  }

  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  return { buffer, contentType: contentType.split(';')[0]?.trim() ?? 'application/octet-stream' };
}

/**
 * Parse and validate a format string from the query parameter.
 * Returns `'original'` as the fallback for unrecognised values.
 * @internal
 */
function parseFormat(raw: string | undefined): ImageFormat {
  const valid: ImageFormat[] = ['avif', 'webp', 'jpeg', 'png', 'original'];
  if (!raw) return 'original';
  if (valid.includes(raw as ImageFormat)) return raw as ImageFormat;
  return 'original';
}

/**
 * Register the `GET /_snapshot/image` handler on the given Hono app.
 *
 * This is an internal function — it is not exported from the package's public
 * API. Only `createImagePlugin()` calls this during plugin setup.
 *
 * SSRF protection: the `url` query parameter is validated against
 * `config.allowedOrigins` before any fetch is attempted. Invalid or disallowed
 * URLs return HTTP 400 immediately.
 *
 * @param app - The Hono app instance.
 * @param config - Frozen plugin config.
 * @param cache - Cache adapter (created once per plugin instance).
 * @internal
 */
export function buildImageRouter(
  app: Hono<AppEnv>,
  config: Readonly<
    Required<Pick<ImagePluginConfig, 'allowedOrigins' | 'maxWidth' | 'maxHeight' | 'routePrefix'>>
  >,
  cache: ImageCacheAdapter,
): void {
  const routePrefix = config.routePrefix;
  // Cache sharp reference per plugin instance (resolved once on first request)
  let cachedSharp: Awaited<ReturnType<typeof loadSharp>> | undefined;

  app.get(routePrefix, async c => {
    if (cachedSharp === undefined) cachedSharp = await loadSharp();
    const rawUrl = c.req.query('url') ?? '';
    const rawW = c.req.query('w') ?? '';
    const rawH = c.req.query('h');
    const rawF = c.req.query('f');
    const rawQ = c.req.query('q');

    // SSRF protection — validate URL before any fetch
    const validatedUrl = validateSourceUrl(rawUrl, config.allowedOrigins);
    if (!validatedUrl) {
      return c.json(
        {
          error:
            'Invalid or disallowed image URL. Only relative paths and approved origins are permitted.',
        },
        400,
      );
    }

    // Parse width — required
    const width = parseInt(rawW, 10);
    if (!Number.isInteger(width) || width < 1 || width > ABSOLUTE_MAX_DIMENSION) {
      return c.json(
        { error: `Invalid width: must be an integer between 1 and ${ABSOLUTE_MAX_DIMENSION}.` },
        400,
      );
    }

    // Parse optional height
    let height: number | undefined;
    if (rawH !== undefined && rawH !== '') {
      const parsed = parseInt(rawH, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > ABSOLUTE_MAX_DIMENSION) {
        return c.json(
          { error: `Invalid height: must be an integer between 1 and ${ABSOLUTE_MAX_DIMENSION}.` },
          400,
        );
      }
      height = parsed;
    }

    const format = parseFormat(rawF);
    const quality = rawQ !== undefined ? Math.min(100, Math.max(1, parseInt(rawQ, 10) || 75)) : 75;

    // Cache lookup
    const cacheKey = buildCacheKey(validatedUrl, width, height, format, quality);
    const cached = await cache.get(cacheKey);
    if (cached) {
      return new Response(cached.buffer, {
        headers: {
          'Content-Type': cached.contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Image-Cache': 'HIT',
        },
      });
    }

    // Fetch source image
    let buffer: ArrayBuffer;
    let originalContentType: string;
    try {
      const fetched = await fetchSourceImage(app, validatedUrl);
      buffer = fetched.buffer;
      originalContentType = fetched.contentType;
    } catch (err) {
      console.warn('[slingshot-image] Fetch error:', err);
      return c.json({ error: 'Failed to fetch source image.' }, 502);
    }

    // Transform
    let result: { buffer: ArrayBuffer; contentType: string };
    try {
      result = await transformImage(buffer, originalContentType, {
        width,
        height,
        format,
        quality,
        maxWidth: config.maxWidth,
        maxHeight: config.maxHeight,
      });
    } catch (err) {
      if (err instanceof ImageTransformError) {
        return c.json({ error: err.message }, 400);
      }
      console.warn('[slingshot-image] Transform error:', err);
      return c.json({ error: 'Image transform failed.' }, 500);
    }

    // Store in cache
    await cache.set(cacheKey, {
      buffer: result.buffer,
      contentType: result.contentType,
      generatedAt: Date.now(),
    });

    return new Response(result.buffer, {
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Image-Cache': 'MISS',
      },
    });
  });
}
