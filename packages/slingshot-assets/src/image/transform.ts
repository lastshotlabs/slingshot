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
    // Interop shim: sharp publishes both an ESM default export and a CJS
    // module.exports = sharp shape; the runtime payload depends on the loader.
    type SharpModule = { default?: SharpConstructor } & SharpConstructor;
    const interop = mod as unknown as SharpModule;
    sharpFn = interop.default ?? interop;
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
 * Race a promise against a wall-clock timeout. The supplied `AbortController`
 * is aborted on timeout so downstream consumers (Sharp pipeline, fs reads)
 * can terminate work in-flight rather than leaking resources.
 */
function withAbortableTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ImageTransformTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([task(controller.signal), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Apply common Sharp pipeline configuration: resize and format conversion.
 */
function applySharpPipeline(
  pipeline: import('sharp').Sharp,
  opts: ImageTransformOptions,
): import('sharp').Sharp {
  let p = pipeline.resize({
    width: opts.width,
    height: opts.height,
    fit: 'inside',
    withoutEnlargement: false,
  });
  if (opts.format !== 'original') {
    switch (opts.format) {
      case 'avif':
        p = p.avif({ quality: opts.quality });
        break;
      case 'webp':
        p = p.webp({ quality: opts.quality });
        break;
      case 'jpeg':
        p = p.jpeg({ quality: opts.quality });
        break;
      case 'png':
        p = p.png({ quality: opts.quality });
        break;
    }
  }
  return p;
}

/**
 * Transform image bytes using `sharp` when available.
 *
 * The Sharp pipeline is bounded by `opts.timeoutMs` to defend against malformed
 * inputs that hang decoders. Sharp internal limits (`limitInputPixels`) are also
 * applied so a 50000x50000 image header is rejected before allocation.
 *
 * NOTE: this entry point still produces a single ArrayBuffer because callers
 * need it for in-memory caching and `<= 25 MiB` payload sizes are bounded by
 * `maxInputBytes`. For unbounded streaming output, use {@link transformImageStream}.
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
  const pipeline = applySharpPipeline(
    sharpFnResolved(input, { limitInputPixels, failOn: 'truncated' }),
    opts,
  );

  const outputBuffer = await withAbortableTimeout(signal => {
    // Abort the Sharp pipeline if the timeout fires while the pipeline is busy.
    signal.addEventListener(
      'abort',
      () => {
        try {
          pipeline.destroy();
        } catch {
          // pipeline already destroyed — ignore
        }
      },
      { once: true },
    );
    return pipeline.toBuffer();
  }, opts.timeoutMs);

  return {
    buffer: outputBuffer.buffer.slice(
      outputBuffer.byteOffset,
      outputBuffer.byteOffset + outputBuffer.byteLength,
    ) as ArrayBuffer,
    contentType: resolveContentType(opts.format, originalContentType),
  };
}

/**
 * Streaming counterpart to {@link transformImage}.
 *
 * Wires the Sharp pipeline output to a `ReadableStream` so transformed bytes
 * flow to the response body without ever materializing a complete buffer in
 * memory. Includes a `tee()` branch so callers may opportunistically populate
 * a cache while the response streams; that branch is bounded by `maxBufferBytes`
 * and is dropped if it would exceed the cap.
 *
 * @param buffer - Raw source image bytes (already bounded by maxInputBytes).
 * @param originalContentType - MIME type of the source image.
 * @param opts - Requested transform parameters and configured limits.
 * @returns A streaming output stream, plus a `cachePromise` that resolves with
 *          the buffered output when it fits within the cache cap, otherwise null.
 * @throws {ImageTransformError} When requested dimensions exceed configured limits.
 */
export async function transformImageStream(
  buffer: ArrayBuffer,
  originalContentType: string,
  opts: ImageTransformOptions & { readonly maxBufferBytes: number },
): Promise<{
  readonly stream: ReadableStream<Uint8Array>;
  readonly contentType: string;
  readonly warningHeader?: string;
  readonly cachePromise: Promise<ArrayBuffer | null>;
  /** Abort the underlying pipeline (used by request timeout). */
  abort(): void;
}> {
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
    // Sharp unavailable: emit the original bytes as a single-chunk stream.
    const sourceBytes = new Uint8Array(buffer);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sourceBytes);
        controller.close();
      },
    });
    return {
      stream,
      contentType: originalContentType,
      warningHeader: 'sharp unavailable; served original image',
      cachePromise: Promise.resolve(buffer),
      abort() {},
    };
  }

  const input = Buffer.from(buffer);
  const limitInputPixels = opts.maxWidth * opts.maxHeight * 4;
  const pipeline = applySharpPipeline(
    sharpFnResolved(input, { limitInputPixels, failOn: 'truncated' }),
    opts,
  );

  // Build a ReadableStream that pulls Node Buffer chunks out of the Sharp
  // duplex stream. This avoids materializing the full output in memory.
  let aborted = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      pipeline.on('data', (chunk: Buffer) => {
        if (aborted) return;
        // Copy out of the Node Buffer so we don't keep the underlying pool alive.
        controller.enqueue(new Uint8Array(chunk));
      });
      pipeline.on('end', () => {
        if (!aborted) controller.close();
      });
      pipeline.on('error', err => {
        try {
          controller.error(err);
        } catch {
          // controller already errored — ignore
        }
      });
    },
    cancel() {
      aborted = true;
      try {
        pipeline.destroy();
      } catch {
        // already destroyed
      }
    },
  });

  // Tee the stream so we can both pipe to the response and capture into cache.
  const [responseStream, cacheStream] = stream.tee();

  const cachePromise = (async (): Promise<ArrayBuffer | null> => {
    const reader = cacheStream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) continue;
        total += value.byteLength;
        if (total > opts.maxBufferBytes) {
          // Output too large to cache — drop the buffered branch.
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          return null;
        }
        chunks.push(value);
      }
    } catch {
      return null;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  })();

  return {
    stream: responseStream,
    contentType: resolveContentType(opts.format, originalContentType),
    cachePromise,
    abort() {
      aborted = true;
      try {
        pipeline.destroy();
      } catch {
        // ignore
      }
    },
  };
}
