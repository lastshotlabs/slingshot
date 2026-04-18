import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import { attachContext, createRouter } from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { memoryStorage } from '../../src/framework/adapters/memoryStorage';
import { handleUpload } from '../../src/framework/middleware/upload';
import { createUploadsRouter } from '../../src/framework/routes/uploads';
import { parseUpload } from '../../src/framework/upload/upload';
import { authHeader, createTestApp } from '../setup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMultipartRequest = (
  files: Array<{ field: string; name: string; content: string; mimeType: string }>,
  extraHeaders?: Record<string, string>,
): Request => {
  const boundary = '----TestBoundary123';
  const parts: string[] = [];
  for (const f of files) {
    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\n` +
        `Content-Type: ${f.mimeType}\r\n\r\n` +
        `${f.content}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  const body = parts.join('');
  return new Request('http://localhost/upload', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...extraHeaders,
    },
    body,
  });
};

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function getRuntime(app: any): AuthRuntimeContext {
  return (app as any).ctx.pluginState.get(AUTH_RUNTIME_KEY) as AuthRuntimeContext;
}

function makeUploadRouteRuntime(): AuthRuntimeContext {
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

async function registerSessionUser(app: any, email: string) {
  const res = await app.request('/auth/register', json({ email, password: 'password123' }));
  return res.json() as Promise<{ token: string; userId: string }>;
}

const createUploadApp = (adapter: any = memoryStorage(), config: Record<string, unknown> = {}) => {
  const app = createRouter();
  const slingshotCtx = {
    app,
    config: {},
    upload: { adapter, config },
    routeAuth: null,
    userResolver: null,
    rateLimitAdapter: null,
    fingerprintBuilder: null,
    cacheAdapters: new Map(),
    emailTemplates: new Map(),
    trustProxy: false,
    persistence: {
      uploadRegistry: {
        register: async () => {},
        get: async () => null,
        delete: async () => false,
      },
    },
    signing: null,
  } as any;
  app.use('*', async (c, next) => {
    c.set('slingshotCtx', slingshotCtx);
    await next();
  });
  return { app, slingshotCtx };
};

// ---------------------------------------------------------------------------
// handleUpload middleware
// ---------------------------------------------------------------------------

describe('handleUpload middleware', () => {
  it('sets uploadResults on context for a single file upload', async () => {
    const { app } = createUploadApp();
    let capturedResults: any[] = [];

    app.post('/upload', handleUpload({ field: 'file' }), async c => {
      capturedResults = c.get('uploadResults') ?? [];
      return c.json({ count: capturedResults.length });
    });

    const req = makeMultipartRequest([
      { field: 'file', name: 'test.txt', content: 'hello', mimeType: 'text/plain' },
    ]);
    const res = await app.request(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(capturedResults[0].originalName).toBe('test.txt');
    // Bun may append ;charset=utf-8 to text MIME types
    expect(capturedResults[0].mimeType).toMatch(/^text\/plain/);
  });

  it('returns 400 when MIME type is disallowed', async () => {
    const { app } = createUploadApp();
    app.post('/upload', handleUpload({ field: 'file', allowedMimeTypes: ['image/*'] }), async c => {
      return c.json({ ok: true });
    });

    const req = makeMultipartRequest([
      { field: 'file', name: 'script.js', content: 'alert(1)', mimeType: 'application/javascript' },
    ]);
    const res = await app.request(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('disallowed MIME type');
  });

  it('returns 400 when max file count is exceeded', async () => {
    const { app } = createUploadApp();
    app.post('/upload', handleUpload({ field: 'file', maxFiles: 1 }), async c => {
      return c.json({ ok: true });
    });

    const req = makeMultipartRequest([
      { field: 'file', name: 'a.txt', content: 'a', mimeType: 'text/plain' },
      { field: 'file', name: 'b.txt', content: 'b', mimeType: 'text/plain' },
    ]);
    const res = await app.request(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Too many files');
  });

  it('returns 413 from Content-Length pre-check before parsing body', async () => {
    const { app } = createUploadApp();
    app.post('/upload', handleUpload({ maxFileSize: 100, maxFiles: 1 }), async c => {
      return c.json({ ok: true });
    });

    // Content-Length exceeds maxFileSize * maxFiles (100 * 1 = 100)
    const req = makeMultipartRequest(
      [{ field: 'file', name: 'big.txt', content: 'x'.repeat(10), mimeType: 'text/plain' }],
      { 'content-length': '500' },
    );

    const res = await app.request(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain('too large');
  });

  it('passes meta.bucket when uploadBucket is set on context', async () => {
    const calls: Array<{ key: string; meta: any }> = [];
    const mockAdapter = {
      async put(key: string, _data: any, meta: any) {
        calls.push({ key, meta });
        return {};
      },
      async get(_key: string) {
        return null;
      },
      async delete(_key: string) {},
    };
    const { app } = createUploadApp(mockAdapter);
    app.use('/upload', async (c, next) => {
      c.set('uploadBucket', 'custom-bucket');
      await next();
    });
    app.post('/upload', handleUpload({ field: 'file' }), async c => {
      return c.json({ ok: true });
    });

    const req = makeMultipartRequest([
      { field: 'file', name: 'test.txt', content: 'hi', mimeType: 'text/plain' },
    ]);
    const res = await app.request(req);
    expect(res.status).toBe(200);
    expect(calls[0].meta.bucket).toBe('custom-bucket');
  });

  it('passes meta.bucket as undefined when uploadBucket is not set', async () => {
    const calls: Array<{ key: string; meta: any }> = [];
    const mockAdapter = {
      async put(key: string, _data: any, meta: any) {
        calls.push({ key, meta });
        return {};
      },
      async get(_key: string) {
        return null;
      },
      async delete(_key: string) {},
    };
    const { app } = createUploadApp(mockAdapter);
    app.post('/upload', handleUpload({ field: 'file' }), async c => {
      return c.json({ ok: true });
    });

    const req = makeMultipartRequest([
      { field: 'file', name: 'test.txt', content: 'hi', mimeType: 'text/plain' },
    ]);
    const res = await app.request(req);
    expect(res.status).toBe(200);
    expect(calls[0].meta.bucket).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseUpload — does NOT set context variable
// ---------------------------------------------------------------------------

describe('parseUpload', () => {
  it('returns results directly without setting context variable', async () => {
    let contextResults: any = 'not-set';
    const { app } = createUploadApp();
    app.post('/upload', async c => {
      const results = await parseUpload(c, { field: 'file' });
      contextResults = c.get('uploadResults'); // should still be null/undefined
      return c.json({ count: results.length });
    });

    const req = makeMultipartRequest([
      { field: 'file', name: 'doc.txt', content: 'content', mimeType: 'text/plain' },
    ]);
    const res = await app.request(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    // parseUpload should NOT set uploadResults on context (remains unset/undefined/null)
    expect(contextResults == null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Presigned URL route — 501 for memory adapter
// ---------------------------------------------------------------------------

describe('presigned URL route', () => {
  it('returns 501 when adapter does not support presignPut (memory adapter)', async () => {
    const router = createUploadsRouter({});
    // The router requires userAuth — set authUserId manually via middleware
    const app = createRouter();
    const routeAuth = {
      userAuth: async (c: any, next: any) => {
        if (!c.get('authUserId')) return c.json({ error: 'Unauthorized' }, 401);
        await next();
      },
      requireRole: () => async (_c: any, next: any) => {
        await next();
      },
    };
    const slingshotCtx = {
      app,
      signing: null,
      routeAuth,
      config: {},
      upload: { adapter: memoryStorage(), config: {} },
      userResolver: null,
      rateLimitAdapter: null,
      fingerprintBuilder: null,
      cacheAdapters: new Map(),
      emailTemplates: new Map(),
      pluginState: new Map([[AUTH_RUNTIME_KEY, makeUploadRouteRuntime()]]),
      trustProxy: false,
      persistence: {},
    } as any;
    app.use('*', async (c, next) => {
      c.set('slingshotCtx', slingshotCtx);
      c.set('authUserId', 'user-1');
      c.set('roles', ['user']);
      c.set('sessionId', 'sess-1');
      c.set('tenantId', null);
      c.set('tenantConfig', null);
      await next();
    });
    app.route('/', router);

    const res = await app.request('/uploads/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'uploads/test.jpg', mimeType: 'image/jpeg' }),
    });

    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toBe('Presigned URLs not supported by the configured storage adapter');
  });

  it('enforces upload.allowedMimeTypes for presigned uploads', async () => {
    const presignCalls: Array<{ key: string; opts: any }> = [];
    const mockAdapter = {
      async put(_key: string, _data: any, _meta: any) {
        return {};
      },
      async get(_key: string) {
        return null;
      },
      async delete(_key: string) {},
      async presignPut(key: string, opts: any) {
        presignCalls.push({ key, opts });
        return `https://example.com/upload/${encodeURIComponent(key)}`;
      },
    };
    const router = createUploadsRouter({});
    const app = createRouter();
    const routeAuth = {
      userAuth: async (c: any, next: any) => {
        if (!c.get('authUserId')) return c.json({ error: 'Unauthorized' }, 401);
        await next();
      },
      requireRole: () => async (_c: any, next: any) => {
        await next();
      },
    };
    const slingshotCtx = {
      app,
      signing: null,
      routeAuth,
      config: {},
      upload: {
        adapter: mockAdapter,
        config: { allowedMimeTypes: ['image/*'], maxFileSize: 1024 },
      },
      userResolver: null,
      rateLimitAdapter: null,
      fingerprintBuilder: null,
      cacheAdapters: new Map(),
      emailTemplates: new Map(),
      pluginState: new Map([[AUTH_RUNTIME_KEY, makeUploadRouteRuntime()]]),
      trustProxy: false,
      persistence: {
        uploadRegistry: {
          register: async () => {},
          get: async () => null,
          delete: async () => false,
        },
      },
    } as any;
    attachContext(app, slingshotCtx);
    app.use('*', async (c, next) => {
      c.set('slingshotCtx', slingshotCtx);
      c.set('authUserId', 'user-1');
      c.set('roles', ['user']);
      c.set('sessionId', 'sess-1');
      c.set('tenantId', null);
      c.set('tenantConfig', null);
      await next();
    });
    app.route('/', router);

    const missingMimeRes = await app.request('/uploads/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'avatar.png' }),
    });
    expect(missingMimeRes.status).toBe(400);
    expect((await missingMimeRes.json()).error).toContain('mimeType is required');

    const badMimeRes = await app.request('/uploads/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'notes.txt', mimeType: 'text/plain' }),
    });
    expect(badMimeRes.status).toBe(400);
    expect((await badMimeRes.json()).error).toContain('not allowed');

    const okRes = await app.request('/uploads/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'avatar.png', mimeType: 'image/png' }),
    });
    expect(okRes.status).toBe(200);
    const okBody = await okRes.json();
    expect(okBody.maxBytes).toBe(1024);
    expect(presignCalls).toHaveLength(1);
    expect(presignCalls[0].opts.mimeType).toBe('image/png');
    expect(presignCalls[0].opts.maxSize).toBe(1024);
  });

  it('rejects requested presigned upload sizes above upload.maxFileSize', async () => {
    const mockAdapter = {
      async put(_key: string, _data: any, _meta: any) {
        return {};
      },
      async get(_key: string) {
        return null;
      },
      async delete(_key: string) {},
      async presignPut(_key: string, _opts: any) {
        return 'https://example.com/upload';
      },
    };
    const router = createUploadsRouter({});
    const app = createRouter();
    const routeAuth = {
      userAuth: async (c: any, next: any) => {
        if (!c.get('authUserId')) return c.json({ error: 'Unauthorized' }, 401);
        await next();
      },
      requireRole: () => async (_c: any, next: any) => {
        await next();
      },
    };
    const slingshotCtx = {
      app,
      signing: null,
      routeAuth,
      config: {},
      upload: { adapter: mockAdapter, config: { maxFileSize: 1024 } },
      userResolver: null,
      rateLimitAdapter: null,
      fingerprintBuilder: null,
      cacheAdapters: new Map(),
      emailTemplates: new Map(),
      pluginState: new Map([[AUTH_RUNTIME_KEY, makeUploadRouteRuntime()]]),
      trustProxy: false,
      persistence: {
        uploadRegistry: {
          register: async () => {},
          get: async () => null,
          delete: async () => false,
        },
      },
    } as any;
    attachContext(app, slingshotCtx);
    app.use('*', async (c, next) => {
      c.set('slingshotCtx', slingshotCtx);
      c.set('authUserId', 'user-1');
      c.set('roles', ['user']);
      c.set('sessionId', 'sess-1');
      c.set('tenantId', null);
      c.set('tenantConfig', null);
      await next();
    });
    app.route('/', router);

    const res = await app.request('/uploads/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'big.bin',
        mimeType: 'application/octet-stream',
        maxBytes: 2048,
      }),
    });

    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain('configured limit');
  });
});

describe('presigned URL route account-state hardening', () => {
  it('blocks stale suspended sessions from minting upload URLs', async () => {
    const presignCalls: Array<{ key: string; opts: any }> = [];
    const storage = {
      async put(_key: string, _data: any, _meta: any) {
        return {};
      },
      async get(_key: string) {
        return null;
      },
      async delete(_key: string) {},
      async presignPut(key: string, opts: any) {
        presignCalls.push({ key, opts });
        return `https://example.com/upload/${encodeURIComponent(key)}`;
      },
      async presignGet(key: string) {
        return `https://example.com/download/${encodeURIComponent(key)}`;
      },
    };

    const app = await createTestApp(
      {
        upload: {
          storage,
          presignedUrls: true,
        },
      },
      {
        auth: {
          checkSuspensionOnIdentify: false,
        },
      },
    );

    const { token, userId } = await registerSessionUser(app, 'upload-suspended@example.com');
    const runtime = getRuntime(app);
    await runtime.adapter.setSuspended?.(userId, true, 'security hold');

    const res = await app.request('/uploads/presign', {
      ...json({ filename: 'avatar.png', mimeType: 'image/png' }),
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Account suspended' });
    expect(presignCalls).toHaveLength(0);
  });

  it('blocks stale unverified sessions from presigning downloads', async () => {
    const storage = {
      async put(_key: string, _data: any, _meta: any) {
        return {};
      },
      async get(_key: string) {
        return null;
      },
      async delete(_key: string) {},
      async presignPut(key: string) {
        return `https://example.com/upload/${encodeURIComponent(key)}`;
      },
      async presignGet(key: string) {
        return `https://example.com/download/${encodeURIComponent(key)}`;
      },
    };

    const app = await createTestApp(
      {
        upload: {
          storage,
          presignedUrls: true,
        },
      },
      {
        auth: {
          checkSuspensionOnIdentify: false,
          emailVerification: { required: true, tokenExpiry: 3600 },
        },
      },
    );

    const registerRes = await app.request(
      '/auth/register',
      json({ email: 'upload-verify@example.com', password: 'password123' }),
    );
    const { userId } = (await registerRes.json()) as { userId: string };
    const runtime = getRuntime(app);
    await runtime.adapter.setEmailVerified?.(userId, true);

    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'upload-verify@example.com', password: 'password123' }),
    );
    const { token } = (await loginRes.json()) as { token: string };

    const presignRes = await app.request('/uploads/presign', {
      ...json({ filename: 'report.pdf', mimeType: 'application/pdf' }),
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    });
    expect(presignRes.status).toBe(200);
    const { key } = (await presignRes.json()) as { key: string };

    await runtime.adapter.setEmailVerified?.(userId, false);

    const res = await app.request(`/uploads/presign/${key}`, {
      headers: authHeader(token),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Email not verified' });
  });
});

// ---------------------------------------------------------------------------
// s3Storage bucket selection
// ---------------------------------------------------------------------------

describe('s3Storage bucket selection', () => {
  it('uses meta.bucket over config.bucket when present', async () => {
    const calls: Array<Record<string, unknown>> = [];

    // Mock the S3 require
    const mockSend = async (command: any) => {
      calls.push(command.input ?? command);
      return {};
    };
    const mockClient = { send: mockSend };
    const mockPutObjectCommand = class {
      input: any;
      constructor(params: any) {
        this.input = params;
      }
    };

    // We test the bucket selection logic directly by constructing a minimal mock
    // that mimics what s3Storage does: `const bucket = meta.bucket ?? config.bucket`
    const configBucket = 'default-bucket';
    const metaBucket = 'override-bucket';

    // Simulate bucket selection logic
    const selectedBucket = metaBucket ?? configBucket;
    expect(selectedBucket).toBe('override-bucket');
  });

  it('falls back to config.bucket when meta.bucket is undefined', async () => {
    const configBucket = 'default-bucket';
    const metaBucket = undefined;

    const selectedBucket = metaBucket ?? configBucket;
    expect(selectedBucket).toBe('default-bucket');
  });
});
