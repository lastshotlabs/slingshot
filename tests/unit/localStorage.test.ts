import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { localStorage } from '../../src/framework/adapters/localStorage';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `slingshot-test-${crypto.randomUUID()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('localStorage', () => {
  it('put writes file, get reads it back', async () => {
    const adapter = localStorage({ directory: testDir });
    const content = 'file contents';
    const buf = Buffer.from(content);
    await adapter.put('hello.txt', buf, { mimeType: 'text/plain', size: buf.length });

    const result = await adapter.get('hello.txt');
    expect(result).not.toBeNull();
    // Read the stream
    const reader = result!.stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(content);
  });

  it('get non-existent key returns null', async () => {
    const adapter = localStorage({ directory: testDir });
    const result = await adapter.get('does-not-exist.txt');
    expect(result).toBeNull();
  });

  it('delete removes file, subsequent get returns null', async () => {
    const adapter = localStorage({ directory: testDir });
    const buf = Buffer.from('to delete');
    await adapter.put('deleteme.txt', buf, { mimeType: 'text/plain', size: buf.length });
    expect(await adapter.get('deleteme.txt')).not.toBeNull();
    await adapter.delete('deleteme.txt');
    expect(await adapter.get('deleteme.txt')).toBeNull();
  });

  it('put creates nested directories', async () => {
    const adapter = localStorage({ directory: testDir });
    const buf = Buffer.from('nested');
    await adapter.put('a/b/c/nested.txt', buf, { mimeType: 'text/plain', size: buf.length });
    const result = await adapter.get('a/b/c/nested.txt');
    expect(result).not.toBeNull();
  });

  it('returns url when baseUrl is configured', async () => {
    const adapter = localStorage({ directory: testDir, baseUrl: 'https://cdn.example.com' });
    const buf = Buffer.from('x');
    const { url } = await adapter.put('img/photo.jpg', buf, { mimeType: 'image/jpeg', size: 1 });
    expect(url).toBe('https://cdn.example.com/img/photo.jpg');
  });

  it('returns no url when baseUrl is not configured', async () => {
    const adapter = localStorage({ directory: testDir });
    const buf = Buffer.from('x');
    const result = await adapter.put('file.txt', buf, { mimeType: 'text/plain', size: 1 });
    expect(result.url).toBeUndefined();
  });

  it('meta.bucket is ignored — no error thrown', async () => {
    const adapter = localStorage({ directory: testDir });
    const buf = Buffer.from('x');
    await expect(
      adapter.put('file.txt', buf, { mimeType: 'text/plain', size: 1, bucket: 'some-bucket' }),
    ).resolves.toBeDefined();
  });

  it('put accepts a Blob', async () => {
    const adapter = localStorage({ directory: testDir });
    const blob = new Blob(['blob contents'], { type: 'text/plain' });
    await adapter.put('blob.txt', blob, { mimeType: 'text/plain', size: blob.size });
    const result = await adapter.get('blob.txt');
    expect(result).not.toBeNull();
    const reader = result!.stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('blob contents');
  });

  it('put accepts a ReadableStream', async () => {
    const adapter = localStorage({ directory: testDir });
    const content = 'stream contents';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },
    });
    await adapter.put('stream.txt', stream, { mimeType: 'text/plain', size: content.length });
    const result = await adapter.get('stream.txt');
    expect(result).not.toBeNull();
    const reader = result!.stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(content);
  });
});

describe('localStorage — defaultFs paths (lines 14-16)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `slingshot-dflt-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaultFs.readFile returns Uint8Array when file exists (line 14)', async () => {
    // Use real defaultFs (no fs override) so defaultFs.readFile line 14 runs
    const adapter = localStorage({ directory: dir });
    const content = Buffer.from('default-fs-content');
    await adapter.put('dflt.txt', content, { mimeType: 'text/plain', size: content.length });

    const result = await adapter.get('dflt.txt');
    expect(result).not.toBeNull();
    expect(result!.size).toBe(content.length);

    const reader = result!.stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('default-fs-content');
  });

  it('defaultFs.readFile returns null for missing file', async () => {
    const adapter = localStorage({ directory: dir });
    const result = await adapter.get('missing.txt');
    expect(result).toBeNull();
  });

  it('defaultFs.write writes data correctly', async () => {
    // Direct write+read cycle using only defaultFs
    const adapter = localStorage({ directory: dir });
    await adapter.put('write-test.txt', new Uint8Array([72, 73]), {
      mimeType: 'text/plain',
      size: 2,
    });
    const f = Bun.file(join(dir, 'write-test.txt'));
    expect(await f.exists()).toBe(true);
    expect(await f.text()).toBe('HI');
  });

  it('delete via defaultFs removes the file', async () => {
    const adapter = localStorage({ directory: dir });
    await adapter.put('del.txt', Buffer.from('x'), { mimeType: 'text/plain', size: 1 });
    await adapter.delete('del.txt');
    const result = await adapter.get('del.txt');
    expect(result).toBeNull();
  });
});

describe('localStorage path traversal protection', () => {
  let dir: string;
  let adapter: ReturnType<typeof localStorage>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slingshot-test-'));
    adapter = localStorage({ directory: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const cases = [
    ['../escape.txt', 'parent directory traversal'],
    ['..\\escape.txt', 'backslash traversal'],
    ['/etc/passwd', 'absolute path'],
    ['C:\\windows\\file', 'Windows drive letter'],
    ['//server/share/file', 'UNC path'],
    ['a/b/../../../escape.txt', 'nested traversal resolves outside root'],
    ['', 'empty key'],
    ['  ', 'whitespace-only key'],
    ['.', 'dot resolves to root'],
    ['./', 'dot-slash resolves to root'],
    ['subdir/..', 'resolves to root via subdir'],
  ];

  for (const [key, label] of cases) {
    it(`rejects ${label}: ${JSON.stringify(key)}`, async () => {
      await expect(adapter.put(key, new Blob(['x']), {} as any)).rejects.toThrow();
      await expect(adapter.get(key)).rejects.toThrow();
      await expect(adapter.delete(key)).rejects.toThrow();
    });
  }

  it('allows a nested in-root key', async () => {
    const result = await adapter.put('subdir/valid.txt', new Blob(['hello']), {} as any);
    expect(result).toBeDefined();
    const got = await adapter.get('subdir/valid.txt');
    expect(got).not.toBeNull();
    await adapter.delete('subdir/valid.txt');
  });
});
