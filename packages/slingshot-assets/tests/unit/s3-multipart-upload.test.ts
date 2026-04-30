import { describe, expect, test } from 'bun:test';
import { type S3StorageAdapter, s3Storage } from '../../src/adapters/s3';

describe('s3Storage multipart upload support', () => {
  function createAdapter(): S3StorageAdapter {
    return s3Storage({
      bucket: 'test-bucket',
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
      },
    });
  }

  test('initiateMultipartUpload exists and is a function', () => {
    const adapter = createAdapter();
    expect(adapter.initiateMultipartUpload).toBeDefined();
    expect(typeof adapter.initiateMultipartUpload).toBe('function');
  });

  test('presignUploadPart exists and is a function', () => {
    const adapter = createAdapter();
    expect(adapter.presignUploadPart).toBeDefined();
    expect(typeof adapter.presignUploadPart).toBe('function');
  });

  test('completeMultipartUpload exists and is a function', () => {
    const adapter = createAdapter();
    expect(adapter.completeMultipartUpload).toBeDefined();
    expect(typeof adapter.completeMultipartUpload).toBe('function');
  });

  test('abortMultipartUpload exists and is a function', () => {
    const adapter = createAdapter();
    expect(adapter.abortMultipartUpload).toBeDefined();
    expect(typeof adapter.abortMultipartUpload).toBe('function');
  });
});
