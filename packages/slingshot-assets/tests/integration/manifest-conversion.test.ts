import { describe, expect, test } from 'bun:test';
import { assetManifest } from '../../src';
import { createAssetsTestApp } from '../../src/testing';

describe('assets manifest conversion', () => {
  test('boots from assetManifest with JSON-only config', async () => {
    expect(assetManifest.manifestVersion).toBe(1);

    const { app, state } = await createAssetsTestApp({
      mountPath: '/custom/assets/',
      storage: { adapter: 'memory' },
      presignedUrls: { expirySeconds: 300 },
    });

    const listRes = await app.request('/custom/assets/assets', {
      headers: { 'x-user-id': 'user-1' },
    });
    expect(listRes.status).toBe(200);

    const presignRes = await app.request('/custom/assets/assets/presign-upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({
        key: 'uploads/example.txt',
        mimeType: 'text/plain',
      }),
    });
    expect(presignRes.status).not.toBe(404);
    expect(state.assets).toBeDefined();
  });
});
