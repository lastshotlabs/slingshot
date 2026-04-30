import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import { resolveStorageAdapter } from '../../src/adapters';
import { localStorage } from '../../src/adapters/local';
import { memoryStorage } from '../../src/adapters/memory';

const tempDirs: string[] = [];
const encoder = new TextEncoder();

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slingshot-assets-storage-'));
  tempDirs.push(dir);
  return dir;
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function streamToText(stream: ReadableStream): Promise<string> {
  return new Response(stream).text();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('localStorage', () => {
  it('writes blobs and streams under the configured root and returns public URLs', async () => {
    const dir = await makeTempDir();
    const adapter = localStorage({ directory: dir, baseUrl: 'https://cdn.example/assets/' });

    await expect(
      adapter.put('nested/blob.txt', new Blob(['blob-body']), {
        mimeType: 'text/plain',
        size: 9,
      }),
    ).resolves.toEqual({ url: 'https://cdn.example/assets/nested/blob.txt' });
    await adapter.put('nested/stream.txt', streamFromText('stream-body'), {
      mimeType: 'text/plain',
      size: 11,
    });

    expect(await readFile(join(dir, 'nested/blob.txt'), 'utf8')).toBe('blob-body');
    const stored = await adapter.get('nested/stream.txt');
    expect(stored?.size).toBe(11);
    expect(await streamToText(stored!.stream)).toBe('stream-body');

    await adapter.delete('nested/stream.txt');
    await expect(adapter.get('nested/stream.txt')).resolves.toBeNull();
    await expect(adapter.delete('nested/missing.txt')).resolves.toBeUndefined();
  });

  it('rejects empty, absolute, drive-letter, UNC, traversal, and NUL-byte storage keys', async () => {
    const dir = await makeTempDir();
    const adapter = localStorage({ directory: dir });
    const invalidKeys = [
      '',
      '   ',
      '/absolute.txt',
      'C:/windows.txt',
      '//server/share',
      '../x',
      '../../etc/passwd',
      'foo/../../bar',
      // NUL byte — historically a sneaky way to truncate paths in some Node APIs.
      'foo\0bar',
      '\0',
    ];

    for (const key of invalidKeys) {
      await expect(
        adapter.put(key, Buffer.from('x'), { mimeType: 'text/plain', size: 1 }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(adapter.get(key)).rejects.toMatchObject({ status: 400 });
      await expect(adapter.delete(key)).rejects.toMatchObject({ status: 400 });
    }
  });

  it('uses an injected RuntimeFs when provided', async () => {
    const dir = await makeTempDir();
    const writes = new Map<string, Uint8Array>();
    const fs = {
      async write(path: string, data: string | Uint8Array) {
        writes.set(path, typeof data === 'string' ? encoder.encode(data) : data);
      },
      async readFile(path: string) {
        return writes.get(path) ?? null;
      },
      async exists(path: string) {
        return writes.has(path);
      },
    };
    const adapter = localStorage({ directory: dir, fs });

    await adapter.put('file.bin', Buffer.from('virtual'), {
      mimeType: 'application/octet-stream',
      size: 7,
    });

    const stored = await adapter.get('file.bin');
    expect(await streamToText(stored!.stream)).toBe('virtual');
    expect(await fs.exists(join(dir, 'file.bin'))).toBe(true);
  });
});

describe('memoryStorage', () => {
  it('stores buffers, blobs, and streams with metadata and deletes by key', async () => {
    const adapter = memoryStorage();

    await adapter.put('buffer.txt', Buffer.from('buffer-body'), {
      mimeType: 'text/plain',
      size: 11,
    });
    await adapter.put('blob.txt', new Blob(['blob-body']), { mimeType: 'text/plain', size: 9 });
    await adapter.put('stream.txt', streamFromText('stream-body'), {
      mimeType: 'text/plain',
      size: 11,
    });

    const buffer = await adapter.get('buffer.txt');
    const blob = await adapter.get('blob.txt');
    const stream = await adapter.get('stream.txt');

    expect(buffer?.mimeType).toBe('text/plain');
    expect(buffer?.size).toBe(11);
    expect(await streamToText(buffer!.stream)).toBe('buffer-body');
    expect(await streamToText(blob!.stream)).toBe('blob-body');
    expect(await streamToText(stream!.stream)).toBe('stream-body');

    await adapter.delete('buffer.txt');
    await expect(adapter.get('buffer.txt')).resolves.toBeNull();
  });
});

describe('resolveStorageAdapter', () => {
  it('passes through runtime adapter instances and resolves memory/local refs', async () => {
    const custom: StorageAdapter = {
      async put() {
        return {};
      },
      async get() {
        return null;
      },
      async delete() {},
    };
    const dir = await makeTempDir();

    expect(resolveStorageAdapter(custom)).toBe(custom);
    expect(await resolveStorageAdapter({ adapter: 'memory' }).get('missing')).toBeNull();
    await expect(
      resolveStorageAdapter({ adapter: 'local', config: { directory: dir } }).put(
        'ok.txt',
        Buffer.from('ok'),
        { mimeType: 'text/plain', size: 2 },
      ),
    ).resolves.toEqual({});
  });

  it('validates built-in adapter configuration before construction', () => {
    expect(() => resolveStorageAdapter({ adapter: 'local', config: {} })).toThrow(
      'local storage config invalid',
    );
    expect(() => resolveStorageAdapter({ adapter: 's3', config: {} })).toThrow(
      's3 storage config invalid',
    );
    expect(() =>
      resolveStorageAdapter(
        {
          adapter: 's3',
          config: {
            bucket: 'assets',
            region: 'us-east-1',
            endpoint: 'http://localhost:9000',
            publicUrl: 'https://cdn.example',
            forcePathStyle: true,
            streaming: true,
            credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
          },
        },
        {
          storageRetryAttempts: 2,
          storageCircuitBreakerThreshold: 3,
          storageCircuitBreakerCooldownMs: 100,
        },
      ),
    ).not.toThrow();
  });
});
