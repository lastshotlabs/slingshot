import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import { attachContext, createRouter } from '@lastshotlabs/slingshot-core';
import type { Actor, AppEnv } from '@lastshotlabs/slingshot-core';
import { memoryStorage } from '../../src/framework/adapters/memoryStorage';
import {
  generateUploadKey,
  generateUploadKeyFromFilename,
  parseUpload,
  processUpload,
  validateFile,
} from '../../src/framework/upload/upload';

const makeUploadRuntime = (
  adapter: any = memoryStorage(),
  config: Record<string, unknown> = {},
) => {
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
  } as any;
  attachContext(app, slingshotCtx);
  return { app, slingshotCtx };
};

// ---------------------------------------------------------------------------
// validateFile
// ---------------------------------------------------------------------------

describe('validateFile', () => {
  it('accepts a valid file within size and MIME limits', () => {
    const file = new File(['hello'], 'test.txt', { type: 'text/plain' });
    // Bun may append ;charset=utf-8 — use wildcard to tolerate that
    const result = validateFile(file, { maxFileSize: 1024, allowedMimeTypes: ['text/*'] });
    expect(result).toBeNull();
  });

  it('rejects a file that exceeds maxFileSize', () => {
    const data = new Uint8Array(200);
    const file = new File([data], 'big.bin', { type: 'application/octet-stream' });
    const result = validateFile(file, { maxFileSize: 100 });
    expect(result).not.toBeNull();
    expect(result).toContain('exceeds maximum size');
  });

  it('rejects a file with a disallowed MIME type', () => {
    const file = new File(['data'], 'script.js', { type: 'application/javascript' });
    const result = validateFile(file, { allowedMimeTypes: ['image/png', 'image/jpeg'] });
    expect(result).not.toBeNull();
    expect(result).toContain('disallowed MIME type');
  });

  it('accepts a file matching a wildcard MIME pattern', () => {
    const file = new File(['img'], 'photo.jpg', { type: 'image/jpeg' });
    const result = validateFile(file, { allowedMimeTypes: ['image/*'] });
    expect(result).toBeNull();
  });

  it('rejects a file that does not match the wildcard', () => {
    const file = new File(['doc'], 'doc.pdf', { type: 'application/pdf' });
    const result = validateFile(file, { allowedMimeTypes: ['image/*'] });
    expect(result).not.toBeNull();
  });

  it('accepts any MIME type when allowedMimeTypes is empty', () => {
    const file = new File(['x'], 'x.bin', { type: 'application/octet-stream' });
    expect(validateFile(file, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generateUploadKey
// ---------------------------------------------------------------------------

describe('generateUploadKey', () => {
  it('uses default uploads/ prefix', () => {
    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    const key = generateUploadKey(file, {});
    expect(key).toMatch(/^uploads\//);
    expect(key).toMatch(/\.jpg$/);
  });

  it('uses custom keyPrefix', () => {
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    const key = generateUploadKey(file, {}, { keyPrefix: 'media/images/' });
    expect(key).toMatch(/^media\/images\//);
  });

  it('scopes key with tenantId when tenantScopedKeys is true', () => {
    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    const key = generateUploadKey(file, { tenantId: 'tenant-abc' }, { tenantScopedKeys: true });
    expect(key).toContain('tenant-abc/');
  });

  it('does not scope key when tenantId is absent even if tenantScopedKeys is true', () => {
    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    const key = generateUploadKey(file, {}, { tenantScopedKeys: true });
    expect(key).toMatch(/^uploads\//);
    expect(key).not.toContain('undefined');
  });

  it('uses custom generateKey function', () => {
    const file = new File(['x'], 'anything.jpg', { type: 'image/jpeg' });
    const key = generateUploadKey(
      file,
      { userId: 'u-1' },
      {
        generateKey: (_f, ctx) => `custom/${ctx.userId}/file.jpg`,
      },
    );
    expect(key).toBe('custom/u-1/file.jpg');
  });
});

// ---------------------------------------------------------------------------
// processUpload
// ---------------------------------------------------------------------------

describe('processUpload', () => {
  it('stores a file in the adapter and returns UploadResult', async () => {
    const { slingshotCtx } = makeUploadRuntime();
    const file = new File(['hello world'], 'test.txt', { type: 'text/plain' });
    const result = await processUpload(file, { carrier: slingshotCtx });
    expect(result.key).toMatch(/^uploads\//);
    expect(result.originalName).toBe('test.txt');
    // Bun may append ;charset=utf-8 — check it starts with the base MIME type
    expect(result.mimeType).toMatch(/^text\/plain/);
    expect(result.size).toBe(file.size);
  });

  it('throws 400 HttpError when file fails validation', async () => {
    const { slingshotCtx } = makeUploadRuntime();
    const data = new Uint8Array(200);
    const file = new File([data], 'large.bin', { type: 'application/octet-stream' });
    await expect(
      processUpload(file, { maxFileSize: 10, carrier: slingshotCtx }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('throws 500 HttpError when no adapter is configured', async () => {
    const { slingshotCtx } = makeUploadRuntime(null);
    const file = new File(['x'], 'test.txt', { type: 'text/plain' });
    await expect(processUpload(file, { carrier: slingshotCtx })).rejects.toMatchObject({
      status: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// parseUpload
// ---------------------------------------------------------------------------

describe('parseUpload', () => {
  const makeContext = (fields: Record<string, File | File[]>): Context<AppEnv> => {
    const { slingshotCtx } = makeUploadRuntime();
    // Build a minimal context mock that supports parseBody
    const body: Record<string, File | File[]> = { ...fields };
    return {
      req: {
        parseBody: async () => body as any,
        header: () => undefined,
      },
      get: (key: string) => {
        if (key === 'slingshotCtx') return slingshotCtx;
        if (key === 'tenantId') return null;
        if (key === 'uploadBucket') return undefined;
        return null;
      },
      set: () => {},
    } as unknown as Context<AppEnv>;
  };

  it('returns UploadResult for a single file upload', async () => {
    const file = new File(['content'], 'hello.txt', { type: 'text/plain' });
    const ctx = makeContext({ file });
    const results = await parseUpload(ctx, { field: 'file' });
    expect(results).toHaveLength(1);
    expect(results[0].originalName).toBe('hello.txt');
  });

  it('uses actor-derived identity when raw auth variables are absent', async () => {
    const { slingshotCtx } = makeUploadRuntime();
    const actor: Actor = {
      id: 'user-9',
      kind: 'user',
      tenantId: 'tenant-9',
      sessionId: null,
      roles: null,
      claims: {},
    };
    const body = { file: new File(['content'], 'hello.txt', { type: 'text/plain' }) };
    const ctx = {
      req: {
        parseBody: async () => body,
        header: () => undefined,
      },
      get: (key: string) => {
        if (key === 'slingshotCtx') return slingshotCtx;
        if (key === 'actor') return actor;
        if (key === 'uploadBucket') return undefined;
        return null;
      },
      set: () => {},
    } as unknown as Context<AppEnv>;

    const results = await parseUpload(ctx, {
      field: 'file',
      generateKey: (_file, identity) => `${identity.tenantId}/${identity.userId}/upload.txt`,
    });

    expect(results[0].key).toBe('tenant-9/user-9/upload.txt');
  });

  it('handles multiple field names', async () => {
    const file1 = new File(['a'], 'a.txt', { type: 'text/plain' });
    const file2 = new File(['b'], 'b.txt', { type: 'text/plain' });
    const ctx = makeContext({ avatar: file1, document: file2 });
    const results = await parseUpload(ctx, { field: ['avatar', 'document'] });
    expect(results).toHaveLength(2);
  });

  it('throws 400 HttpError when maxFiles is exceeded', async () => {
    const files = [
      new File(['a'], 'a.txt', { type: 'text/plain' }),
      new File(['b'], 'b.txt', { type: 'text/plain' }),
      new File(['c'], 'c.txt', { type: 'text/plain' }),
    ];
    const ctx = makeContext({ file: files });
    await expect(parseUpload(ctx, { field: 'file', maxFiles: 2 })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('ignores non-File values in the body', async () => {
    const ctx = makeContext({ file: 'not-a-file' as any });
    const results = await parseUpload(ctx, { field: 'file' });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// upload extension sanitization
// ---------------------------------------------------------------------------

describe('upload extension sanitization', () => {
  it('strips extension from path-traversal filename', () => {
    const file = new File([], '../../../etc/passwd');
    const key = generateUploadKey(file, {});
    expect(key.endsWith('.passwd')).toBe(false);
    // No extension should be appended
    expect(key).toMatch(/^uploads\/[0-9a-f-]+$/);
  });

  it('preserves .jpg extension from safe filename (regression)', () => {
    const file = new File([], 'photo.jpg');
    const key = generateUploadKey(file, {});
    expect(key.endsWith('.jpg')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateUploadKeyFromFilename
// ---------------------------------------------------------------------------

describe('generateUploadKeyFromFilename', () => {
  it('generates a key from a filename with extension', () => {
    const key = generateUploadKeyFromFilename('photo.jpg', {});
    expect(key).toMatch(/^uploads\//);
    expect(key).toMatch(/\.jpg$/);
  });

  it('generates a key without extension when filename has no extension', () => {
    const key = generateUploadKeyFromFilename('noextension', {});
    expect(key).toMatch(/^uploads\//);
    expect(key).not.toContain('.');
  });

  it('uses undefined filename gracefully', () => {
    const key = generateUploadKeyFromFilename(undefined, {});
    expect(key).toMatch(/^uploads\//);
  });

  it('uses custom generateKey function (lines 65-67 coverage)', () => {
    // When a generateKey function is provided, it creates a stub File from the
    // filename and calls the function — exercises lines 65-67 of upload.ts.
    const key = generateUploadKeyFromFilename(
      'original-name.png',
      { userId: 'u-42' },
      {
        generateKey: (file, ctx) => `custom/${ctx.userId}/${file.name}`,
      },
    );
    expect(key).toBe('custom/u-42/original-name.png');
  });

  it('uses custom generateKey with undefined filename (stub file has name "upload")', () => {
    const key = generateUploadKeyFromFilename(
      undefined,
      {},
      {
        generateKey: file => `fallback/${file.name}`,
      },
    );
    expect(key).toBe('fallback/upload');
  });
});
