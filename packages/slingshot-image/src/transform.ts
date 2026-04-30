// packages/slingshot-image/src/transform.ts
import type { ImageFormat, ImageTransformOptions, ImageTransformResult } from './types';
import { ImageTransformError } from './types';

/** MIME type map for each supported output format. */
const FORMAT_CONTENT_TYPE: Record<Exclude<ImageFormat, 'original'>, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/**
 * Sharp constructor function, lazily resolved once on first call.
 * `null` means sharp is not installed — graceful degradation path.
 * @internal
 */
// Sharp's type is `(options?: SharpOptions) => Sharp` — a callable function.
// We capture only the constructor shape we need.
type SharpConstructor = (input?: Buffer) => import('sharp').Sharp;

/**
 * Attempt to load the `sharp` module. Returns the constructor or null if unavailable.
 * Callers should cache the result in their own closure to avoid repeated import attempts.
 * @internal
 */
export async function loadSharp(): Promise<SharpConstructor | null> {
  try {
    const mod = await import('sharp');
    const fn: SharpConstructor =
      'default' in mod && typeof mod.default === 'function'
        ? (mod.default as unknown as SharpConstructor)
        : (mod as unknown as SharpConstructor);
    return fn;
  } catch {
    console.warn(
      '[slingshot-image] sharp is not installed. Images will be served without optimization. ' +
        'Install sharp for format conversion and resizing: bun add sharp',
    );
    return null;
  }
}

/**
 * Resolve the `Content-Type` for a given format string.
 * Returns the original content type when format is `'original'`.
 * @internal
 */
function resolveContentType(format: ImageFormat, originalContentType: string): string {
  if (format === 'original') return originalContentType;
  return FORMAT_CONTENT_TYPE[format];
}

/**
 * Transforms an image buffer using `sharp` (when installed) or returns the
 * original buffer unchanged with a warning when `sharp` is absent.
 *
 * Validates that the requested dimensions do not exceed the configured maximums
 * before invoking sharp. Throws {@link ImageTransformError} on violation.
 *
 * @param buffer - Raw image bytes from the source URL.
 * @param originalContentType - MIME type of the original image (e.g. `'image/jpeg'`).
 * @param opts - Transform options: target dimensions, format, quality, limits.
 * @returns Transformed image bytes and resulting content type.
 *
 * @throws {ImageTransformError} When requested dimensions exceed `maxWidth` / `maxHeight`.
 */
export async function transformImage(
  buffer: ArrayBuffer,
  originalContentType: string,
  opts: ImageTransformOptions,
): Promise<ImageTransformResult> {
  // Validate dimensions against configured limits
  if (opts.width > opts.maxWidth) {
    throw new ImageTransformError(
      `Requested width ${opts.width} exceeds maximum allowed width ${opts.maxWidth}.`,
    );
  }
  if (opts.height !== undefined && opts.height > opts.maxHeight) {
    throw new ImageTransformError(
      `Requested height ${opts.height} exceeds maximum allowed height ${opts.maxHeight}.`,
    );
  }

  const sharpFnResolved = await loadSharp();

  if (!sharpFnResolved) {
    // Graceful degradation: return original buffer unchanged
    return {
      buffer,
      contentType: resolveContentType(opts.format, originalContentType),
    };
  }

  const input = Buffer.from(buffer);
  let pipeline = sharpFnResolved(input);

  // Resize — height is optional (preserves aspect ratio when omitted)
  pipeline = pipeline.resize({
    width: opts.width,
    height: opts.height,
    fit: 'inside',
    withoutEnlargement: false,
  });

  // Format conversion + quality
  if (opts.format !== 'original') {
    switch (opts.format) {
      case 'avif':
        pipeline = pipeline.avif({ quality: opts.quality });
        break;
      case 'webp':
        pipeline = pipeline.webp({ quality: opts.quality });
        break;
      case 'jpeg':
        pipeline = pipeline.jpeg({ quality: opts.quality });
        break;
      case 'png':
        pipeline = pipeline.png({ quality: opts.quality });
        break;
    }
  }

  const outputBuffer = await pipeline.toBuffer();
  const contentType = resolveContentType(opts.format, originalContentType);

  return {
    buffer: outputBuffer.buffer.slice(
      outputBuffer.byteOffset,
      outputBuffer.byteOffset + outputBuffer.byteLength,
    ) as ArrayBuffer,
    contentType,
  };
}
