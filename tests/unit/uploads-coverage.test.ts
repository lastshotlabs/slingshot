/**
 * Coverage tests for src/framework/routes/uploads.ts
 *
 * Targets uncovered lines:
 *   - 101-133: checkUploadAccess branches (exercised through delete route)
 *   - 394-435: presignGet handler signing and adapter fallback paths
 *   - 483-486: delete handler success path
 */
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
  const records = new Map((options?.records ?? []).map(r => [r.key, r]));
  const routeAuth = {
    userAuth: async (c: any, next: () => Promise<void>) => {
      const token = c.req.header('authorization');
      if (!token) return c.json({ error: 'Unauthorized' }, 401);
      c.set('authUserId', c.req.header('x-user-id') ?? 'user-1');
      c.set('tenantId', c.req.header('x-tenant-id') ?? 'tenant-1');
      await next();
    },
    requireRole:
      (..._roles: string[]) =>
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
        get: async (key: string) => records.get(key) ?? null,
        delete: async (key: string) => records.delete(key),
      },
    },
  } as any;

  attachContext(app, slingshotCtx);
  app.route('/', createUploadsRouter((options?.routerConfig ?? {}) as any));
  return { app, records };
}

// ---------------------------------------------------------------------------
// checkUploadAccess through DELETE route — lines 101-133
// ---------------------------------------------------------------------------

