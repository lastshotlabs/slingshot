import { describe, expect, it, mock } from 'bun:test';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import {
  createServeImageResponse,
  fetchSourceImage,
  fetchStoredImage,
  parseImageFormat,
  resolveImageConfig,
  validateSourceUrl,
} from '../../src/image/serve';
import { transformImage, transformImageStream } from '../../src/image/transform';
import { createMemoryImageCache } from '../../src/image/cache';
import { ImageInputTooLargeError } from '../../src/image/types';
import type { Asset } from '../../src/types';

const encoder = new TextEncoder();
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=';

function buffer(text: string): ArrayBuffer {
  return encoder.encode(text).buffer as ArrayBuffer;
}

function tinyPngBuffer(): ArrayBuffer {
  const bytes = Buffer.from(TINY_PNG_BASE64, 'base64');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function imageOptions(overrides: Partial<Parameters<typeof transformImage>[2]> = {}) {
  return {
    width: 100,
    format: 'original' as const,
    quality: 75,
    maxWidth: 500,
    maxHeight: 500,
    timeoutMs: 100,
    ...overrides,
  };
}

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    key: 'uploads/image.png',
    ownerUserId: 'user-1',
    tenantId: null,
    mimeType: 'image/png',
    size: null,
    bucket: null,
    originalName: 'image.png',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('image transform fallback behavior', () => {
  it('validates requested transform dimensions before loading sharp', async () => {
    await expect(transformImage(buffer('x'), 'image/png', imageOptions({ width: 501 }))).rejects.toThrow(
      'exceeds maximum allowed width',
    );
    await expect(
      transformImage(buffer('x'), 'image/png', imageOptions({ height: 501 })),
    ).rejects.toThrow('exceeds maximum allowed height');

    await expect(
      transformImageStream(buffer('x'), 'image/png', {
        ...imageOptions({ width: 501 }),
        maxBufferBytes: 1024,
      }),
    ).rejects.toThrow('exceeds maximum allowed width');
    await expect(
      transformImageStream(buffer('x'), 'image/png', {
        ...imageOptions({ height: 501 }),
        maxBufferBytes: 1024,
      }),
    ).rejects.toThrow('exceeds maximum allowed height');
  });

  it('transforms valid image bytes and exposes stream cache output', async () => {
    const direct = await transformImage(tinyPngBuffer(), 'image/png', imageOptions({ format: 'png' }));
    expect(direct.buffer.byteLength).toBeGreaterThan(0);
    expect(direct.contentType).toBe('image/png');
    expect(direct.warningHeader).toBeUndefined();

    const streamed = await transformImageStream(tinyPngBuffer(), 'image/png', {
      ...imageOptions({ format: 'webp' }),
      maxBufferBytes: 1024,
    });
    expect((await new Response(streamed.stream).arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await streamed.cachePromise)?.byteLength).toBeGreaterThan(0);
    expect(streamed.contentType).toBe('image/webp');
    expect(streamed.warningHeader).toBeUndefined();
    expect(() => streamed.abort()).not.toThrow();
  });

  it('drops transform stream cache output when the transformed bytes exceed the cache cap', async () => {
    const streamed = await transformImageStream(tinyPngBuffer(), 'image/png', {
      ...imageOptions({ format: 'png' }),
      maxBufferBytes: 1,
    });

    expect((await new Response(streamed.stream).arrayBuffer()).byteLength).toBeGreaterThan(0);
    await expect(streamed.cachePromise).resolves.toBeNull();
  });
});

describe('image serve helpers', () => {
  it('parses image formats, source URLs, and image config defaults', () => {
    expect(resolveImageConfig(undefined)).toBeNull();
    expect(resolveImageConfig({})).toMatchObject({
      allowedOrigins: [],
      maxWidth: 4096,
      maxHeight: 4096,
      maxInputBytes: 25 * 1024 * 1024,
      transformTimeoutMs: 10_000,
    });

    expect(parseImageFormat('avif')).toBe('avif');
    expect(parseImageFormat('webp')).toBe('webp');
    expect(parseImageFormat('jpeg')).toBe('jpeg');
    expect(parseImageFormat('png')).toBe('png');
    expect(parseImageFormat('original')).toBe('original');
    expect(parseImageFormat('gif')).toBe('original');

    expect(validateSourceUrl('', ['cdn.example'])).toBeNull();
    expect(validateSourceUrl('/local.png', [])).toBe('/local.png');
    expect(validateSourceUrl('not a url', ['cdn.example'])).toBeNull();
    expect(validateSourceUrl('ftp://cdn.example/a.png', ['cdn.example'])).toBeNull();
    expect(validateSourceUrl('https://evil.example/a.png', ['cdn.example'])).toBeNull();
    expect(validateSourceUrl('https://cdn.example/a.png', ['cdn.example'])).toBe(
      'https://cdn.example/a.png',
    );
  });

  it('maps source fetch failures and oversized responses to typed errors', async () => {
    await expect(
      fetchSourceImage('https://cdn.example/missing.png', undefined, 1024, 100, {
        fetchImpl: (async () => new Response('missing', { status: 404 })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 502 });

    await expect(
      fetchSourceImage('https://cdn.example/huge.png', undefined, 5, 100, {
        fetchImpl: (async () =>
          new Response('too-large', {
            status: 200,
            headers: { 'content-length': '99' },
          })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 413 });

    await expect(
      fetchSourceImage('https://cdn.example/no-body.png', undefined, 1024, 100, {
        fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 502 });

    await expect(
      fetchSourceImage('https://cdn.example/stream.png', undefined, 3, 100, {
        fetchImpl: (async () =>
          new Response(stream(encoder.encode('too-large')), { status: 200 })) as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ImageInputTooLargeError);
  });

  it('maps stored image misses and stream overflows before transform', async () => {
    const missingStorage: StorageAdapter = {
      async put() {
        return {};
      },
      async get() {
        return null;
      },
      async delete() {},
    };

    await expect(fetchStoredImage(missingStorage, asset(), 1024)).rejects.toMatchObject({
      status: 404,
    });

    const oversizedStorage: StorageAdapter = {
      async put() {
        return {};
      },
      async get() {
        return {
          stream: stream(encoder.encode('too-large')),
          mimeType: 'image/png',
        };
      },
      async delete() {},
    };

    await expect(fetchStoredImage(oversizedStorage, asset(), 3)).rejects.toBeInstanceOf(
      ImageInputTooLargeError,
    );
  });

  it('serves URL-backed assets, ignores cache failures, clamps quality, and includes warnings', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => new Response(tinyPngBuffer(), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const cache = {
      async get() {
        throw new Error('cache read failed');
      },
      async set() {
        throw new Error('cache write failed');
      },
    };

    try {
      const imageConfig = resolveImageConfig({
        allowedOrigins: [],
        maxWidth: 500,
        maxHeight: 500,
        maxInputBytes: 1024,
      });
      const response = await createServeImageResponse({
        asset: asset({ key: '/local-image.png' }),
        storage: {
          async put() {
            return {};
          },
          async get() {
            return null;
          },
          async delete() {},
        },
        cache,
        imageConfig: imageConfig!,
        params: { id: 'asset-1', w: '100', h: '', f: 'png', q: 'not-a-number' },
        requestHostHeader: 'localhost:3000',
      });

      expect(response.headers.get('X-Image-Cache')).toBe('MISS');
      expect(response.headers.get('Content-Type')).toBe('image/png');
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects invalid image request dimensions and transform bounds', async () => {
    const imageConfig = resolveImageConfig({ maxWidth: 10, maxHeight: 10 });
    const storage: StorageAdapter = {
      async put() {
        return {};
      },
      async get() {
        return { stream: stream(encoder.encode('x')), mimeType: 'image/png', size: 1 };
      },
      async delete() {},
    };

    await expect(
      createServeImageResponse({
        asset: asset(),
        storage,
        cache: createMemoryImageCache(),
        imageConfig: imageConfig!,
        params: { id: 'asset-1', w: 'bad' },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      createServeImageResponse({
        asset: asset(),
        storage,
        cache: createMemoryImageCache(),
        imageConfig: imageConfig!,
        params: { id: 'asset-1', w: '9', h: '99' },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
