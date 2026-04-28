import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { S3CircuitOpenError, s3Storage } from '../../packages/slingshot-assets/src/adapters/s3';

// Requires a running LocalStack instance.
// Run with: bun test tests/docker/assets-s3-storage.test.ts
// Default endpoint: http://localhost:4566
// Override: TEST_S3_ENDPOINT=<url> bun test tests/docker/assets-s3-storage.test.ts

// Set dummy AWS credentials for LocalStack
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'test';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'test';

const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://localhost:4566';
const BUCKET = 'slingshot-assets-storage-test';

// LocalStack-connected client for cleanup + assertions
let s3: S3Client;

async function emptyAndDropBucket(): Promise<void> {
  try {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    if (list.Contents) {
      for (const obj of list.Contents) {
        if (obj.Key) {
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
        }
      }
    }
    await s3.send(new DeleteBucketCommand({ Bucket: BUCKET }));
  } catch {
    // Bucket may not exist — that's fine
  }
}

async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch {
    // Bucket already exists — that's fine
  }
}

beforeAll(() => {
  s3 = new S3Client({
    region: 'us-east-1',
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
});

beforeEach(async () => {
  await emptyAndDropBucket();
  await ensureBucket();
});

afterAll(async () => {
  await emptyAndDropBucket();
  s3.destroy();
});

function makeAdapter(overrides: Partial<Parameters<typeof s3Storage>[0]> = {}) {
  return s3Storage({
    region: 'us-east-1',
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    ...overrides,
    bucket: overrides.bucket ?? BUCKET,
  });
}

describe('s3Storage (localstack)', () => {
  // -------------------------------------------------------------------------
  // put / get / delete round-trip
  // -------------------------------------------------------------------------

  it('put writes an object that can be read back via get', async () => {
    const adapter = makeAdapter();
    const payload = Buffer.from('hello slingshot');

    await adapter.put('docs/hello.txt', payload, {
      mimeType: 'text/plain',
      size: payload.byteLength,
    });

    const result = await adapter.get('docs/hello.txt');
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('text/plain');
    expect(result?.size).toBe(payload.byteLength);

    const text = await new Response(result!.stream as ReadableStream).text();
    expect(text).toBe('hello slingshot');
  });

  it('get returns null for missing keys (NoSuchKey)', async () => {
    const adapter = makeAdapter();
    const result = await adapter.get('does-not-exist.bin');
    expect(result).toBeNull();
  });

  it('delete removes an existing object', async () => {
    const adapter = makeAdapter();
    const payload = Buffer.from([1, 2, 3, 4]);

    await adapter.put('blobs/a.bin', payload, {
      mimeType: 'application/octet-stream',
      size: payload.byteLength,
    });
    await adapter.delete('blobs/a.bin');

    await expect(
      s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'blobs/a.bin' })),
    ).rejects.toThrow();
  });

  it('publicUrl is reflected in put() result when configured', async () => {
    const adapter = makeAdapter({
      bucket: BUCKET,
      region: 'us-east-1',
      endpoint: ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      publicUrl: 'https://cdn.example.com',
    });
    const payload = Buffer.from('public');
    const result = await adapter.put('public/a.txt', payload, {
      mimeType: 'text/plain',
      size: payload.byteLength,
    });
    expect(result.url).toBe('https://cdn.example.com/public/a.txt');
  });

  // -------------------------------------------------------------------------
  // presignGet
  // -------------------------------------------------------------------------

  it('presignGet returns a fetchable URL for an existing object', async () => {
    const adapter = makeAdapter();
    const payload = Buffer.from('presigned-body');

    await adapter.put('signed/a.txt', payload, {
      mimeType: 'text/plain',
      size: payload.byteLength,
    });

    if (!adapter.presignGet) throw new Error('presignGet should be defined on s3Storage adapter');
    const url = await adapter.presignGet('signed/a.txt', { expirySeconds: 60 });
    expect(typeof url).toBe('string');
    expect(url).toContain(BUCKET);
    expect(url).toContain('signed/a.txt');

    // Fetch the URL — LocalStack honors presigned URLs
    const res = await fetch(url);
    expect(res.ok).toBe(true);
    const body = await res.text();
    expect(body).toBe('presigned-body');
  });

  // -------------------------------------------------------------------------
  // circuit breaker — exercised end-to-end against an unreachable endpoint
  // -------------------------------------------------------------------------

  it('opens the circuit breaker after threshold failures and short-circuits subsequent calls', async () => {
    // Point at an unreachable endpoint so every operation fails after retries.
    const adapter = s3Storage({
      bucket: BUCKET,
      region: 'us-east-1',
      // Reserved port that nothing should be listening on.
      endpoint: 'http://127.0.0.1:1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      retryAttempts: 1, // skip retries to keep the test fast
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 60_000,
    });

    expect(adapter.getCircuitBreakerHealth().state).toBe('closed');

    // Drive the breaker to open: each failed delete counts as one breaker failure.
    for (let i = 0; i < 3; i++) {
      await expect(adapter.delete(`unreachable-${i}.bin`)).rejects.toThrow();
    }

    const health = adapter.getCircuitBreakerHealth();
    expect(health.state).toBe('open');
    expect(health.consecutiveFailures).toBeGreaterThanOrEqual(3);

    // Next call must short-circuit with S3CircuitOpenError — without ever
    // touching the (unreachable) endpoint.
    let caught: unknown;
    try {
      await adapter.delete('blocked.bin');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(S3CircuitOpenError);
    expect((caught as S3CircuitOpenError).code).toBe('S3_CIRCUIT_OPEN');
  });
});
