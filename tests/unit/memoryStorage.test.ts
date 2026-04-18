import { beforeEach, describe, expect, it } from 'bun:test';
import { memoryStorage } from '../../src/framework/adapters/memoryStorage';

beforeEach(() => {
  // New adapter instance per test; no process-global store to reset.
});

describe('memoryStorage', () => {
  it('put and get round trip', async () => {
    const adapter = memoryStorage();
    const data = Buffer.from('hello world');
    await adapter.put('test/file.txt', data, { mimeType: 'text/plain', size: data.length });
    const result = await adapter.get('test/file.txt');
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe('text/plain');
    expect(result!.size).toBe(data.length);
    // Read the stream
    const reader = result!.stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const content = Buffer.concat(chunks).toString('utf8');
    expect(content).toBe('hello world');
  });

  it('get non-existent key returns null', async () => {
    const adapter = memoryStorage();
    const result = await adapter.get('nonexistent/key.txt');
    expect(result).toBeNull();
  });

  it('delete removes entry', async () => {
    const adapter = memoryStorage();
    const data = Buffer.from('data');
    await adapter.put('to-delete.txt', data, { mimeType: 'text/plain', size: data.length });
    expect(await adapter.get('to-delete.txt')).not.toBeNull();
    await adapter.delete('to-delete.txt');
    expect(await adapter.get('to-delete.txt')).toBeNull();
  });

  it('adapter instances are isolated', async () => {
    const adapter = memoryStorage();
    const data = Buffer.from('x');
    await adapter.put('a.txt', data, { mimeType: 'text/plain', size: 1 });
    const otherAdapter = memoryStorage();
    expect(await otherAdapter.get('a.txt')).toBeNull();
  });

  it('put with Blob data', async () => {
    const adapter = memoryStorage();
    const blob = new Blob(['blob content'], { type: 'text/plain' });
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
    expect(Buffer.concat(chunks).toString('utf8')).toBe('blob content');
  });

  it('put with ReadableStream data', async () => {
    const adapter = memoryStorage();
    const content = 'stream content';
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

  it('meta.bucket is ignored — no error thrown', async () => {
    const adapter = memoryStorage();
    const data = Buffer.from('x');
    // Should not throw even though bucket is provided
    await expect(
      adapter.put('file.txt', data, { mimeType: 'text/plain', size: 1, bucket: 'some-bucket' }),
    ).resolves.toBeDefined();
  });

  it('does not implement presignPut or presignGet', () => {
    const adapter = memoryStorage();
    expect(adapter.presignPut).toBeUndefined();
    expect(adapter.presignGet).toBeUndefined();
  });
});
