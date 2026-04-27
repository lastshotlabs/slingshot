import { Readable } from 'node:stream';
import { afterEach, describe, expect, mock, test } from 'bun:test';

mock.module('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(_opts: Record<string, unknown>) {}
    async send(
      command: unknown,
    ): Promise<{ Body?: unknown; ContentType?: string; ContentLength?: number }> {
      const ctorName = (command as { constructor?: { name?: string } }).constructor?.name;
      if (ctorName === 'GetObjectCommand') {
        return {
          Body: Readable.from(['hello world']),
          ContentType: 'text/plain',
          ContentLength: 11,
        };
      }
      return {};
    }
  }

  class PutObjectCommand {
    constructor(_params: Record<string, unknown>) {}
  }
  class GetObjectCommand {
    constructor(_params: Record<string, unknown>) {}
  }
  class DeleteObjectCommand {
    constructor(_params: Record<string, unknown>) {}
  }

  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

const { s3Storage } = await import('../../src/adapters/s3');

afterEach(() => {
  mock.restore();
});

describe('s3Storage', () => {
  test('normalizes Node stream bodies to web ReadableStream on get()', async () => {
    const storage = s3Storage({ bucket: 'assets-bucket' });
    const result = await storage.get('files/example.txt');

    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('text/plain');
    expect(result?.size).toBe(11);

    const text = await new Response(result!.stream).text();
    expect(text).toBe('hello world');
  });
});
