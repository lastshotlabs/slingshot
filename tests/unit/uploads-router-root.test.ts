import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import { describe, expect, mock, test } from 'bun:test';
import { attachContext, createRouter } from '@lastshotlabs/slingshot-core';
import { createUploadsRouter } from '../../src/framework/routes/uploads';

interface UploadRecord {
  key: string;
  ownerUserId?: string;
  tenantId?: string;
  mimeType?: string;
  bucket?: string;
  createdAt: number;
}

function makeAuthRuntime(): AuthRuntimeContext {
  return {
    adapter: {
      getSuspended: async () => ({ suspended: false }),
      getEmailVerified: async () => true,
    },
    config: {
      emailVerification: undefined,
      primaryField: 'email',
    },
  } as unknown as AuthRuntimeContext;
}

function json(body: Record<string, unknown>) {
  return {
    method: 'POST' as const,
    headers: {
      authorization: 'Bearer test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function makeUploadApp(options?: {
  adapter?: Record<string, unknown> | null;
  signing?: Record<string, unknown> | null;
  routerConfig?: Record<string, unknown>;
  uploadConfig?: Record<string, unknown>;
  records?: UploadRecord[];
}) {
  const app = createRouter();
  const records = new Map((options?.records ?? []).map(record => [record.key, record]));
  const routeAuth = {
    userAuth: async (c: any, next: () => Promise<void>) => {
      const token = c.req.header('authorization');
      if (!token) return c.json({ error: 'Unauthorized' }, 401);
      c.set('authUserId', c.req.header('x-user-id') ?? 'user-1');
      c.set('tenantId', c.req.header('x-tenant-id') ?? 'tenant-1');
      await next();
    },
    requireRole:
      () =>
      async (_c: any, next: () => Promise<void>) => {
        await next();
      },
  };

  const slingshotCtx = {
    app,
    config: {},
    signing: options?.signing ?? null,
    upload: { adapter: options?.adapter ?? null, config: options?.uploadConfig ?? {} },
    routeAuth,
    userResolver: null,
    rateLimitAdapter: null,
    fingerprintBuilder: null,
    cacheAdapters: new Map(),
    emailTemplates: new Map(),
    pluginState: new Map([[AUTH_RUNTIME_KEY, makeAuthRuntime()]]),
    trustProxy: false,
    persistence: {
      uploadRegistry: {
        register: async (record: UploadRecord) => {
          records.set(record.key, record);
        },
        get: async (key: string) => {
          return records.get(key) ?? null;
        },
        delete: async (key: string) => {
          return records.delete(key);
        },
      },
    },
  } as any;

  attachContext(app, slingshotCtx);
  app.route('/', createUploadsRouter((options?.routerConfig ?? {}) as any));

  return { app, records };
}

describe('createUploadsRouter (root coverage)', () => {
  test('presigns uploads for exact-match MIME types and registers ownership metadata', async () => {
    const presignPut = mock(async (key: string, opts: Record<string, unknown>) => {
      return `https://uploads.example/${encodeURIComponent(key)}?expiry=${String(opts.expirySeconds)}`;
    });
    const { app, records } = makeUploadApp({
      adapter: {
        presignPut,
        delete: async () => {},
      },
      uploadConfig: {
        allowedMimeTypes: ['application/pdf'],
        maxFileSize: 2048,
      },
    });

    const response = await app.request(
      '/uploads/presign',
      json({
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        expirySeconds: 45,
        maxBytes: 512,
      }),
    );
    const body = await response.json();
    const storedKey = body.key as string;

    expect(response.status).toBe(200);
    expect(body.maxBytes).toBe(512);
    expect(presignPut).toHaveBeenCalledWith(
      storedKey,
      expect.objectContaining({
        expirySeconds: 45,
        mimeType: 'application/pdf',
        maxSize: 512,
      }),
    );
    expect(records.get(storedKey)).toMatchObject({
      key: storedKey,
      ownerUserId: 'user-1',
      tenantId: 'tenant-1',
      mimeType: 'application/pdf',
    });
  });

  test('rejects blocked executable MIME types before presigning uploads', async () => {
    const presignPut = mock(async () => 'https://uploads.example/blocked');
    const { app } = makeUploadApp({
      adapter: {
        presignPut,
      },
    });

    const response = await app.request(
      '/uploads/presign',
      json({
        filename: 'shell.sh',
        mimeType: 'application/x-sh',
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'File type not allowed.' });
    expect(presignPut).not.toHaveBeenCalled();
  });

  test('uses the authorization callback for non-owner downloads before enforcing signing secrets', async () => {
    const authorize = mock(async () => true);
    const { app } = makeUploadApp({
      signing: {
        presignedUrls: true,
      },
      routerConfig: {
        authorization: { authorize },
      },
      records: [
        {
          key: 'reports/shared.pdf',
          ownerUserId: 'another-user',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/reports/shared.pdf', {
      headers: {
        authorization: 'Bearer test',
      },
    });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Signing secret not configured',
    });
    expect(authorize).toHaveBeenCalledWith({
      action: 'read',
      key: 'reports/shared.pdf',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
  });

  test('rejects cross-tenant download access for registered uploads', async () => {
    const presignGet = mock(async () => 'https://downloads.example/cross-tenant');
    const { app } = makeUploadApp({
      adapter: {
        presignGet,
      },
      records: [
        {
          key: 'tenant-a/private.pdf',
          ownerUserId: 'user-1',
          tenantId: 'tenant-a',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/tenant-a/private.pdf', {
      headers: {
        authorization: 'Bearer test',
        'x-tenant-id': 'tenant-b',
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'Forbidden' });
    expect(presignGet).not.toHaveBeenCalled();
  });

  test('forbids non-owner access to registered uploads when no authorize callback exists', async () => {
    const presignGet = mock(async () => 'https://downloads.example/nope');
    const { app } = makeUploadApp({
      adapter: {
        presignGet,
      },
      records: [
        {
          key: 'reports/private.pdf',
          ownerUserId: 'other-user',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/reports/private.pdf', {
      headers: {
        authorization: 'Bearer test',
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'Forbidden' });
    expect(presignGet).not.toHaveBeenCalled();
  });

  test('presigns downloads with the configured signing secret and default expiry', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { app } = makeUploadApp({
      signing: {
        secret: 'super-secret',
        presignedUrls: { defaultExpiry: 90 },
      },
      records: [
        {
          key: 'reports/owned.pdf',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/reports/owned.pdf?expiry=10', {
      headers: {
        authorization: 'Bearer test',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toContain('/uploads/download/reports/owned.pdf');
    expect(body.expiresAt).toBeGreaterThanOrEqual(now + 85);
    expect(body.expiresAt).toBeLessThanOrEqual(now + 95);
  });

  test('falls back to adapter presignGet for authorized external-key downloads', async () => {
    const authorize = mock(async () => true);
    const presignGet = mock(async (key: string, opts: Record<string, unknown>) => {
      return `https://downloads.example/${encodeURIComponent(key)}?expiry=${String(opts.expirySeconds)}`;
    });
    const { app } = makeUploadApp({
      adapter: {
        presignGet,
      },
      routerConfig: {
        allowExternalKeys: true,
        authorization: { authorize },
      },
    });

    const response = await app.request('/uploads/presign/external/report.csv?expiry=12', {
      headers: {
        authorization: 'Bearer test',
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toContain('external%2Freport.csv');
    expect(presignGet).toHaveBeenCalledWith('external/report.csv', { expirySeconds: 12 });
    expect(authorize).toHaveBeenCalledWith({
      action: 'read',
      key: 'external/report.csv',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
  });

  test('forbids external-key downloads when no authorize callback is configured', async () => {
    const presignGet = mock(async () => 'https://downloads.example/forbidden');
    const { app } = makeUploadApp({
      adapter: {
        presignGet,
      },
      routerConfig: {
        allowExternalKeys: true,
      },
    });

    const response = await app.request('/uploads/presign/external/blocked.bin', {
      headers: {
        authorization: 'Bearer test',
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'Forbidden' });
    expect(presignGet).not.toHaveBeenCalled();
  });

  test('returns 501 when neither signing nor adapter download presigning is available', async () => {
    const { app } = makeUploadApp({
      adapter: {},
      records: [
        {
          key: 'reports/adapterless.pdf',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/reports/adapterless.pdf', {
      headers: {
        authorization: 'Bearer test',
      },
    });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      error:
        'Presigned download URLs not supported. Enable signing.presignedUrls or use an S3 adapter.',
    });
  });

  test('returns 500 for deletes when no storage adapter is configured', async () => {
    const { app } = makeUploadApp({
      adapter: null,
    });

    const response = await app.request('/uploads/orphaned/file.txt', {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test',
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'No storage adapter configured',
    });
  });

  test('returns 404 for deletes when the upload record is missing and external keys are disabled', async () => {
    const deleteSpy = mock(async () => {});
    const { app } = makeUploadApp({
      adapter: {
        delete: deleteSpy,
      },
    });

    const response = await app.request('/uploads/missing/file.txt', {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test',
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'Not found' });
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test('returns 501 when adapter has no presignPut method (lines 254-257)', async () => {
    const { app } = makeUploadApp({
      adapter: {
        // no presignPut
        delete: async () => {},
      },
    });

    const response = await app.request(
      '/uploads/presign',
      json({ filename: 'doc.pdf', mimeType: 'application/pdf' }),
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Presigned URLs not supported by the configured storage adapter',
    });
  });

  test('returns 400 when mimeType is missing but allowedMimeTypes is configured (lines 268-271)', async () => {
    const presignPut = mock(async () => 'https://uploads.example/test');
    const { app } = makeUploadApp({
      adapter: { presignPut, delete: async () => {} },
      uploadConfig: { allowedMimeTypes: ['image/png', 'application/pdf'] },
    });

    const response = await app.request(
      '/uploads/presign',
      json({ filename: 'file.pdf' }), // no mimeType
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'mimeType is required when upload.allowedMimeTypes is configured.',
    });
    expect(presignPut).not.toHaveBeenCalled();
  });

  test('returns 400 when mimeType is not in allowedMimeTypes list (line 275)', async () => {
    const presignPut = mock(async () => 'https://uploads.example/test');
    const { app } = makeUploadApp({
      adapter: { presignPut, delete: async () => {} },
      uploadConfig: { allowedMimeTypes: ['image/png'] },
    });

    const response = await app.request(
      '/uploads/presign',
      json({ filename: 'file.pdf', mimeType: 'application/pdf' }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'File type "application/pdf" not allowed.',
    });
    expect(presignPut).not.toHaveBeenCalled();
  });

  test('mimeMatches wildcard pattern: accepts mime with wildcard allowedMimeType (line 20)', async () => {
    const presignPut = mock(async () => 'https://uploads.example/image');
    const { app } = makeUploadApp({
      adapter: { presignPut, delete: async () => {} },
      uploadConfig: { allowedMimeTypes: ['image/*'] },
    });

    const response = await app.request(
      '/uploads/presign',
      json({ filename: 'photo.png', mimeType: 'image/png' }),
    );

    expect(response.status).toBe(200);
    expect(presignPut).toHaveBeenCalled();
  });

  test('returns 413 when maxBytes exceeds configuredMaxFileSize (lines 284-290)', async () => {
    const presignPut = mock(async () => 'https://uploads.example/test');
    const { app } = makeUploadApp({
      adapter: { presignPut, delete: async () => {} },
      uploadConfig: { maxFileSize: 1000 },
    });

    const response = await app.request(
      '/uploads/presign',
      json({ filename: 'big.bin', mimeType: 'application/octet-stream', maxBytes: 5000 }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Requested upload size exceeds configured limit of 1000 bytes.',
    });
    expect(presignPut).not.toHaveBeenCalled();
  });

  test('uses configuredMaxFileSize as effectiveMaxBytes when request omits maxBytes (lines 310-311)', async () => {
    const presignPut = mock(async (key: string) => {
      return `https://uploads.example/${encodeURIComponent(key)}`;
    });
    const { app } = makeUploadApp({
      adapter: { presignPut, delete: async () => {} },
      uploadConfig: { maxFileSize: 2048 },
    });

    // Request without maxBytes — configuredMaxFileSize should be used
    const response = await app.request(
      '/uploads/presign',
      json({ filename: 'doc.pdf' }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // effectiveMaxBytes should come from configuredMaxFileSize
    expect(body.maxBytes).toBe(2048);
    expect(presignPut).toHaveBeenCalledWith(
      body.key,
      expect.objectContaining({ maxSize: 2048 }),
    );
  });

  test('effectiveMaxBytes is undefined when neither maxBytes nor maxFileSize is set (lines 307-312)', async () => {
    const presignPut = mock(async (key: string) => `https://uploads.example/${key}`);
    const { app } = makeUploadApp({
      adapter: { presignPut, delete: async () => {} },
      uploadConfig: {}, // no maxFileSize
    });

    const response = await app.request(
      '/uploads/presign',
      json({ filename: 'doc.pdf' }), // no maxBytes
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // effectiveMaxBytes is undefined → maxBytes not included in response
    expect(body.maxBytes).toBeUndefined();
    expect(presignPut).toHaveBeenCalledWith(
      body.key,
      expect.objectContaining({ maxSize: undefined }),
    );
  });

  test('deletes registered uploads for the owner and removes the registry record', async () => {
    const deleteSpy = mock(async () => {});
    const { app, records } = makeUploadApp({
      adapter: {
        delete: deleteSpy,
      },
      records: [
        {
          key: 'uploads/owned-delete.txt',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/uploads/owned-delete.txt', {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test',
      },
    });

    expect(response.status).toBe(204);
    expect(deleteSpy).toHaveBeenCalledWith('uploads/owned-delete.txt');
    expect(records.has('uploads/owned-delete.txt')).toBe(false);
  });
});
