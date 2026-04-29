import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { localStorage } from '../../src/adapters/local';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'local-adapter-test-'));
}

async function streamToText(stream: ReadableStream): Promise<string> {
  return new Response(stream).text();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('localStorage adapter', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 1. Store a file and verify it exists on disk ──────────────────────

  it('stores a file and verifies it exists on disk', async () => {
    tempDir = makeTempDir();
    const adapter = localStorage({ directory: tempDir });

    await adapter.put('hello.txt', Buffer.from('hello world'), {
      mimeType: 'text/plain',
      size: 11,
    });

    const filePath = join(tempDir, 'hello.txt');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('hello world');
  });

  // ── 2. Retrieve a stored file ────────────────────────────────────────

  it('retrieves a stored file', async () => {
    tempDir = makeTempDir();
    const adapter = localStorage({ directory: tempDir });

    await adapter.put('data.bin', Buffer.from('file content'), {
      mimeType: 'application/octet-stream',
      size: 12,
    });

    const result = await adapter.get('data.bin');
    expect(result).not.toBeNull();
    expect(result!.size).toBe(12);
    expect(await streamToText(result!.stream)).toBe('file content');
  });

  // ── 3. Delete a stored file ──────────────────────────────────────────

  it('deletes a stored file', async () => {
    tempDir = makeTempDir();
    const adapter = localStorage({ directory: tempDir });

    await adapter.put('delete-me.txt', Buffer.from('bye bye'), {
      mimeType: 'text/plain',
      size: 7,
    });

    const filePath = join(tempDir, 'delete-me.txt');
    expect(existsSync(filePath)).toBe(true);

    await adapter.delete('delete-me.txt');

    expect(existsSync(filePath)).toBe(false);
    await expect(adapter.get('delete-me.txt')).resolves.toBeNull();
  });

  // ── 4. Store with tenant-scoped key ──────────────────────────────────

  it('stores with a tenant-scoped key', async () => {
    tempDir = makeTempDir();
    const adapter = localStorage({ directory: tempDir });

    await adapter.put('tenant-abc/images/logo.png', new Blob(['png-data']), {
      mimeType: 'image/png',
      size: 8,
    });

    // Verify on disk under the nested tenant path
    const filePath = join(tempDir, 'tenant-abc', 'images', 'logo.png');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('png-data');

    // Retrieve through the adapter
    const result = await adapter.get('tenant-abc/images/logo.png');
    expect(result).not.toBeNull();
    expect(await streamToText(result!.stream)).toBe('png-data');
  });

  // ── 5. Error handling for missing files on retrieval ─────────────────

  it('returns null when retrieving a non-existent file', async () => {
    tempDir = makeTempDir();
    const adapter = localStorage({ directory: tempDir });

    const result = await adapter.get('does-not-exist.txt');
    expect(result).toBeNull();
  });

  // ── 6. Error handling for deleting non-existent files ────────────────

  it('does not throw when deleting a non-existent file', async () => {
    tempDir = makeTempDir();
    const adapter = localStorage({ directory: tempDir });

    await expect(adapter.delete('never-existed.txt')).resolves.toBeUndefined();
  });

  // ── 7. Presigned URL generation ──────────────────────────────────────

  it('does not support presigned URL generation', async () => {
    tempDir = makeTempDir();
    const adapter = localStorage({ directory: tempDir });

    expect(adapter.presignPut).toBeUndefined();
    expect(adapter.presignGet).toBeUndefined();
  });

  // ── 8. Large file upload (moderate buffer to keep tests fast) ────────

  it('handles a moderately large file upload', async () => {
    tempDir = makeTempDir();
    const adapter = localStorage({ directory: tempDir });

    // 100 KB buffer — large enough to exercise the code path, tiny enough
    // to run in a fraction of a second.
    const size = 100_000;
    const largeContent = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      largeContent[i] = i & 0xff;
    }

    await adapter.put('large.bin', Buffer.from(largeContent), {
      mimeType: 'application/octet-stream',
      size,
    });

    const result = await adapter.get('large.bin');
    expect(result).not.toBeNull();
    expect(result!.size).toBe(size);

    const retrieved = new Uint8Array(await new Response(result!.stream).arrayBuffer());
    expect(retrieved).toEqual(largeContent);
  });

  // ── 9. Concurrent operations (store two files simultaneously) ────────

  it('handles concurrent put operations', async () => {
    tempDir = makeTempDir();
    const adapter = localStorage({ directory: tempDir });

    await Promise.all([
      adapter.put('file-a.txt', Buffer.from('content a'), {
        mimeType: 'text/plain',
        size: 9,
      }),
      adapter.put('file-b.txt', Buffer.from('content b'), {
        mimeType: 'text/plain',
        size: 9,
      }),
    ]);

    // Both files should exist on disk
    expect(existsSync(join(tempDir, 'file-a.txt'))).toBe(true);
    expect(existsSync(join(tempDir, 'file-b.txt'))).toBe(true);

    // Disk contents should match
    expect(readFileSync(join(tempDir, 'file-a.txt'), 'utf8')).toBe('content a');
    expect(readFileSync(join(tempDir, 'file-b.txt'), 'utf8')).toBe('content b');

    // Concurrent retrieval should also work
    const [resultA, resultB] = await Promise.all([
      adapter.get('file-a.txt'),
      adapter.get('file-b.txt'),
    ]);

    expect(await streamToText(resultA!.stream)).toBe('content a');
    expect(await streamToText(resultB!.stream)).toBe('content b');
  });
});
