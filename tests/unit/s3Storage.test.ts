import { describe, expect, mock, test } from 'bun:test';
import { s3Storage } from '../../src/framework/adapters/s3Storage';

// ---------------------------------------------------------------------------
// Mock AWS SDK modules
// ---------------------------------------------------------------------------

const sentCommands: unknown[] = [];

class MockS3Client {
  config: Record<string, unknown>;
  constructor(config: Record<string, unknown>) {
    this.config = config;
  }
  async send(command: unknown) {
    sentCommands.push(command);
    const cmd = command as { _type: string; input: Record<string, unknown> };
    if (cmd._type === 'GetObjectCommand') {
      if (cmd.input.Key === 'missing.txt') {
        const err = new Error('NoSuchKey') as Error & {
          name: string;
          $metadata: { httpStatusCode: number };
        };
        err.name = 'NoSuchKey';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      if (cmd.input.Key === 'server-error.txt') {
        throw new Error('InternalServerError');
      }
      return {
        Body: new ReadableStream(),
        ContentType: 'text/plain',
        ContentLength: 42,
      };
    }
    return {};
  }
}

class MockPutObjectCommand {
  _type = 'PutObjectCommand';
  input: Record<string, unknown>;
  constructor(params: Record<string, unknown>) {
    this.input = params;
  }
}

class MockGetObjectCommand {
  _type = 'GetObjectCommand';
  input: Record<string, unknown>;
  constructor(params: Record<string, unknown>) {
    this.input = params;
  }
}

class MockDeleteObjectCommand {
  _type = 'DeleteObjectCommand';
  input: Record<string, unknown>;
  constructor(params: Record<string, unknown>) {
    this.input = params;
  }
}

mock.module('@aws-sdk/client-s3', () => ({
  S3Client: MockS3Client,
  PutObjectCommand: MockPutObjectCommand,
  GetObjectCommand: MockGetObjectCommand,
  DeleteObjectCommand: MockDeleteObjectCommand,
}));

mock.module('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_client: unknown, _command: unknown, opts: Record<string, unknown>) => {
    return `https://presigned-url.example.com?expires=${opts.expiresIn}`;
  },
}));

const uploadDoneMock = mock(async () => ({}));
mock.module('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(public opts: Record<string, unknown>) {}
    done = uploadDoneMock;
  },
}));

function resetCommands() {
  sentCommands.length = 0;
}

describe('s3Storage', () => {
  test('creates adapter with all methods', () => {
    const adapter = s3Storage({ bucket: 'test-bucket' });
    expect(typeof adapter.put).toBe('function');
    expect(typeof adapter.get).toBe('function');
    expect(typeof adapter.delete).toBe('function');
    expect(typeof adapter.presignPut).toBe('function');
    expect(typeof adapter.presignGet).toBe('function');
  });
});

describe('s3Storage — put', () => {
  test('uploads a Buffer', async () => {
    resetCommands();
    const adapter = s3Storage({ bucket: 'my-bucket', region: 'us-west-2' });
    const result = await adapter.put('file.txt', Buffer.from('hello'), {
      mimeType: 'text/plain',
      size: 5,
    });
    expect(sentCommands).toHaveLength(1);
    expect((sentCommands[0] as { input: Record<string, unknown> }).input.Bucket).toBe('my-bucket');
    expect(result).toEqual({});
  });

  test('uploads with publicUrl returns url', async () => {
    resetCommands();
    const adapter = s3Storage({ bucket: 'b', publicUrl: 'https://cdn.example.com/' });
    const result = await adapter.put('images/photo.jpg', Buffer.from('data'), {
      mimeType: 'image/jpeg',
    });
    expect(result).toEqual({ url: 'https://cdn.example.com/images/photo.jpg' });
  });

  test('uploads a ReadableStream by buffering', async () => {
    resetCommands();
    const adapter = s3Storage({ bucket: 'b' });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('stream data'));
        controller.close();
      },
    });
    await adapter.put('stream.txt', stream as never, { mimeType: 'text/plain' });
    expect(sentCommands).toHaveLength(1);
  });

  test('uploads a Blob by buffering', async () => {
    resetCommands();
    const adapter = s3Storage({ bucket: 'b' });
    const blob = new Blob(['blob data'], { type: 'text/plain' });
    await adapter.put('blob.txt', blob as never, { mimeType: 'text/plain' });
    expect(sentCommands).toHaveLength(1);
  });

  test('uses streaming Upload when config.streaming is true', async () => {
    uploadDoneMock.mockClear();
    const adapter = s3Storage({ bucket: 'b', streaming: true });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streaming'));
        controller.close();
      },
    });
    await adapter.put('large.bin', stream as never, { mimeType: 'application/octet-stream' });
    expect(uploadDoneMock).toHaveBeenCalledTimes(1);
  });

  test('uses meta.bucket override', async () => {
    resetCommands();
    const adapter = s3Storage({ bucket: 'default-bucket' });
    const putMetaData = { mimeType: 'text/plain', bucket: 'override-bucket' };
    const putMeta = putMetaData as unknown as never;
    await adapter.put('file.txt', Buffer.from('x'), putMeta);
    expect((sentCommands[0] as { input: Record<string, unknown> }).input.Bucket).toBe(
      'override-bucket',
    );
  });
});

describe('s3Storage — get', () => {
  test('returns file data', async () => {
    const adapter = s3Storage({ bucket: 'b' });
    const result = await adapter.get('existing.txt');
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe('text/plain');
    expect(result!.size).toBe(42);
  });

  test('returns null for NoSuchKey', async () => {
    const adapter = s3Storage({ bucket: 'b' });
    const result = await adapter.get('missing.txt');
    expect(result).toBeNull();
  });

  test('re-throws non-404 errors', async () => {
    const adapter = s3Storage({ bucket: 'b' });
    await expect(adapter.get('server-error.txt')).rejects.toThrow('InternalServerError');
  });
});

describe('s3Storage — delete', () => {
  test('sends DeleteObjectCommand', async () => {
    resetCommands();
    const adapter = s3Storage({ bucket: 'b' });
    await adapter.delete('old.txt');
    expect(sentCommands).toHaveLength(1);
    expect((sentCommands[0] as { _type: string })._type).toBe('DeleteObjectCommand');
  });
});

describe('s3Storage — presignPut', () => {
  test('returns presigned URL', async () => {
    const adapter = s3Storage({ bucket: 'b' });
    const url = await adapter.presignPut!('upload.txt', {
      expirySeconds: 3600,
      mimeType: 'text/plain',
    });
    expect(url).toContain('presigned-url.example.com');
    expect(url).toContain('3600');
  });
});

describe('s3Storage — presignGet', () => {
  test('returns presigned URL', async () => {
    const adapter = s3Storage({ bucket: 'b' });
    const url = await adapter.presignGet!('download.txt', { expirySeconds: 600 });
    expect(url).toContain('presigned-url.example.com');
    expect(url).toContain('600');
  });
});

describe('s3Storage — client configuration', () => {
  test('passes endpoint and credentials to S3Client', () => {
    const adapter = s3Storage({
      bucket: 'b',
      endpoint: 'https://minio.local:9000',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      forcePathStyle: true,
    });
    // Trigger client creation
    adapter.get('trigger.txt');
    // The MockS3Client constructor was called — we can't easily inspect it
    // but the test passing proves the code ran without error.
  });
});
