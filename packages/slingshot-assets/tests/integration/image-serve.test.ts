import { describe, expect, it } from 'bun:test';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import { createMemoryImageCache } from '../../src/image/cache';
import { createServeImageResponse, resolveImageConfig } from '../../src/image/serve';
import { createAssetsTestApp, getAssetsRuntimeAdapter, seedAsset } from '../../src/testing';

function createImageStorage(imageBody = 'fake-image-data') {
  const bytes =
    imageBody === 'fake-image-data'
      ? Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=',
          'base64',
        )
      : new TextEncoder().encode(imageBody);
  const storage: StorageAdapter = {
    async put() {
      return {};
    },
    async get() {
      return {
        stream:
          new Response(bytes).body ??
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        mimeType: 'image/png',
        size: bytes.byteLength,
      };
    },
    async delete() {},
  };
  return { storage, bytes };
}

describe('serveImage runtime operation', () => {
  it('returns 501 when image config is omitted', async () => {
    const { storage } = createImageStorage();
    const { state } = await createAssetsTestApp({ storage, image: undefined });
    const asset = await seedAsset(state, {
      key: 'uploads/no-image-config.png',
      ownerUserId: 'user-1',
      mimeType: 'image/png',
    });

    await expect(
      getAssetsRuntimeAdapter(state).serveImage({
        id: asset.id,
        w: 100,
        'actor.id': 'user-1',
      }),
    ).rejects.toMatchObject({ status: 501 });
  });

  it('returns MISS then HIT for repeated storage-backed requests', async () => {
    const { storage } = createImageStorage();
    const { state } = await createAssetsTestApp({
      storage,
      image: { maxWidth: 1024, maxHeight: 1024 },
    });
    const asset = await seedAsset(state, {
      key: 'uploads/cache-me.png',
      ownerUserId: 'user-1',
      mimeType: 'image/png',
    });

    const adapter = getAssetsRuntimeAdapter(state);
    const first = await adapter.serveImage({
      id: asset.id,
      w: 100,
      f: 'original',
      'actor.id': 'user-1',
    });
    const second = await adapter.serveImage({
      id: asset.id,
      w: 100,
      f: 'original',
      'actor.id': 'user-1',
    });

    expect(first.headers.get('X-Image-Cache')).toBe('MISS');
    expect(second.headers.get('X-Image-Cache')).toBe('HIT');
    expect(first.headers.get('Content-Type')).toBe('image/png');
  });

  it('blocks disallowed remote origins', async () => {
    const { storage } = createImageStorage();
    const { state } = await createAssetsTestApp({
      storage,
      image: { allowedOrigins: [], maxWidth: 1024, maxHeight: 1024 },
    });
    const asset = await seedAsset(state, {
      key: 'https://evil.example/image.png',
      ownerUserId: 'user-1',
      mimeType: 'image/png',
    });

    await expect(
      getAssetsRuntimeAdapter(state).serveImage({
        id: asset.id,
        w: 100,
        'actor.id': 'user-1',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('forbids non-owners from serving images', async () => {
    const { storage } = createImageStorage();
    const { state } = await createAssetsTestApp({
      storage,
      image: { maxWidth: 1024, maxHeight: 1024 },
    });
    const asset = await seedAsset(state, {
      key: 'uploads/private.png',
      ownerUserId: 'user-1',
      mimeType: 'image/png',
    });

    await expect(
      getAssetsRuntimeAdapter(state).serveImage({
        id: asset.id,
        w: 100,
        'actor.id': 'user-2',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects oversized stored asset with 413 BEFORE buffering bytes', async () => {
    let getCalled = 0;
    let bytesEnqueued = 0;
    const oversize = 64 * 1024 * 1024; // 64 MiB > default 25 MiB cap
    const chunk = new Uint8Array(1024).fill(0xab);
    const storage: StorageAdapter = {
      async put() {
        return {};
      },
      async get() {
        getCalled++;
        return {
          stream: new ReadableStream<Uint8Array>({
            pull(controller) {
              // If we ever get here we should NOT enqueue any payload bytes —
              // the 413 must fire before any bytes are buffered into memory.
              bytesEnqueued += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
          mimeType: 'image/png',
          size: oversize,
        };
      },
      async delete() {},
    };

    const imageConfig = resolveImageConfig({ maxWidth: 1024, maxHeight: 1024 });
    expect(imageConfig).not.toBeNull();
    const cache = createMemoryImageCache();

    await expect(
      createServeImageResponse({
        asset: {
          id: 'a1',
          key: 'uploads/huge.png',
          ownerUserId: 'user-1',
          mimeType: 'image/png',
          // omit asset.size so the storage-reported size is what triggers the cap
          size: null,
          createdAt: new Date().toISOString(),
        },
        storage,
        cache,
        // biome-ignore lint/style/noNonNullAssertion: tested above
        imageConfig: imageConfig!,
        params: { id: 'a1', w: 100, f: 'original' },
      }),
    ).rejects.toMatchObject({ status: 413 });

    expect(getCalled).toBe(1);
    // Anything > 1 MiB indicates the cap-check happened after buffering.
    expect(bytesEnqueued).toBeLessThan(2 * 1024 * 1024);
  });

  it('rejects asset with declared oversized size with 413 without storage.get()', async () => {
    let getCalled = 0;
    const storage: StorageAdapter = {
      async put() {
        return {};
      },
      async get() {
        getCalled++;
        return null;
      },
      async delete() {},
    };

    const imageConfig = resolveImageConfig({
      maxWidth: 1024,
      maxHeight: 1024,
      maxInputBytes: 1024,
    });
    const cache = createMemoryImageCache();

    await expect(
      createServeImageResponse({
        asset: {
          id: 'a1',
          key: 'uploads/big.png',
          ownerUserId: 'user-1',
          mimeType: 'image/png',
          size: 5_000_000,
          createdAt: new Date().toISOString(),
        },
        storage,
        cache,
        // biome-ignore lint/style/noNonNullAssertion: tested above
        imageConfig: imageConfig!,
        params: { id: 'a1', w: 100, f: 'original' },
      }),
    ).rejects.toMatchObject({ status: 413 });

    // get() should never be called — declared size already exceeded the cap.
    expect(getCalled).toBe(0);
  });

  it('returns 504 when transform pipeline exceeds the configured timeout', async () => {
    // Stream that never produces bytes — forces the transform timeout to fire.
    const storage: StorageAdapter = {
      async put() {
        return {};
      },
      async get() {
        return {
          stream: new ReadableStream<Uint8Array>({
            pull() {
              // intentionally idle; reads will hang until canceled
              return new Promise(() => {});
            },
          }),
          mimeType: 'image/png',
          size: 100,
        };
      },
      async delete() {},
    };

    const { state } = await createAssetsTestApp({
      storage,
      image: { maxWidth: 1024, maxHeight: 1024, transformTimeoutMs: 50 },
    });
    const asset = await seedAsset(state, {
      key: 'uploads/slow.png',
      ownerUserId: 'user-1',
      mimeType: 'image/png',
    });

    const guarded = Promise.race([
      getAssetsRuntimeAdapter(state).serveImage({
        id: asset.id,
        w: 100,
        f: 'original',
        'actor.id': 'user-1',
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('test timeout')), 2000)),
    ]);

    await expect(guarded).rejects.toMatchObject({ status: 504 });
  });
});
