import { describe, expect, it } from 'bun:test';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import { createAssetsTestApp } from '../../src/testing';

function createPresignStorage() {
  const putCalls: Array<{
    key: string;
    opts: { expirySeconds: number; mimeType?: string; maxSize?: number };
  }> = [];
  const getCalls: Array<{ key: string; opts: { expirySeconds: number } }> = [];

  const storage: StorageAdapter & {
    presignPut(
      key: string,
      opts: { expirySeconds: number; mimeType?: string; maxSize?: number },
    ): Promise<string>;
    presignGet(key: string, opts: { expirySeconds: number }): Promise<string>;
  } = {
    async put() {
      return {};
    },
    async get() {
      return null;
    },
    async delete() {},
    async presignPut(key, opts) {
      putCalls.push({ key, opts });
      return `https://upload.example/${encodeURIComponent(key)}`;
    },
    async presignGet(key, opts) {
      getCalls.push({ key, opts });
      return `https://download.example/${encodeURIComponent(key)}`;
    },
  };

  return { storage, putCalls, getCalls };
}

describe('presign upload and download routes', () => {
  it('creates an asset record and returns a presigned upload URL', async () => {
    const { storage, putCalls } = createPresignStorage();
    const { app, state } = await createAssetsTestApp({
      storage,
      allowedMimeTypes: ['image/*'],
      maxFileSize: 1024,
      presignedUrls: true,
    });

    const response = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'user-1',
      },
      body: JSON.stringify({
        filename: 'avatar.png',
        mimeType: 'image/png',
        expirySeconds: 120,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string; key: string; assetId: string };
    expect(body.url).toContain('https://upload.example/');
    expect(body.key).toMatch(/^uploads\//);
    expect(body.assetId).toBeTruthy();
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.opts.maxSize).toBe(1024);

    const stored = await state.assets.findByKey({ key: body.key });
    expect(stored?.id).toBe(body.assetId);
    expect(stored?.ownerUserId).toBe('user-1');
  });

  it('enforces allowedMimeTypes on presign-upload', async () => {
    const { storage } = createPresignStorage();
    const { app } = await createAssetsTestApp({
      storage,
      allowedMimeTypes: ['image/*'],
      presignedUrls: true,
    });

    const missingMime = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'user-1',
      },
      body: JSON.stringify({ filename: 'avatar.png' }),
    });
    expect(missingMime.status).toBe(400);

    const badMime = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'user-1',
      },
      body: JSON.stringify({ filename: 'notes.txt', mimeType: 'text/plain' }),
    });
    expect(badMime.status).toBe(400);
  });

  it('returns a presigned download URL only for the owner', async () => {
    const { storage, getCalls } = createPresignStorage();
    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    const uploadRes = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'user-1',
      },
      body: JSON.stringify({ filename: 'avatar.png', mimeType: 'image/png' }),
    });
    const uploaded = (await uploadRes.json()) as { key: string };

    const ownerRes = await app.request('/assets/assets/presign-download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'user-1',
      },
      body: JSON.stringify({ key: uploaded.key, expirySeconds: 90 }),
    });
    expect(ownerRes.status).toBe(200);
    expect(((await ownerRes.json()) as { url: string }).url).toContain('download.example');
    expect(getCalls).toHaveLength(1);

    const otherUserRes = await app.request('/assets/assets/presign-download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'user-2',
      },
      body: JSON.stringify({ key: uploaded.key }),
    });
    expect(otherUserRes.status).toBe(403);
  });
});
