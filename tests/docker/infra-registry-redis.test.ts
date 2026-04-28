// Requires a running Redis instance.
// Run with: bun test tests/docker/infra-registry-redis.test.ts
// Default connection: redis://localhost:6380
// Override: TEST_REDIS_URL=<url> bun test tests/docker/infra-registry-redis.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import Redis from 'ioredis';
import { createRedisRegistry } from '../../packages/slingshot-infra/src/registry/redisRegistry';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';
const REGISTRY_KEY = 'slingshot:registry:docker-test';

describe('createRedisRegistry (docker)', () => {
  let cleanup: Redis;

  beforeAll(() => {
    cleanup = new Redis(REDIS_URL);
  });

  beforeEach(async () => {
    // Delete the registry key and any lock key
    await cleanup.del(REGISTRY_KEY, `${REGISTRY_KEY}:lock`);
  });

  afterAll(async () => {
    await cleanup.del(REGISTRY_KEY, `${REGISTRY_KEY}:lock`);
    await cleanup.quit();
  });

  // -------------------------------------------------------------------------
  // read before initialize
  // -------------------------------------------------------------------------

  it('read returns null before initialize', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
    const doc = await registry.read();
    expect(doc).toBeNull();
  });

  // -------------------------------------------------------------------------
  // initialize
  // -------------------------------------------------------------------------

  it('initialize creates key with empty document', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
    await registry.initialize();

    const doc = await registry.read();
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe(1);
    expect(doc!.services).toEqual({});
    expect(doc!.stacks).toEqual({});
    expect(doc!.resources).toEqual({});
  });

  it('initialize is idempotent (setnx)', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
    await registry.initialize();

    // Mutate the document
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

    // Re-initialize should NOT overwrite existing data (setnx semantics)
    await registry.initialize();

    const reloaded = await registry.read();
    expect(reloaded!.services.api).toBeDefined();
    expect(reloaded!.services.api.stages.dev.imageTag).toBe('v1');
  });

  // -------------------------------------------------------------------------
  // write + read round-trip
  // -------------------------------------------------------------------------

  it('write persists document and read returns it', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
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
    expect(reloaded!.services.api.stack).toBe('main');
    expect(reloaded!.services.api.stages.dev.imageTag).toBe('v1');
  });

  it('write without etag returns a SHA-256 etag', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
    await registry.initialize();

    const doc = await registry.read();
    const { etag } = await registry.write(doc!);
    expect(etag).toBeDefined();
    expect(typeof etag).toBe('string');
    // SHA-256 hex is 64 chars
    expect(etag.length).toBe(64);
  });

  // -------------------------------------------------------------------------
  // optimistic concurrency (etag via WATCH/MULTI)
  // -------------------------------------------------------------------------

  it('write with valid etag succeeds', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
    await registry.initialize();

    // Get current etag
    const lock = await registry.lock();
    const etag = lock.etag;
    await lock.release();

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
    const { etag: newEtag } = await registry.write(doc!, etag);
    expect(newEtag).toBeDefined();
    expect(newEtag.length).toBe(64);
  });

  it('write with stale etag throws', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
    await registry.initialize();

    // Capture etag
    const lock = await registry.lock();
    const staleEtag = lock.etag;
    await lock.release();

    // Make an intervening write to change the content hash
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

    // Now try to write with the stale etag
    const doc2 = await registry.read();
    try {
      await registry.write(doc2!, staleEtag);
      throw new Error('expected stale etag write to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('modified by another process');
    }
  });

  // -------------------------------------------------------------------------
  // lock (SET NX PX + Lua release)
  // -------------------------------------------------------------------------

  it('lock returns etag and release function', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
    await registry.initialize();

    const lock = await registry.lock();
    expect(typeof lock.etag).toBe('string');
    expect(lock.release).toBeFunction();
    await lock.release();
  });

  it('lock → read → write(etag) → release full cycle', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
    await registry.initialize();

    // Acquire lock
    const lock = await registry.lock();
    const doc = await registry.read();

    // Mutate
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

    // Write with etag from lock
    await registry.write(doc!, lock.etag);
    await lock.release();

    // Verify
    const reloaded = await registry.read();
    expect(reloaded!.services.api.stages.dev.imageTag).toBe('v1');

    // Second cycle
    const lock2 = await registry.lock();
    const doc2 = await registry.read();
    doc2!.services.api.stages.dev.imageTag = 'v2';
    await registry.write(doc2!, lock2.etag);
    await lock2.release();

    const final = await registry.read();
    expect(final!.services.api.stages.dev.imageTag).toBe('v2');
  });

  it('lock fails when another lock is held', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
    await registry.initialize();

    // Acquire first lock
    const lock1 = await registry.lock();

    // Second lock attempt should fail (SET NX)
    await expect(registry.lock()).rejects.toThrow('Could not acquire registry lock');

    await lock1.release();

    // After release, a new lock should succeed
    const lock2 = await registry.lock();
    expect(typeof lock2.etag).toBe('string');
    await lock2.release();
  });

  it('lock release is atomic (only owner can release)', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
    await registry.initialize();

    const lock = await registry.lock();

    // Manually overwrite the lock key with a different value to simulate another owner
    await cleanup.set(`${REGISTRY_KEY}:lock`, 'someone-else', 'PX', 30000);

    // Release should be a no-op (Lua script checks lock ID)
    await lock.release();

    // The lock key should still exist (not deleted by the wrong owner)
    const exists = await cleanup.exists(`${REGISTRY_KEY}:lock`);
    expect(exists).toBe(1);

    // Clean up the foreign lock
    await cleanup.del(`${REGISTRY_KEY}:lock`);
  });

  // -------------------------------------------------------------------------
  // lock TTL
  // -------------------------------------------------------------------------

  it('lock with custom TTL expires automatically', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
    await registry.initialize();

    // Acquire lock with a very short TTL
    const lock = await registry.lock(500);

    // Lock key should exist
    let exists = await cleanup.exists(`${REGISTRY_KEY}:lock`);
    expect(exists).toBe(1);

    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 700));

    // Lock should have expired
    exists = await cleanup.exists(`${REGISTRY_KEY}:lock`);
    expect(exists).toBe(0);

    // A new lock should succeed without explicit release
    const lock2 = await registry.lock();
    await lock2.release();

    // Clean up the first lock's client (release after TTL expiry is a no-op)
    await lock.release();
  });

  // -------------------------------------------------------------------------
  // JSON round-trip fidelity
  // -------------------------------------------------------------------------

  it('preserves nested structure through write/read', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
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
    expect(reloaded!.stacks.main.stages.dev.outputs.ALB_ARN).toContain('arn:aws:');
  });

  // -------------------------------------------------------------------------
  // multiple services
  // -------------------------------------------------------------------------

  it('handles multiple services with different stages', async () => {
    const registry = createRedisRegistry({ url: REDIS_URL, key: REGISTRY_KEY });
    await registry.initialize();

    const doc = await registry.read();
    const now = new Date().toISOString();
    doc!.services = {
      api: {
        stack: 'main',
        repo: 'github.com/acme/api',
        uses: ['postgres', 'redis'],
        stages: {
          dev: { imageTag: 'api-v1', deployedAt: now, status: 'deployed' },
          prod: { imageTag: 'api-v0.9', deployedAt: now, status: 'deployed' },
        },
      },
      worker: {
        stack: 'worker-stack',
        repo: 'github.com/acme/api',
        uses: ['redis'],
        stages: {
          dev: { imageTag: 'worker-v1', deployedAt: now, status: 'deployed' },
        },
      },
    };
    await registry.write(doc!);

    const reloaded = await registry.read();
    expect(Object.keys(reloaded!.services)).toHaveLength(2);
    expect(reloaded!.services.api.stages.prod.imageTag).toBe('api-v0.9');
    expect(reloaded!.services.worker.uses).toEqual(['redis']);
  });
});
