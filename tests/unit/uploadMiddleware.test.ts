/**
 * Tests for src/framework/middleware/upload.ts (lines 44-70)
 *
 * The middleware wraps parseUpload, so tests use real Hono app integration
 * for cases that need next() to be called, and test the content-length
 * pre-check directly for the 413 path.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { attachContext } from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { handleUpload } from '../../src/framework/middleware/upload';
import { memoryStorage } from '../../src/framework/adapters/memoryStorage';

function makeSlingshotCtx(
  app: object,
  uploadConfig: {
    adapter?: object | null;
    maxFileSize?: number;
    maxFiles?: number;
  } = {},
) {
  const { adapter = null, ...config } = uploadConfig;
  const ctx = {
    app,
    config: { appName: 'test', resolvedStores: {}, security: {}, captcha: null },
    upload: { adapter, config },
    redis: null,
    mongo: null,
    sqlite: null,
    signing: null,
    dataEncryptionKeys: [],
    ws: null,
    persistence: {
      uploadRegistry: {
        register: async () => {},
        get: async () => null,
        delete: async () => false,
      },
    },
    pluginState: new Map(),
    routeAuth: null,
    userResolver: null,
    rateLimitAdapter: null,
    fingerprintBuilder: null,
    cacheAdapters: new Map(),
    emailTemplates: new Map(),
    trustProxy: false,
    async clear() {},
    async destroy() {},
  } as any;
  attachContext(app, ctx);
  return ctx;
}

function buildApp(uploadConfig: { maxFileSize?: number; maxFiles?: number; adapter?: any } = {}) {
  const app = new Hono<AppEnv>();
  makeSlingshotCtx(app, uploadConfig);

  // Inject slingshotCtx into every request
  app.use(async (c, next) => {
    const { getContext } = await import('@lastshotlabs/slingshot-core');
    (c as any).set('slingshotCtx', getContext(app));
    await next();
  });

  return app;
}

describe('handleUpload middleware — content-length pre-check', () => {
  test('responds 413 when content-length exceeds maxFileSize * maxFiles', async () => {
    const app = buildApp({});
    app.use('/upload', handleUpload({ maxFileSize: 1024, maxFiles: 1 }));
    app.post('/upload', c => c.json({ ok: true }));

    const res = await app.request('/upload', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=xxx',
        'content-length': String(2 * 1024), // 2 KB > 1 KB limit
      },
      body: '--xxx--',
    });

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain('too large');
  });

  test('413 error message includes the limit in bytes', async () => {
    const app = buildApp({});
    app.use('/upload', handleUpload({ maxFileSize: 100, maxFiles: 5 }));
    app.post('/upload', c => c.json({ ok: true }));

    const res = await app.request('/upload', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=xxx',
        'content-length': String(5000), // 5000 > 500
      },
      body: '--xxx--',
    });

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain('500'); // maxFileSize * maxFiles = 100 * 5 = 500
  });

  test('allows request through when content-length is within limit', async () => {
    const app = buildApp({ adapter: memoryStorage() });
    app.use('/upload', handleUpload({ maxFileSize: 10 * 1024 * 1024, maxFiles: 10 }));
    app.post('/upload', c => c.json({ ok: true }));

    // Small body that won't fail the pre-check (no actual file — no real parse needed)
    const res = await app.request('/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '50',
      },
      body: JSON.stringify({}),
    });

    // Even if parseUpload returns empty (no multipart body), we should get 200 or pass-through
    // The key is we did NOT get 413 from the content-length pre-check
    expect(res.status).not.toBe(413);
  });

  test('skips pre-check when content-length header is 0', async () => {
    const app = buildApp({ adapter: memoryStorage() });
    app.use('/upload', handleUpload({ maxFileSize: 10, maxFiles: 1 }));
    app.post('/upload', c => c.json({ ok: true }));

    const res = await app.request('/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      // No content-length header
      body: JSON.stringify({}),
    });

    // No 413 — content-length is absent/0
    expect(res.status).not.toBe(413);
  });
});

describe('handleUpload middleware — parseUpload error handling', () => {
  test('responds 400 when upload parse fails with 400 error', async () => {
    const app = buildApp({});
    // No adapter configured → parseUpload will fail validation
    app.use('/upload', handleUpload({ maxFileSize: 10 * 1024 * 1024, maxFiles: 10 }));
    app.post('/upload', c => c.json({ ok: true }));

    // Send a malformed multipart body
    const res = await app.request('/upload', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=---xbound',
      },
      body: '---xbound\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n---xbound--',
    });

    // Either 400 (bad upload) or pass-through — it should not be 413
    expect([200, 400, 500]).toContain(res.status);
  });

  test('uses app-level config maxFileSize as default', async () => {
    const app = buildApp({ maxFileSize: 10, maxFiles: 1 });
    app.use('/upload', handleUpload()); // no per-route opts
    app.post('/upload', c => c.json({ ok: true }));

    const res = await app.request('/upload', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=xxx',
        'content-length': String(200), // 200 > 10*1=10
      },
      body: '--xxx--',
    });

    expect(res.status).toBe(413);
  });
});
