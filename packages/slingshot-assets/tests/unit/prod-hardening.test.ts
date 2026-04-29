/**
 * Prod-hardening coverage for slingshot-assets.
 *
 * Each test maps to a finding from
 * `slingshot-specs/specs/audit.prod-path-readiness.2026-04-28.md`:
 *
 *  - P-ASSETS-5: Logger.error + asset:storageDeleteFailed event + onOrphanedKey + listOrphanedKeys
 *  - P-ASSETS-7: presignUpload idempotencyKey path
 *  - P-ASSETS-8: image cache enforces explicit expiresAt on every access
 *  - P-ASSETS-9: presignDownload creator-binding bypass via presignDownloadAuthorize
 *  - P-ASSETS-10: presignDownload refuses blocked MIME + always returns nosniff header advisory
 */
import { describe, expect, mock, test } from 'bun:test';
import {
  InProcessAdapter,
  createEventDefinitionRegistry,
  createEventPublisher,
  defineEvent,
} from '@lastshotlabs/slingshot-core';
import type { Logger, SlingshotEvents, StorageAdapter } from '@lastshotlabs/slingshot-core';
import { createMemoryImageCache } from '../../src/image/cache';
import {
  createDeleteStorageFileMiddleware,
  createOrphanedKeyRegistry,
} from '../../src/middleware/deleteStorageFile';
import { createAssetsTestApp } from '../../src/testing';
import type { Asset, AssetAdapter, OrphanedKeyRecord } from '../../src/types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    key: 'uploads/asset-1.txt',
    ownerUserId: 'user-1',
    tenantId: null,
    mimeType: 'text/plain',
    size: 12,
    bucket: null,
    originalName: 'asset-1.txt',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAssetAdapter(asset: Asset | null): AssetAdapter {
  return {
    create: mock(async input => ({
      ...makeAsset({ id: String(input.id ?? 'asset-new') }),
      ...input,
    })),
    getById: mock(async () => asset),
    list: mock(async () => ({ items: asset ? [asset] : [], hasMore: false })),
    update: mock(async () => asset),
    delete: mock(async () => true),
    clear: mock(async () => {}),
    listByOwner: mock(async () => ({ items: asset ? [asset] : [], hasMore: false })),
    existsByKey: mock(async () => asset !== null),
    findByKey: mock(async () => asset),
  };
}

function makeContext(id: string | undefined, status = 204) {
  return {
    req: {
      param(name: string) {
        return name === 'id' ? id : undefined;
      },
    },
    res: { status },
  };
}

function makeRecordingLogger(): {
  logger: Logger;
  errors: Array<{ msg: string; fields?: Record<string, unknown> }>;
  warns: Array<{ msg: string; fields?: Record<string, unknown> }>;
} {
  const errors: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(msg, fields) {
      warns.push({ msg, fields: fields as Record<string, unknown> | undefined });
    },
    error(msg, fields) {
      errors.push({ msg, fields: fields as Record<string, unknown> | undefined });
    },
    child() {
      return logger;
    },
  };
  return { logger, errors, warns };
}

function makeEventBundle(): {
  bus: InProcessAdapter;
  events: SlingshotEvents;
  collected: Array<{ key: string; payload: unknown }>;
} {
  const bus = new InProcessAdapter();
  const definitions = createEventDefinitionRegistry();
  definitions.register(
    defineEvent('asset:storageDeleteFailed', {
      ownerPlugin: 'slingshot-assets.test',
      exposure: ['internal'],
      resolveScope() {
        return null;
      },
    }),
  );
  const events = createEventPublisher({ definitions, bus });
  const collected: Array<{ key: string; payload: unknown }> = [];
  bus.on('asset:storageDeleteFailed', payload => {
    collected.push({ key: 'asset:storageDeleteFailed', payload });
  });
  return { bus, events, collected };
}

// ---------------------------------------------------------------------------
// P-ASSETS-5: Orphaned-key recovery surface
// ---------------------------------------------------------------------------

