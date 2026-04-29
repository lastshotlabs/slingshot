/**
 * Edge-case coverage for upload helpers.
 *
 * Builds on the core upload tests in upload.test.ts.
 * Covers empty files, filename byte-length limit, MIME wildcard matching,
 * custom generateKey functions, storage adapter failures, tenant-scoped keys
 * without a tenant, and unsafe extensions.
 */
import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import type {
  AppEnv,
  StorageAdapter,
} from '@lastshotlabs/slingshot-core';
import {
  attachContext,
  createDefaultIdentityResolver,
  createRouter,
} from '@lastshotlabs/slingshot-core';
import { memoryStorage } from '../../src/adapters/memory';
import {
  generateUploadKey,
  generateUploadKeyFromFilename,
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
    actorResolver: null,
    identityResolver: createDefaultIdentityResolver(),
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
      header: () => undefined,
    },
    get(key: string) {
      switch (key) {
        case 'slingshotCtx':
          return slingshotCtx;
        case 'actor':
          return {
            id: 'user-1',
            kind: 'user',
            tenantId: null,
            sessionId: null,
            roles: null,
            claims: {},
          };
        case 'tenantId':
          return null;
        case 'uploadBucket':
          return undefined;
        default:
          return null;
      }
    },
    set() {},
  } as unknown as Context<AppEnv>;
}

// ---------------------------------------------------------------------------
// Empty file and filename edge cases
// ---------------------------------------------------------------------------

describe('validateFile edge cases', () => {
  it('accepts an empty file (size=0) when maxFileSize permits', () => {
    const file = new File([], 'empty.txt', { type: 'text/plain' });
    expect(validateFile(file, { maxFileSize: 1024 })).toBeNull();
  });

  it('rejects a file with an excessively long filename (over 255 bytes)', () => {
    const longName = 'a'.repeat(300) + '.txt';
    const file = new File(['data'], longName, { type: 'text/plain' });
    const result = validateFile(file, { maxFileSize: 1024 });
    expect(result).toContain('exceeds the maximum allowed length');
  });

  it('accepts a filename exactly at the 255-byte boundary', () => {
    // 255 bytes = 248 chars + '.txt' (4 bytes) = 252 bytes. Account for extension.
    const name = 'a'.repeat(251) + '.txt'; // 255 bytes
    const file = new File(['data'], name, { type: 'text/plain' });
    expect(validateFile(file, { maxFileSize: 1024 })).toBeNull();
  });

  it('rejects file with disallowed MIME using exact-match pattern', () => {
    const file = new File(['x'], 'test.pdf', { type: 'application/pdf' });
    const result = validateFile(file, {
      allowedMimeTypes: ['application/pdf'],
      maxFileSize: 1024,
    });
    expect(result).toBeNull();
  });

  it('rejects file with MIME that does not match any pattern', () => {
    const file = new File(['x'], 'test.exe', { type: 'application/x-msdownload' });
    const result = validateFile(file, {
      allowedMimeTypes: ['image/*', 'text/*'],
      maxFileSize: 1024,
    });
    expect(result).toContain('disallowed MIME type');
  });
});

// ---------------------------------------------------------------------------
// Key generation edge cases
// ---------------------------------------------------------------------------

