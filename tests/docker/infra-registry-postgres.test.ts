// Requires a running Postgres instance.
// Run with: bun test tests/docker/infra-registry-postgres.test.ts
// Default connection: postgresql://postgres:postgres@localhost:5433/slingshot_test
// Override: TEST_POSTGRES_URL=<url> bun test tests/docker/infra-registry-postgres.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';
import { createPostgresRegistry } from '../../packages/slingshot-infra/src/registry/postgresRegistry';

const CONNECTION =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';

const TABLE = 'slingshot_registry_docker_test';

describe('createPostgresRegistry (docker)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: CONNECTION });
  });

  beforeEach(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.end();
  });

  // -------------------------------------------------------------------------
  // read before initialize
  // -------------------------------------------------------------------------

  it('read throws before initialize (table does not exist)', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
    await expect(registry.read()).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // initialize
  // -------------------------------------------------------------------------

  it('initialize creates table and empty document', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
    await registry.initialize();

    const doc = await registry.read();
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe(1);
    expect(doc!.services).toEqual({});
    expect(doc!.stacks).toEqual({});
    expect(doc!.resources).toEqual({});
  });

  it('initialize is idempotent', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
    await registry.initialize();
    await registry.initialize(); // second call should not throw or duplicate

    const res = await pool.query(`SELECT COUNT(*) FROM ${TABLE}`);
    expect(Number(res.rows[0].count)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // write + read round-trip
  // -------------------------------------------------------------------------

  it('write persists document and read returns it', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
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

  it('write without etag returns a new etag', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
    await registry.initialize();

    const doc = await registry.read();
    const { etag } = await registry.write(doc!);
    expect(etag).toBeDefined();
    expect(typeof etag).toBe('string');
  });

  // -------------------------------------------------------------------------
  // optimistic concurrency (etag)
  // -------------------------------------------------------------------------

  it('write with valid etag succeeds', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
    await registry.initialize();

    const lock = await registry.lock();
    const doc = await registry.read();
    const etag = lock.etag;
    await lock.release();

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
    expect(newEtag).not.toBe(etag);
  });

  it('write with stale etag throws', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
    await registry.initialize();

    // Capture etag
    const lock = await registry.lock();
    const staleEtag = lock.etag;
    await lock.release();

    // Make an intervening write to bump the version
    const doc = await registry.read();
    await registry.write(doc!);

    // Now try to write with the stale etag
    const doc2 = await registry.read();
    await expect(registry.write(doc2!, staleEtag)).rejects.toThrow('modified by another process');
  });

  it('write with invalid etag format throws', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
    await registry.initialize();

    const doc = await registry.read();
    await expect(registry.write(doc!, 'not-a-number')).rejects.toThrow('Invalid ETag');
  });

  it('write without existing row throws', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
    await registry.initialize();

    // Manually delete the row to simulate missing state
    await pool.query(`DELETE FROM ${TABLE}`);

    const doc = {
      version: 1,
      platform: '',
      updatedAt: new Date().toISOString(),
      stacks: {},
      resources: {},
      services: {},
    };
    await expect(registry.write(doc)).rejects.toThrow('No registry row');
  });

  // -------------------------------------------------------------------------
  // lock
  // -------------------------------------------------------------------------

  it('lock returns etag and release function', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
    await registry.initialize();

    const lock = await registry.lock();
    expect(typeof lock.etag).toBe('string');
    expect(lock.release).toBeFunction();
    await lock.release();
  });

  it('lock → read → write(etag) → release full cycle', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
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

    // Second lock → write with new etag
    const lock2 = await registry.lock();
    const doc2 = await registry.read();
    doc2!.services.api.stages.dev.imageTag = 'v2';
    await registry.write(doc2!, lock2.etag);
    await lock2.release();

    const final = await registry.read();
    expect(final!.services.api.stages.dev.imageTag).toBe('v2');
  });

  // -------------------------------------------------------------------------
  // advisory lock serialization
  // -------------------------------------------------------------------------

  it('concurrent lock attempts serialize correctly', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
    await registry.initialize();

    // Acquire first lock
    const lock1 = await registry.lock();

    // Start second lock attempt — it should block until lock1 is released.
    // Use a short timeout to prove it's blocking.
    let lock2Acquired = false;
    const lock2Promise = registry.lock().then(lock => {
      lock2Acquired = true;
      return lock;
    });

    // Give the second lock a moment — it should NOT acquire while lock1 is held
    await new Promise(r => setTimeout(r, 100));
    expect(lock2Acquired).toBe(false);

    // Release first lock
    await lock1.release();

    // Now the second lock should acquire
    const lock2 = await lock2Promise;
    expect(lock2Acquired).toBe(true);
    expect(typeof lock2.etag).toBe('string');
    await lock2.release();
  });

  // -------------------------------------------------------------------------
  // version column increments
  // -------------------------------------------------------------------------

  it('version increments on each write', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
    await registry.initialize();

    // Initial version
    const res1 = await pool.query(`SELECT version FROM ${TABLE} WHERE id = 'default'`);
    const v1 = res1.rows[0].version;

    const doc = await registry.read();
    await registry.write(doc!);

    const res2 = await pool.query(`SELECT version FROM ${TABLE} WHERE id = 'default'`);
    const v2 = res2.rows[0].version;
    expect(v2).toBe(v1 + 1);

    await registry.write(doc!);

    const res3 = await pool.query(`SELECT version FROM ${TABLE} WHERE id = 'default'`);
    const v3 = res3.rows[0].version;
    expect(v3).toBe(v2 + 1);
  });

  // -------------------------------------------------------------------------
  // JSONB round-trip fidelity
  // -------------------------------------------------------------------------

  it('preserves nested JSONB structure through write/read', async () => {
    const registry = createPostgresRegistry({ connectionString: CONNECTION, table: TABLE });
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
});