describe('P-ASSETS-5: orphaned-key surface', () => {
  test('emits asset:storageDeleteFailed + invokes onOrphanedKey + records to registry on retry exhaustion', async () => {
    const asset = makeAsset();
    const storageDelete = mock(async () => {
      throw new Error('persistent outage');
    });
    const storage: StorageAdapter = {
      async put() {
        return {};
      },
      async get() {
        return null;
      },
      delete: storageDelete,
    };

    const { logger, errors } = makeRecordingLogger();
    const { events, collected } = makeEventBundle();
    const orphanRegistry = createOrphanedKeyRegistry();
    const callbackRecords: OrphanedKeyRecord[] = [];

    const middleware = createDeleteStorageFileMiddleware({
      storage,
      assetAdapter: makeAssetAdapter(asset),
      retryAttempts: 1,
      logger,
      events,
      orphanRegistry,
      onOrphanedKey: rec => callbackRecords.push(rec),
    });

    await middleware(
      makeContext(asset.id) as never,
      mock(async () => {}),
    );

    // Logger error
    const exhausted = errors.find(e => e.msg.includes('asset storage delete exhausted retries'));
    expect(exhausted).toBeTruthy();
    expect(exhausted?.fields?.key).toBe(asset.key);

    // Event emitted
    expect(collected).toHaveLength(1);
    const payload = collected[0]?.payload as Record<string, unknown>;
    expect(payload?.key).toBe(asset.key);
    expect(payload?.assetId).toBe(asset.id);
    expect(payload?.retries).toBe(1);
    expect(payload?.lastError).toBe('persistent outage');

    // onOrphanedKey callback invoked
    expect(callbackRecords).toHaveLength(1);
    expect(callbackRecords[0]?.key).toBe(asset.key);

    // Recovery API surfaces the record
    const orphans = orphanRegistry.listOrphanedKeys();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.key).toBe(asset.key);
  });

  test('listOrphanedKeys() filters by since', () => {
    const registry = createOrphanedKeyRegistry();
    const old: OrphanedKeyRecord = {
      key: 'old',
      assetId: 'a',
      tenantId: null,
      retries: 1,
      lastError: 'x',
      recordedAt: 100,
    };
    const recent: OrphanedKeyRecord = {
      key: 'recent',
      assetId: 'b',
      tenantId: null,
      retries: 1,
      lastError: 'x',
      recordedAt: 1000,
    };
    registry.record(old);
    registry.record(recent);

    expect(registry.listOrphanedKeys(new Date(500))).toHaveLength(1);
    expect(registry.listOrphanedKeys(new Date(500))[0]?.key).toBe('recent');
    expect(registry.listOrphanedKeys()).toHaveLength(2);
  });

  test('callback errors do not abort the orphan recording path', async () => {
    const asset = makeAsset();
    const storage: StorageAdapter = {
      async put() {
        return {};
      },
      async get() {
        return null;
      },
      async delete() {
        throw new Error('outage');
      },
    };
    const { logger, errors } = makeRecordingLogger();
    const { events } = makeEventBundle();
    const orphanRegistry = createOrphanedKeyRegistry();

    const middleware = createDeleteStorageFileMiddleware({
      storage,
      assetAdapter: makeAssetAdapter(asset),
      retryAttempts: 1,
      logger,
      events,
      orphanRegistry,
      onOrphanedKey: () => {
        throw new Error('callback boom');
      },
    });

    await middleware(
      makeContext(asset.id) as never,
      mock(async () => {}),
    );

    // Registry still recorded
    expect(orphanRegistry.size()).toBe(1);
    // Logger captured the callback failure
    expect(errors.some(e => e.msg.includes('onOrphanedKey callback failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P-ASSETS-6: presigned PUT URL TTL validation
// ---------------------------------------------------------------------------

describe('P-ASSETS-6: presigned PUT URL TTL validation', () => {
  function presignStorage() {
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
        return `https://upload.example/${encodeURIComponent(key)}`;
      },
      async presignGet(key) {
        return `https://download.example/${encodeURIComponent(key)}`;
      },
    };
    return storage;
  }

  test('rejects expirySeconds beyond presignedUploadMaxTtlSeconds', async () => {
    const { app } = await createAssetsTestApp({
      storage: presignStorage(),
      presignedUrls: true,
      presignedUploadMaxTtlSeconds: 60,
    });
    const res = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'user-1',
      },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png', expirySeconds: 600 }),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('presignedUploadMaxTtlSeconds');
  });

  test('rejects expirySeconds beyond asset retention window', async () => {
    const { app } = await createAssetsTestApp({
      storage: presignStorage(),
      presignedUrls: true,
      registryTtlSeconds: 30,
      presignedUploadAssetRetentionSeconds: 30,
    });
    const res = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'user-1',
      },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png', expirySeconds: 120 }),
    });
    expect(res.status).toBe(400);
  });

  test('accepts expirySeconds within both bounds', async () => {
    const { app } = await createAssetsTestApp({
      storage: presignStorage(),
      presignedUrls: true,
      presignedUploadMaxTtlSeconds: 600,
    });
    const res = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'user-1',
      },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png', expirySeconds: 120 }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// P-ASSETS-7: idempotent presignUpload
// ---------------------------------------------------------------------------

describe('P-ASSETS-7: idempotent presignUpload', () => {
  test('concurrent calls with same idempotencyKey return identical record', async () => {
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
        putCallCount += 1;
        await new Promise(r => setTimeout(r, 10));
        return `https://upload.example/${encodeURIComponent(key)}`;
      },
      async presignGet(key) {
        return `https://download.example/${encodeURIComponent(key)}`;
      },
    };

    const { app, state } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    const make = () =>
      app.request('/assets/assets/presign-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
        body: JSON.stringify({
          filename: 'a.png',
          mimeType: 'image/png',
          idempotencyKey: 'key-a',
        }),
      });

    const [r1, r2, r3] = await Promise.all([make(), make(), make()]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);

    const b1 = (await r1.json()) as { url: string; key: string; assetId: string };
    const b2 = (await r2.json()) as { url: string; key: string; assetId: string };
    const b3 = (await r3.json()) as { url: string; key: string; assetId: string };

    // All three responses must reference the SAME asset/key/url.
    expect(b1.assetId).toBe(b2.assetId);
    expect(b2.assetId).toBe(b3.assetId);
    expect(b1.key).toBe(b2.key);
    expect(b1.url).toBe(b2.url);

    // Only one storage put / asset record was actually created.
    expect(putCallCount).toBe(1);

    // listByOwner returns only ONE asset for user-1.
    const result = await state.assets.listByOwner({ ownerUserId: 'user-1' });
    expect(result.items).toHaveLength(1);
  });

  test('different users with the same idempotencyKey do NOT collide', async () => {
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
        putCallCount += 1;
        return `https://upload.example/${encodeURIComponent(key)}`;
      },
      async presignGet(key) {
        return `https://download.example/${encodeURIComponent(key)}`;
      },
    };

    const { app } = await createAssetsTestApp({
      storage,
      presignedUrls: true,
    });

    const r1 = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png', idempotencyKey: 'k' }),
    });
    const r2 = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-2' },
      body: JSON.stringify({ filename: 'a.png', mimeType: 'image/png', idempotencyKey: 'k' }),
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { assetId: string; key: string };
    const b2 = (await r2.json()) as { assetId: string; key: string };
    expect(b1.assetId).not.toBe(b2.assetId);
    expect(b1.key).not.toBe(b2.key);
    expect(putCallCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P-ASSETS-8: image cache TTL on every access (explicit expiresAt)
// ---------------------------------------------------------------------------

describe('P-ASSETS-8: image cache TTL on every access', () => {
  test('cache.set pins explicit expiresAt; cache.get evicts on access when now >= expiresAt', async () => {
    let nowMs = 1000;
    const cache = createMemoryImageCache({
      maxEntries: 10,
      ttlMs: 5_000,
      now: () => nowMs,
    });

    await cache.set('k', {
      buffer: new ArrayBuffer(1),
      contentType: 'image/webp',
      generatedAt: nowMs,
    });

    nowMs += 1_000;
    expect(await cache.get('k')).not.toBeNull();

    // Past TTL — must evict on access regardless of caller-side expiry math.
    nowMs += 5_000;
    expect(await cache.get('k')).toBeNull();
    expect(cache.getHealth?.().ttlEvictionCount).toBe(1);
  });

  test('caller-supplied expiresAt overrides adapter ttlMs', async () => {
    let nowMs = 1000;
    const cache = createMemoryImageCache({
      maxEntries: 10,
      // Adapter TTL is large but the entry pins a much shorter expiresAt.
      ttlMs: 60 * 60_000,
      now: () => nowMs,
    });

    await cache.set('k', {
      buffer: new ArrayBuffer(1),
      contentType: 'image/webp',
      generatedAt: nowMs,
      expiresAt: nowMs + 100,
    });

    nowMs += 50;
    expect(await cache.get('k')).not.toBeNull();

    nowMs += 100;
    expect(await cache.get('k')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P-ASSETS-9: presignDownload creator-binding bypass
// ---------------------------------------------------------------------------

describe('P-ASSETS-9: presignDownload creator binding', () => {
  function presignStorage() {
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
        return `https://upload.example/${encodeURIComponent(key)}`;
      },
      async presignGet(key) {
        return `https://download.example/${encodeURIComponent(key)}`;
      },
    };
    return storage;
  }

  async function uploadAsOwner(app: Awaited<ReturnType<typeof createAssetsTestApp>>['app']) {
    const r = await app.request('/assets/assets/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'owner' },
      body: JSON.stringify({ filename: 'doc.pdf', mimeType: 'application/pdf' }),
    });
    expect(r.status).toBe(200);
    return (await r.json()) as { key: string };
  }

  test('non-owner is rejected when no presignDownloadAuthorize is configured', async () => {
    const { app } = await createAssetsTestApp({
      storage: presignStorage(),
      presignedUrls: true,
    });
    const { key } = await uploadAsOwner(app);
    const res = await app.request('/assets/assets/presign-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'other' },
      body: JSON.stringify({ key }),
    });
    expect(res.status).toBe(403);
  });

  test('non-owner is permitted when presignDownloadAuthorize returns true', async () => {
    const { app } = await createAssetsTestApp({
      storage: presignStorage(),
      presignedUrls: true,
      presignDownloadAuthorize: input => input.actor.id === 'admin',
    });
    const { key } = await uploadAsOwner(app);
    const res = await app.request('/assets/assets/presign-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'admin' },
      body: JSON.stringify({ key }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain('download.example');
  });

  test('owner is always permitted regardless of authorize callback', async () => {
    const callback = mock(() => false);
    const { app } = await createAssetsTestApp({
      storage: presignStorage(),
      presignedUrls: true,
      presignDownloadAuthorize: callback,
    });
    const { key } = await uploadAsOwner(app);
    const res = await app.request('/assets/assets/presign-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'owner' },
      body: JSON.stringify({ key }),
    });
    expect(res.status).toBe(200);
    expect(callback).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P-ASSETS-10: blocked MIME enforcement on download
// ---------------------------------------------------------------------------

describe('P-ASSETS-10: blocked MIME enforcement on download', () => {
  function presignStorage() {
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
        return `https://upload.example/${encodeURIComponent(key)}`;
      },
      async presignGet(key) {
        return `https://download.example/${encodeURIComponent(key)}`;
      },
    };
    return storage;
  }

  test('refuses to presign download for an asset whose mimeType is blocked', async () => {
    const { app, state } = await createAssetsTestApp({
      storage: presignStorage(),
      presignedUrls: true,
    });

    // Manually create a blocked-MIME asset (presignUpload would have refused
    // up-front, but we want to assert the download-side defense).
    const created = await state.assets.create({
      key: 'uploads/script.html',
      ownerUserId: 'user-1',
      mimeType: 'text/html',
    });

    const res = await app.request('/assets/assets/presign-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ key: created.key }),
    });
    expect(res.status).toBe(415);
  });

  test('safe MIME presign-download response always includes nosniff header advisory', async () => {
    const { app, state } = await createAssetsTestApp({
      storage: presignStorage(),
      presignedUrls: true,
    });

    const created = await state.assets.create({
      key: 'uploads/safe.png',
      ownerUserId: 'user-1',
      mimeType: 'image/png',
    });

    const res = await app.request('/assets/assets/presign-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-1' },
      body: JSON.stringify({ key: created.key }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      responseHeaders: Record<string, string>;
    };
    expect(body.responseHeaders['X-Content-Type-Options']).toBe('nosniff');
    expect(body.responseHeaders['Content-Type']).toBeUndefined();
  });
});