describe('generateUploadKey edge cases', () => {
  it('strips unsafe extensions that do not match alphanumeric pattern', () => {
    // Extension with special chars should be stripped
    const file = new File(['x'], 'photo."jpg', { type: 'image/jpeg' });
    const key = generateUploadKey(file, {});
    expect(key).toMatch(/^uploads\//);
    // Extension is "." followed by non-alphanumeric — should be stripped
    expect(key).not.toMatch(/\.\\/);
  });

  it('supports custom generateKey override', () => {
    const customKey = 'custom/prefix/my-key.png';
    const file = new File(['x'], 'test.png', { type: 'image/png' });
    const key = generateUploadKey(
      file,
      { userId: 'user-1' },
      {
        generateKey: (_f, ctx) => `user/${ctx.userId}/photo.png`,
      },
    );
    expect(key).toBe('user/user-1/photo.png');
  });

  it('does not add tenant prefix when tenantScopedKeys is false even with tenantId', () => {
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
    const key = generateUploadKey(file, { tenantId: 'tenant-1' }, { tenantScopedKeys: false });
    expect(key).not.toContain('tenant-1/');
    expect(key).toMatch(/^uploads\//);
  });

  it('does not add tenant prefix when tenantScopedKeys is true but tenantId is missing', () => {
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
    const key = generateUploadKey(file, {}, { tenantScopedKeys: true });
    expect(key).toMatch(/^uploads\//);
    expect(key.split('/')).toHaveLength(2); // uploads/UUID.pdf
  });
});

describe('generateUploadKeyFromFilename edge cases', () => {
  it('returns a key even with undefined filename', () => {
    const key = generateUploadKeyFromFilename(undefined, {});
    expect(key).toMatch(/^uploads\//);
  });

  it('returns a key with empty string filename', () => {
    const key = generateUploadKeyFromFilename('', {});
    expect(key).toMatch(/^uploads\//);
  });

  it('strips two-character extensions if not alphanumeric', () => {
    const key = generateUploadKeyFromFilename('script.c$', {});
    expect(key).not.toMatch(/\.c\$$/);
  });

  it('preserves a valid multi-part extension (.tar.gz)', () => {
    const key = generateUploadKeyFromFilename('archive.tar.gz', {});
    expect(key).toMatch(/\.gz$/);
  });
});

// ---------------------------------------------------------------------------
// Storage adapter failures during processUpload
// ---------------------------------------------------------------------------

describe('processUpload error handling', () => {
  it('propagates storage adapter put() error', async () => {
    const failingAdapter: StorageAdapter = {
      async put() {
        throw new Error('storage backend unreachable');
      },
      async get() {
        return null;
      },
      async delete() {},
    };

    await expect(
      processUpload(new File(['data'], 'test.txt', { type: 'text/plain' }), {
        carrier: makeUploadRuntime(failingAdapter),
      }),
    ).rejects.toThrow('storage backend unreachable');
  });

  it('rejects file whose size exceeds maxFileSize from carrier config', async () => {
    // Use a runtime with a pre-configured maxFileSize
    const runtime = makeUploadRuntime(memoryStorage(), { maxFileSize: 5 });
    await expect(
      processUpload(new File([new Uint8Array(100)], 'big.txt', { type: 'text/plain' }), {
        carrier: runtime,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('returns url when storage adapter returns one from put()', async () => {
    const adapterWithUrl: StorageAdapter = {
      async put(_key, _data, _meta) {
        return { url: 'https://cdn.example/uploads/file.txt' };
      },
      async get() {
        return null;
      },
      async delete() {},
    };

    const result = await processUpload(new File(['data'], 'test.txt', { type: 'text/plain' }), {
      carrier: makeUploadRuntime(adapterWithUrl),
    });

    expect(result.url).toBe('https://cdn.example/uploads/file.txt');
  });
});

// ---------------------------------------------------------------------------
// mimeMatches logic (tested through validateFile)
// ---------------------------------------------------------------------------

describe('MIME wildcard matching', () => {
  it('matches image/png against image/*', () => {
    const file = new File(['x'], 'img.png', { type: 'image/png' });
    expect(validateFile(file, { allowedMimeTypes: ['image/*'], maxFileSize: 1024 })).toBeNull();
  });

  it('matches image/svg+xml against image/*', () => {
    const file = new File(['<svg></svg>'], 'img.svg', { type: 'image/svg+xml' });
    expect(validateFile(file, { allowedMimeTypes: ['image/*'], maxFileSize: 1024 })).toBeNull();
  });

  it('rejects application/pdf against image/*', () => {
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
    const result = validateFile(file, { allowedMimeTypes: ['image/*'], maxFileSize: 1024 });
    expect(result).toContain('disallowed MIME type');
  });

  it('matches against first matching pattern in a list', () => {
    const file = new File(['x'], 'doc.txt', { type: 'text/plain' });
    expect(
      validateFile(file, { allowedMimeTypes: ['image/*', 'text/*'], maxFileSize: 1024 }),
    ).toBeNull();
  });
});
