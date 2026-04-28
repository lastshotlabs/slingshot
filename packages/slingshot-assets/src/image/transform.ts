import type { ImageFormat, ImageTransformOptions, ImageTransformResult } from './types';
import { ImageTransformError, ImageTransformTimeoutError } from './types';

const FORMAT_CONTENT_TYPE: Record<Exclude<ImageFormat, 'original'>, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

type SharpConstructor = (
  input?: Buffer,
  options?: {
    limitInputPixels?: number | boolean;
    failOn?: 'none' | 'truncated' | 'error' | 'warning';
  },
) => import('sharp').Sharp;

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

function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ImageTransformTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Transform image bytes using `sharp` when available.
 *
 * The Sharp pipeline is bounded by `opts.timeoutMs` to defend against malformed
 * inputs that hang decoders. Sharp internal limits (`limitInputPixels`) are also
 * applied so a 50000x50000 image header is rejected before allocation.
 *
 * @param buffer - Raw source image bytes.
 * @param originalContentType - MIME type of the source image.
 * @param opts - Requested transform parameters and configured limits.
 * @returns Transformed image bytes and response metadata.
 * @throws {ImageTransformError} When requested dimensions exceed configured limits.
 * @throws {ImageTransformTimeoutError} When the pipeline exceeds opts.timeoutMs.
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
  const limitInputPixels = opts.maxWidth * opts.maxHeight * 4;
  let pipeline = sharpFnResolved(input, { limitInputPixels, failOn: 'truncated' });

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

  const outputBuffer = await withTimeout(pipeline.toBuffer(), opts.timeoutMs);
  return {
    buffer: outputBuffer.buffer.slice(
      outputBuffer.byteOffset,
      outputBuffer.byteOffset + outputBuffer.byteLength,
    ) as ArrayBuffer,
    contentType: resolveContentType(opts.format, originalContentType),
  };
}
