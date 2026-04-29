/**
 * Edge-case coverage for presigned URL generation and download.
 *
 * Builds on the integration-level presign tests in presign.test.ts and
 * prod-hardening.test.ts. Covers expiration validation at boundaries,
 * malformed keys, non-existent keys, missing storage adapter capabilities,
 * and error propagation from presignPut/presignGet rejections.
 */
import { describe, expect, test } from 'bun:test';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import { createAssetsTestApp } from '../../src/testing';

// ---------------------------------------------------------------------------
// Shared helper: storage adapter that tracks calls
// ---------------------------------------------------------------------------

function createTrackingStorage() {
  const putCalls: Array<{ key: string; opts: Record<string, unknown> }> = [];
  const getCalls: Array<{ key: string; opts: Record<string, unknown> }> = [];

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
      putCalls.push({ key, opts: opts as Record<string, unknown> });
      return `https://upload.example/${encodeURIComponent(key)}`;
    },
    async presignGet(key, opts) {
      getCalls.push({ key, opts: opts as Record<string, unknown> });
      return `https://download.example/${encodeURIComponent(key)}`;
    },
  };

  return { storage, putCalls, getCalls };
}

// ---------------------------------------------------------------------------
// Expiration validation boundaries
// ---------------------------------------------------------------------------

describe('presignUpload expiration validation', () => {
  test('expirySeconds=1 is accepted', async () => {
    const { storage } = createTrackingStorage();
    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    const res = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png', expirySeconds: 1 }),
    });
    expect(res.status).toBe(200);
  });

  test('expirySeconds=0 is rejected (zero-second URL is useless)', async () => {
    const { storage } = createTrackingStorage();
    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    const res = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png', expirySeconds: 0 }),
    });
    expect(res.status).toBe(400);
  });

  test('negative expirySeconds is rejected', async () => {
    const { storage } = createTrackingStorage();
    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    const res = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png', expirySeconds: -30 }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Malformed keys and missing assets
// ---------------------------------------------------------------------------

describe('presignDownload with malformed or missing keys', () => {
  test('returns 404 for a key that does not exist', async () => {
    const { storage } = createTrackingStorage();
    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    const res = await app.request('/assets/assets/presign-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ key: 'uploads/nonexistent.png' }),
    });
    expect(res.status).toBe(404);
  });

  test('returns 400 for an empty key', async () => {
    const { storage } = createTrackingStorage();
    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    const res = await app.request('/assets/assets/presign-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ key: '' }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 when key is missing from request body', async () => {
    const { storage } = createTrackingStorage();
    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    const res = await app.request('/assets/assets/presign-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Missing request fields for presign-upload
// ---------------------------------------------------------------------------

describe('presignUpload missing fields', () => {
  test('returns 401 when x-user-id header is missing', async () => {
    const { storage } = createTrackingStorage();
    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    const res = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png' }),
    });
    expect(res.status).toBe(401);
  });

  test('missing filename generates a key from fallback logic (200)', async () => {
    const { storage } = createTrackingStorage();
    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    const res = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ mimeType: 'image/png' }),
    });
    // Route generates a deterministic key from the request body fields
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string };
    expect(body.key).toBeTruthy();
  });

  test('empty filename string generates a key from fallback logic (200)', async () => {
    const { storage } = createTrackingStorage();
    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    const res = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ filename: '', mimeType: 'image/png' }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// presignPut error propagation
// ---------------------------------------------------------------------------

describe('presignPut error propagation', () => {
  test('error from storage presignPut is caught by Hono and returned as 500', async () => {
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
      async presignPut() {
        throw new Error('S3 presign service unavailable');
      },
      async presignGet(key) {
        return `https://download.example/${encodeURIComponent(key)}`;
      },
    };

    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    // Hono's default onError handler catches route handler errors and returns 500
    const res = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png' }),
    });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// presignGet error propagation
// ---------------------------------------------------------------------------

describe('presignGet error propagation', () => {
  test('error from storage presignGet is caught by Hono and returned as 500', async () => {
    let putCallCount = 0;
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
      async presignPut(key) {
        putCallCount++;
        return `https://upload.example/${encodeURIComponent(key)}`;
      },
      async presignGet() {
        throw new Error('S3 presign get unavailable');
      },
    };

    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    // Create asset first
    const uploadRes = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png' }),
    });
    expect(uploadRes.status).toBe(200);
    const { key } = (await uploadRes.json()) as { key: string };

    // Download should fail with Hono catching the error as 500
    const downRes = await app.request('/assets/assets/presign-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ key }),
    });
    expect(downRes.status).toBe(500);
  });
});