describe('uploads DELETE — checkUploadAccess branches', () => {
  test('cross-tenant delete is denied even if user is the owner (line 101-103)', async () => {
    const deleteSpy = mock(async () => {});
    const { app } = makeUploadApp({
      adapter: { delete: deleteSpy },
      records: [
        {
          key: 'cross-tenant/file.txt',
          ownerUserId: 'user-1',
          tenantId: 'other-tenant',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/cross-tenant/file.txt', {
      method: 'DELETE',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(403);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test('owner match grants delete access (lines 105-106)', async () => {
    const deleteSpy = mock(async () => {});
    const { app, records } = makeUploadApp({
      adapter: { delete: deleteSpy },
      records: [
        {
          key: 'owner/file.txt',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/owner/file.txt', {
      method: 'DELETE',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(204);
    expect(deleteSpy).toHaveBeenCalledWith('owner/file.txt');
    expect(records.has('owner/file.txt')).toBe(false);
  });

  test('authorize callback is used when record exists but owner does not match (lines 109-117)', async () => {
    const authorize = mock(async () => true);
    const deleteSpy = mock(async () => {});
    const { app } = makeUploadApp({
      adapter: { delete: deleteSpy },
      routerConfig: {
        authorization: { authorize },
      },
      records: [
        {
          key: 'shared/file.txt',
          ownerUserId: 'other-user',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/shared/file.txt', {
      method: 'DELETE',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(204);
    expect(authorize).toHaveBeenCalledWith({
      action: 'delete',
      key: 'shared/file.txt',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
    expect(deleteSpy).toHaveBeenCalled();
  });

  test('authorize callback returning false denies delete (line 116-117)', async () => {
    const authorize = mock(async () => false);
    const deleteSpy = mock(async () => {});
    const { app } = makeUploadApp({
      adapter: { delete: deleteSpy },
      routerConfig: {
        authorization: { authorize },
      },
      records: [
        {
          key: 'denied/file.txt',
          ownerUserId: 'other-user',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/denied/file.txt', {
      method: 'DELETE',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(403);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test('no authorize callback and owner mismatch returns 403 (line 118)', async () => {
    const deleteSpy = mock(async () => {});
    const { app } = makeUploadApp({
      adapter: { delete: deleteSpy },
      records: [
        {
          key: 'private/file.txt',
          ownerUserId: 'other-user',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/private/file.txt', {
      method: 'DELETE',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(403);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test('external key with authorize callback grants delete (lines 122-131)', async () => {
    const authorize = mock(async () => true);
    const deleteSpy = mock(async () => {});
    const { app } = makeUploadApp({
      adapter: { delete: deleteSpy },
      routerConfig: {
        allowExternalKeys: true,
        authorization: { authorize },
      },
    });

    const response = await app.request('/uploads/external/unregistered.txt', {
      method: 'DELETE',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(204);
    expect(authorize).toHaveBeenCalledWith({
      action: 'delete',
      key: 'external/unregistered.txt',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
  });

  test('external key without authorize callback returns 403 (line 132)', async () => {
    const deleteSpy = mock(async () => {});
    const { app } = makeUploadApp({
      adapter: { delete: deleteSpy },
      routerConfig: {
        allowExternalKeys: true,
      },
    });

    const response = await app.request('/uploads/external/noop.bin', {
      method: 'DELETE',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(403);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test('external keys disabled returns 404 for unregistered key (line 135)', async () => {
    const deleteSpy = mock(async () => {});
    const { app } = makeUploadApp({
      adapter: { delete: deleteSpy },
    });

    const response = await app.request('/uploads/unregistered/key.txt', {
      method: 'DELETE',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(404);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test('record with no ownerUserId and no authorize callback returns 403', async () => {
    const deleteSpy = mock(async () => {});
    const { app } = makeUploadApp({
      adapter: { delete: deleteSpy },
      records: [
        {
          key: 'no-owner/file.txt',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/no-owner/file.txt', {
      method: 'DELETE',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// presignGet handler — lines 394-435
// ---------------------------------------------------------------------------

describe('uploads GET presign — signing and adapter fallback', () => {
  test('uses default expirySeconds from config when query param omitted (lines 396-400)', async () => {
    const presignGet = mock(async (_key: string, opts: any) => {
      return `https://downloads.example/${_key}?e=${opts.expirySeconds}`;
    });
    const { app } = makeUploadApp({
      adapter: { presignGet },
      routerConfig: { expirySeconds: 120 },
      records: [
        {
          key: 'reports/doc.pdf',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/reports/doc.pdf', {
      headers: { authorization: 'Bearer test' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(presignGet).toHaveBeenCalledWith('reports/doc.pdf', { expirySeconds: 120 });
    expect(body.url).toContain('reports/doc.pdf');
  });

  test('uses default 3600 when neither query expiry nor config expirySeconds set (line 400)', async () => {
    const presignGet = mock(async (_key: string, opts: any) => {
      return `https://downloads.example/${_key}?e=${opts.expirySeconds}`;
    });
    const { app } = makeUploadApp({
      adapter: { presignGet },
      records: [
        {
          key: 'default-expiry.pdf',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/default-expiry.pdf', {
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(200);
    expect(presignGet).toHaveBeenCalledWith('default-expiry.pdf', { expirySeconds: 3600 });
  });

  test('signing.presignedUrls=true without secret returns 501 (lines 404-405)', async () => {
    const { app } = makeUploadApp({
      signing: { presignedUrls: true, secret: null },
      records: [
        {
          key: 'no-secret.pdf',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/no-secret.pdf', {
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.error).toBe('Signing secret not configured');
  });

  test('signing.presignedUrls object uses its defaultExpiry (lines 407-409)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { app } = makeUploadApp({
      signing: { secret: 'test-secret', presignedUrls: { defaultExpiry: 300 } },
      records: [
        {
          key: 'custom-expiry.pdf',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/custom-expiry.pdf', {
      headers: { authorization: 'Bearer test' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toContain('/uploads/download/custom-expiry.pdf');
    expect(body.expiresAt).toBeGreaterThanOrEqual(now + 295);
    expect(body.expiresAt).toBeLessThanOrEqual(now + 305);
  });

  test('signing.presignedUrls=true (boolean) uses expirySeconds as default (lines 408-409)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { app } = makeUploadApp({
      signing: { secret: 'test-secret', presignedUrls: true },
      records: [
        {
          key: 'bool-sign.pdf',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/bool-sign.pdf?expiry=60', {
      headers: { authorization: 'Bearer test' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toContain('/uploads/download/bool-sign.pdf');
    // When presignedUrls is a boolean (not object), expirySeconds from query is used
    expect(body.expiresAt).toBeGreaterThanOrEqual(now + 55);
    expect(body.expiresAt).toBeLessThanOrEqual(now + 65);
  });

  test('adapter.presignGet fallback returns url and expiresAt (lines 424-436)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const presignGet = mock(async (key: string, opts: any) => {
      return `https://s3.example/${key}?expiry=${opts.expirySeconds}`;
    });
    const { app } = makeUploadApp({
      adapter: { presignGet },
      records: [
        {
          key: 'adapter-fallback.pdf',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/adapter-fallback.pdf?expiry=900', {
      headers: { authorization: 'Bearer test' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toContain('adapter-fallback.pdf');
    expect(body.expiresAt).toBeGreaterThanOrEqual(now + 895);
    expect(body.expiresAt).toBeLessThanOrEqual(now + 905);
  });

  test('returns 501 when no signing and no adapter.presignGet (lines 425-433)', async () => {
    const { app } = makeUploadApp({
      adapter: {},
      records: [
        {
          key: 'no-presign.pdf',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/no-presign.pdf', {
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.error).toContain('Presigned download URLs not supported');
  });

  test('presignGet returns 404 for unregistered key (line 393)', async () => {
    const { app } = makeUploadApp({
      adapter: { presignGet: mock(async () => 'url') },
    });

    const response = await app.request('/uploads/presign/missing-key.pdf', {
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Not found');
  });

  test('presignGet returns 403 for non-owner without authorize callback (line 394)', async () => {
    const { app } = makeUploadApp({
      adapter: { presignGet: mock(async () => 'url') },
      records: [
        {
          key: 'other-owner.pdf',
          ownerUserId: 'other-user',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    const response = await app.request('/uploads/presign/other-owner.pdf', {
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE handler — lines 483-486 (success path)
// ---------------------------------------------------------------------------

describe('uploads DELETE — success path (lines 483-486)', () => {
  test('successfully deletes file and removes registry record', async () => {
    const deleteSpy = mock(async () => {});
    const { app, records } = makeUploadApp({
      adapter: { delete: deleteSpy },
      records: [
        {
          key: 'to-delete/file.bin',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
          createdAt: Date.now(),
        },
      ],
    });

    expect(records.has('to-delete/file.bin')).toBe(true);

    const response = await app.request('/uploads/to-delete/file.bin', {
      method: 'DELETE',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(204);
    expect(deleteSpy).toHaveBeenCalledWith('to-delete/file.bin');
    expect(records.has('to-delete/file.bin')).toBe(false);
  });
});
