import { describe, expect, it } from 'bun:test';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
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
        authUserId: 'user-1',
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
      authUserId: 'user-1',
    });
    const second = await adapter.serveImage({
      id: asset.id,
      w: 100,
      f: 'original',
      authUserId: 'user-1',
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
        authUserId: 'user-1',
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
        authUserId: 'user-2',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
