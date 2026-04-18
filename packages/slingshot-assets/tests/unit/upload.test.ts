import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import {
  type AppEnv,
  type StorageAdapter,
  attachContext,
  createRouter,
} from '@lastshotlabs/slingshot-core';
import { memoryStorage } from '../../src/adapters/memory';
import {
  generateUploadKey,
  generateUploadKeyFromFilename,
  parseUpload,
  processUpload,
  validateFile,
} from '../../src/lib/upload';

function makeUploadRuntime(adapter: StorageAdapter | null = memoryStorage(), config: object = {}) {
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
    persistence: {},
  } as const;
  attachContext(app, slingshotCtx as never);
  return slingshotCtx;
}

function makeContext(fields: Record<string, unknown>, adapter: StorageAdapter = memoryStorage()) {
  const slingshotCtx = makeUploadRuntime(adapter, {});
  return {
    req: {
      parseBody: async () => fields,
      header: (_name: string) => undefined,
    },
    get(key: string) {
      switch (key) {
        case 'slingshotCtx':
          return slingshotCtx;
        case 'authUserId':
          return 'user-1';
        case 'tenantId':
          return null;
        case 'uploadBucket':
          return undefined;
        default:
          return null;
      }
    },
    set(_key: string, _value: unknown) {},
  } as unknown as Context<AppEnv>;
}

describe('validateFile', () => {
  it('accepts a file within size and MIME limits', () => {
    const file = new File(['hello'], 'test.txt', { type: 'text/plain' });
    expect(validateFile(file, { maxFileSize: 1024, allowedMimeTypes: ['text/*'] })).toBeNull();
  });

  it('rejects a file that exceeds maxFileSize', () => {
    const file = new File([new Uint8Array(200)], 'big.bin', { type: 'application/octet-stream' });
    expect(validateFile(file, { maxFileSize: 100 })).toContain('exceeds maximum size');
  });

  it('rejects a file with a disallowed MIME type', () => {
    const file = new File(['data'], 'script.js', { type: 'application/javascript' });
    expect(validateFile(file, { allowedMimeTypes: ['image/*'] })).toContain('disallowed MIME type');
  });
});

describe('generateUploadKey', () => {
  it('uses the default uploads/ prefix and preserves a safe extension', () => {
    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    const key = generateUploadKey(file, {});
    expect(key).toMatch(/^uploads\//);
    expect(key).toMatch(/\.jpg$/);
  });

  it('scopes the key with tenantId when tenantScopedKeys is true', () => {
    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    const key = generateUploadKey(file, { tenantId: 'tenant-1' }, { tenantScopedKeys: true });
    expect(key).toContain('tenant-1/');
  });

  it('supports filename-only key generation for presign flows', () => {
    const key = generateUploadKeyFromFilename('avatar.png', { userId: 'user-1' });
    expect(key).toMatch(/^uploads\//);
    expect(key).toMatch(/\.png$/);
  });

  it('strips unsafe traversal-style extensions', () => {
    const key = generateUploadKeyFromFilename('../../../etc/passwd', {});
    expect(key.endsWith('.passwd')).toBe(false);
  });
});

describe('processUpload', () => {
  it('stores a file and returns upload metadata', async () => {
    const result = await processUpload(new File(['hello'], 'test.txt', { type: 'text/plain' }), {
      carrier: makeUploadRuntime(),
    });
    expect(result.key).toMatch(/^uploads\//);
    expect(result.originalName).toBe('test.txt');
    expect(result.mimeType).toMatch(/^text\/plain/);
  });

  it('throws 400 when validation fails', async () => {
    await expect(
      processUpload(new File([new Uint8Array(200)], 'large.bin'), {
        maxFileSize: 10,
        carrier: makeUploadRuntime(),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('throws 500 when no adapter is configured', async () => {
    await expect(
      processUpload(new File(['x'], 'test.txt', { type: 'text/plain' }), {
        carrier: makeUploadRuntime(null),
      }),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe('parseUpload', () => {
  it('returns one result for a single file', async () => {
    const results = await parseUpload(
      makeContext({
        file: new File(['content'], 'hello.txt', { type: 'text/plain' }),
      }),
      { field: 'file' },
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.originalName).toBe('hello.txt');
  });

  it('handles multiple fields', async () => {
    const results = await parseUpload(
      makeContext({
        avatar: new File(['a'], 'a.txt', { type: 'text/plain' }),
        document: new File(['b'], 'b.txt', { type: 'text/plain' }),
      }),
      { field: ['avatar', 'document'] },
    );
    expect(results).toHaveLength(2);
  });

  it('throws when maxFiles is exceeded', async () => {
    await expect(
      parseUpload(
        makeContext({
          file: [
            new File(['a'], 'a.txt', { type: 'text/plain' }),
            new File(['b'], 'b.txt', { type: 'text/plain' }),
            new File(['c'], 'c.txt', { type: 'text/plain' }),
          ],
        }),
        { field: 'file', maxFiles: 2 },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
