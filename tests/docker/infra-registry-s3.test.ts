import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createS3Registry } from '../../packages/slingshot-infra/src/registry/s3Registry';

// Requires a running LocalStack instance.
// Run with: bun test tests/docker/infra-registry-s3.test.ts
// Default endpoint: http://localhost:4566
// Override: TEST_S3_ENDPOINT=<url> bun test tests/docker/infra-registry-s3.test.ts

// Set dummy AWS credentials for LocalStack
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'test';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'test';

const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://localhost:4566';
const BUCKET = 'slingshot-s3-registry-test';
const PREFIX = 'test-registry/';

/** Create a registry configured for LocalStack with path-style access. */
function makeRegistry(overrides?: { prefix?: string }) {
  return createS3Registry({
    bucket: BUCKET,
    prefix: overrides?.prefix ?? PREFIX,
    endpoint: ENDPOINT,
    forcePathStyle: true,
  });
}

// LocalStack-connected client for cleanup
let s3: S3Client;

async function emptyBucket() {
  try {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    if (list.Contents) {
      for (const obj of list.Contents) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
      }
    }
    await s3.send(new DeleteBucketCommand({ Bucket: BUCKET }));
  } catch {
    // Bucket may not exist — that's fine
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
  await emptyBucket();
});

afterAll(async () => {
  await emptyBucket();
  s3.destroy();
});

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

describe('createS3Registry (localstack)', () => {
  it('read returns null before initialize', async () => {
    const registry = makeRegistry();
    const doc = await registry.read();
    expect(doc).toBeNull();
  });

  it('initialize creates bucket and seeds empty document', async () => {
    const registry = makeRegistry();
    await registry.initialize();

    const doc = await registry.read();
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe(1);
    expect(doc!.services).toEqual({});
    expect(doc!.stacks).toEqual({});
    expect(doc!.resources).toEqual({});
  });

  it('initialize is idempotent', async () => {
    const registry = makeRegistry();
    await registry.initialize();
    await registry.initialize(); // should not throw or duplicate

    const doc = await registry.read();
    expect(doc).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // write + read round-trip
  // -----------------------------------------------------------------------

  it('write persists document and read returns it', async () => {
    const registry = makeRegistry();
    await registry.initialize();

    const doc = await registry.read();
    doc!.services = {
      api: {
        stack: 'main',
        repo: '',
        uses: [],
        stages: {
          dev: { imageTag: 'v1', deployedAt: new Date().toISOString(), status: 'deployed' },
        },
      },
    };
    await registry.write(doc!);

    const reloaded = await registry.read();
    expect(reloaded!.services.api).toBeDefined();
    expect(reloaded!.services.api.stages.dev.imageTag).toBe('v1');
  });

  it('write returns an etag', async () => {
    const registry = makeRegistry();
    await registry.initialize();

    const doc = await registry.read();
    const { etag } = await registry.write(doc!);
    expect(etag).toBeDefined();
    expect(typeof etag).toBe('string');
    expect(etag.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // optimistic concurrency (etag via IfMatch)
  // -----------------------------------------------------------------------

  it('write with valid etag succeeds', async () => {
    const registry = makeRegistry();
    await registry.initialize();

    const lock = await registry.lock();
    const doc = await registry.read();
    doc!.services = {
      worker: {
        stack: 'main',
        repo: '',
        uses: [],
        stages: {
          prod: { imageTag: 'v2', deployedAt: new Date().toISOString(), status: 'deployed' },
        },
      },
    };
    const { etag: newEtag } = await registry.write(doc!, lock.etag);
    await lock.release();
    expect(newEtag).toBeDefined();
  });

  // NOTE: LocalStack does not implement S3 IfMatch conditional writes.
  // This test validates ETag-based optimistic concurrency, which only works
  // against real AWS S3. Run against a real bucket to verify:
  //   TEST_S3_ENDPOINT= AWS_PROFILE=<profile> bun test tests/docker/infra-registry-s3.test.ts
  it.skip('write with stale etag throws (S3 PreconditionFailed)', async () => {
    const registry = makeRegistry();
    await registry.initialize();

    const lock = await registry.lock();
    const staleEtag = lock.etag;
    await lock.release();

    const doc = await registry.read();
    doc!.services = {
      changed: {
        stack: 'main',
        repo: '',
        uses: [],
        stages: {
          dev: {
            imageTag: 'intervening',
            deployedAt: new Date().toISOString(),
            status: 'deployed',
          },
        },
      },
    };
    await registry.write(doc!);

    const doc2 = await registry.read();
    await expect(registry.write(doc2!, staleEtag)).rejects.toThrow();
  });

  // -----------------------------------------------------------------------
  // lock
  // -----------------------------------------------------------------------

  it('lock returns etag and no-op release', async () => {
    const registry = makeRegistry();
    await registry.initialize();

    const lock = await registry.lock();
    expect(typeof lock.etag).toBe('string');
    expect(lock.release).toBeFunction();
    await lock.release(); // no-op
  });

  it('lock reads document to populate etag if not cached', async () => {
    const registry = makeRegistry();
    await registry.initialize();

    // Fresh registry instance — no cached etag
    const fresh = makeRegistry();
    const freshLock = await fresh.lock();
    expect(freshLock.etag).toBeDefined();
    expect(freshLock.etag.length).toBeGreaterThan(0);
    await freshLock.release();
  });

  // -----------------------------------------------------------------------
  // JSON round-trip fidelity
  // -----------------------------------------------------------------------

  it('preserves nested structure through write/read', async () => {
    const registry = makeRegistry();
    await registry.initialize();

    const doc = await registry.read();
    doc!.resources = {
      postgres: {
        type: 'postgres',
        stages: {
          dev: {
            status: 'provisioned',
            outputs: { PGHOST: 'db.local', PGPORT: '5432' },
            provisionedAt: new Date().toISOString(),
          },
        },
      },
    };
    doc!.stacks = {
      main: {
        preset: 'ecs',
        stages: {
          dev: {
            status: 'active',
            outputs: { ALB_ARN: 'arn:aws:elasticloadbalancing:us-east-1:123456:targetgroup/test' },
            updatedAt: new Date().toISOString(),
          },
        },
      },
    };
    await registry.write(doc!);

    const reloaded = await registry.read();
    expect(reloaded!.resources.postgres.stages.dev.outputs.PGHOST).toBe('db.local');
    expect(reloaded!.stacks.main.preset).toBe('ecs');
  });

  // -----------------------------------------------------------------------
  // custom prefix
  // -----------------------------------------------------------------------

  it('uses custom prefix for object key', async () => {
    const registry = makeRegistry({ prefix: 'custom-prefix/' });
    await registry.initialize();

    const doc = await registry.read();
    expect(doc).not.toBeNull();

    // Verify the object exists under the custom prefix
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'custom-prefix/' }),
    );
    expect(list.Contents).toBeDefined();
    expect(list.Contents!.some(o => o.Key === 'custom-prefix/registry.json')).toBe(true);
  });
});
