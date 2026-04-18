import type { ImageFormat, ImageTransformOptions, ImageTransformResult } from './types';
import { ImageTransformError } from './types';

const FORMAT_CONTENT_TYPE: Record<Exclude<ImageFormat, 'original'>, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

type SharpConstructor = (input?: Buffer) => import('sharp').Sharp;

let sharpFn: SharpConstructor | null | undefined;

async function loadSharp(): Promise<SharpConstructor | null> {
  if (sharpFn !== undefined) return sharpFn;
  try {
    const mod = await import('sharp');
    const fn =
      (mod as unknown as { default?: SharpConstructor }).default ??
      (mod as unknown as SharpConstructor);
    sharpFn = fn;
  } catch {
    console.warn(
      '[slingshot-assets] sharp is not installed. Images will be served without optimization. ' +
        'Install sharp for format conversion and resizing: bun add sharp',
    );
    sharpFn = null;
  }
  return sharpFn;
}

function resolveContentType(format: ImageFormat, originalContentType: string): string {
  if (format === 'original') return originalContentType;
  return FORMAT_CONTENT_TYPE[format];
}

/**
 * Transform image bytes using `sharp` when available.
 *
 * When `sharp` is unavailable, this returns the original bytes unchanged and
 * includes a warning header value so callers can signal the degradation.
 *
 * @param buffer - Raw source image bytes.
 * @param originalContentType - MIME type of the source image.
 * @param opts - Requested transform parameters and configured limits.
 * @returns Transformed image bytes and response metadata.
 * @throws {ImageTransformError} When requested dimensions exceed configured limits.
 */
export async function transformImage(
  buffer: ArrayBuffer,
  originalContentType: string,
  opts: ImageTransformOptions,
): Promise<ImageTransformResult> {
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
    return {
      buffer,
      contentType: originalContentType,
      warningHeader: 'sharp unavailable; served original image',
    };
  }

  const input = Buffer.from(buffer);
  let pipeline = sharpFnResolved(input);

  pipeline = pipeline.resize({
    width: opts.width,
    height: opts.height,
    fit: 'inside',
    withoutEnlargement: false,
  });

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
  return {
    buffer: outputBuffer.buffer.slice(
      outputBuffer.byteOffset,
      outputBuffer.byteOffset + outputBuffer.byteLength,
    ) as ArrayBuffer,
    contentType: resolveContentType(opts.format, originalContentType),
  };
}
