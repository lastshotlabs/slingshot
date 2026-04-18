// Requires running Postgres and Redis instances.
// Run with: bun test tests/docker/infra-app-registry.test.ts
// Postgres: postgresql://postgres:postgres@localhost:5433/slingshot_test
// Redis: redis://localhost:6380
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import Redis from 'ioredis';
import { Pool } from 'pg';
import {
  deregisterApp,
  getAppsByResource,
  getAppsByStack,
  listApps,
  registerApp,
} from '../../packages/slingshot-infra/src/registry/appRegistry';
import { createPostgresRegistry } from '../../packages/slingshot-infra/src/registry/postgresRegistry';
import { createRedisRegistry } from '../../packages/slingshot-infra/src/registry/redisRegistry';
import type { RegistryProvider } from '../../packages/slingshot-infra/src/types/registry';

const PG_CONNECTION =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';

const PG_TABLE = 'slingshot_app_registry_test';
const REDIS_KEY = 'slingshot:app-registry:test';

// ---------------------------------------------------------------------------
// Shared test suite — runs against both Postgres and Redis backends
// ---------------------------------------------------------------------------

function appRegistrySuite(
  name: string,
  factory: () => RegistryProvider,
  cleanup: () => Promise<void>,
) {
  describe(`appRegistry on ${name}`, () => {
    let registry: RegistryProvider;

    beforeEach(async () => {
      await cleanup();
      registry = factory();
      await registry.initialize();
    });

    // -----------------------------------------------------------------------
    // registerApp + listApps
    // -----------------------------------------------------------------------

    it('registers an app and lists it', async () => {
      await registerApp(registry, {
        name: 'api',
        repo: 'github.com/acme/api',
        stacks: ['main'],
        uses: ['postgres', 'redis'],
      });

      const apps = await listApps(registry);
      expect(apps).toHaveLength(1);
      expect(apps[0].name).toBe('api');
      expect(apps[0].repo).toBe('github.com/acme/api');
      expect(apps[0].stacks).toEqual(['main']);
      expect(apps[0].uses).toEqual(['postgres', 'redis']);
      expect(apps[0].registeredAt).toBeDefined();
    });

    it('registers multiple apps', async () => {
      await registerApp(registry, {
        name: 'api',
        repo: 'github.com/acme/api',
        stacks: ['main'],
        uses: ['postgres'],
      });
      await registerApp(registry, {
        name: 'worker',
        repo: 'github.com/acme/worker',
        stacks: ['worker-stack'],
        uses: ['redis'],
      });
      await registerApp(registry, {
        name: 'frontend',
        repo: 'github.com/acme/frontend',
        stacks: ['main'],
        uses: [],
      });

      const apps = await listApps(registry);
      expect(apps).toHaveLength(3);
    });

    it('updates an existing app on re-register', async () => {
      await registerApp(registry, {
        name: 'api',
        repo: 'github.com/acme/api',
        stacks: ['main'],
        uses: ['postgres'],
      });

      // Re-register with changed stacks and uses
      await registerApp(registry, {
        name: 'api',
        repo: 'github.com/acme/api',
        stacks: ['main', 'secondary'],
        uses: ['postgres', 'redis'],
      });

      const apps = await listApps(registry);
      expect(apps).toHaveLength(1);
      expect(apps[0].stacks).toEqual(['main', 'secondary']);
      expect(apps[0].uses).toEqual(['postgres', 'redis']);
    });

    // -----------------------------------------------------------------------
    // listApps empty
    // -----------------------------------------------------------------------

    it('listApps returns empty array when no apps registered', async () => {
      const apps = await listApps(registry);
      expect(apps).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // getAppsByStack
    // -----------------------------------------------------------------------

    it('filters apps by stack', async () => {
      await registerApp(registry, {
        name: 'api',
        repo: 'github.com/acme/api',
        stacks: ['main'],
        uses: [],
      });
      await registerApp(registry, {
        name: 'worker',
        repo: 'github.com/acme/worker',
        stacks: ['worker-stack'],
        uses: [],
      });
      await registerApp(registry, {
        name: 'frontend',
        repo: 'github.com/acme/frontend',
        stacks: ['main'],
        uses: [],
      });

      const mainApps = await getAppsByStack(registry, 'main');
      expect(mainApps).toHaveLength(2);
      expect(mainApps.map(a => a.name).sort()).toEqual(['api', 'frontend']);

      const workerApps = await getAppsByStack(registry, 'worker-stack');
      expect(workerApps).toHaveLength(1);
      expect(workerApps[0].name).toBe('worker');

      const noApps = await getAppsByStack(registry, 'nonexistent');
      expect(noApps).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // getAppsByResource
    // -----------------------------------------------------------------------

    it('filters apps by resource', async () => {
      await registerApp(registry, {
        name: 'api',
        repo: 'github.com/acme/api',
        stacks: ['main'],
        uses: ['postgres', 'redis'],
      });
      await registerApp(registry, {
        name: 'worker',
        repo: 'github.com/acme/worker',
        stacks: ['main'],
        uses: ['redis'],
      });

      const pgApps = await getAppsByResource(registry, 'postgres');
      expect(pgApps).toHaveLength(1);
      expect(pgApps[0].name).toBe('api');

      const redisApps = await getAppsByResource(registry, 'redis');
      expect(redisApps).toHaveLength(2);

      const noApps = await getAppsByResource(registry, 'kafka');
      expect(noApps).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // deregisterApp
    // -----------------------------------------------------------------------

    it('removes a registered app', async () => {
      await registerApp(registry, {
        name: 'api',
        repo: 'github.com/acme/api',
        stacks: ['main'],
        uses: ['postgres'],
      });
      await registerApp(registry, {
        name: 'worker',
        repo: 'github.com/acme/worker',
        stacks: ['main'],
        uses: [],
      });

      await deregisterApp(registry, 'api');

      const apps = await listApps(registry);
      expect(apps).toHaveLength(1);
      expect(apps[0].name).toBe('worker');
    });

    it('deregisterApp is a no-op for unknown app names', async () => {
      await registerApp(registry, {
        name: 'api',
        repo: 'github.com/acme/api',
        stacks: ['main'],
        uses: [],
      });

      await deregisterApp(registry, 'nonexistent');

      const apps = await listApps(registry);
      expect(apps).toHaveLength(1);
    });

    it('deregisterApp is a no-op on empty registry', async () => {
      await deregisterApp(registry, 'nonexistent');
      // Should not throw
    });

    // -----------------------------------------------------------------------
    // Full lifecycle round-trip
    // -----------------------------------------------------------------------

    it('register → query → update → deregister round-trip', async () => {
      // Register two apps
      await registerApp(registry, {
        name: 'api',
        repo: 'github.com/acme/api',
        stacks: ['main'],
        uses: ['postgres'],
      });
      await registerApp(registry, {
        name: 'worker',
        repo: 'github.com/acme/worker',
        stacks: ['main', 'bg'],
        uses: ['redis', 'postgres'],
      });

      // Query by stack
      const mainApps = await getAppsByStack(registry, 'main');
      expect(mainApps).toHaveLength(2);

      const bgApps = await getAppsByStack(registry, 'bg');
      expect(bgApps).toHaveLength(1);
      expect(bgApps[0].name).toBe('worker');

      // Query by resource
      const pgApps = await getAppsByResource(registry, 'postgres');
      expect(pgApps).toHaveLength(2);

      // Update worker to remove postgres
      await registerApp(registry, {
        name: 'worker',
        repo: 'github.com/acme/worker',
        stacks: ['main', 'bg'],
        uses: ['redis'],
      });

      const pgAppsAfter = await getAppsByResource(registry, 'postgres');
      expect(pgAppsAfter).toHaveLength(1);
      expect(pgAppsAfter[0].name).toBe('api');

      // Deregister api
      await deregisterApp(registry, 'api');
      const remaining = await listApps(registry);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe('worker');
    });
  });
}

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------

let pgPool: Pool;

beforeAll(() => {
  pgPool = new Pool({ connectionString: PG_CONNECTION });
});

afterAll(async () => {
  await pgPool.query(`DROP TABLE IF EXISTS ${PG_TABLE}`);
  await pgPool.end();
});

appRegistrySuite(
  'Postgres',
  () => createPostgresRegistry({ connectionString: PG_CONNECTION, table: PG_TABLE }),
  async () => {
    await pgPool.query(`DROP TABLE IF EXISTS ${PG_TABLE}`);
  },
);

// ---------------------------------------------------------------------------
// Redis backend
// ---------------------------------------------------------------------------

let redisCleanup: Redis;

beforeAll(() => {
  redisCleanup = new Redis(REDIS_URL);
});

afterAll(async () => {
  await redisCleanup.del(REDIS_KEY, `${REDIS_KEY}:lock`);
  await redisCleanup.quit();
});

appRegistrySuite(
  'Redis',
  () => createRedisRegistry({ url: REDIS_URL, key: REDIS_KEY }),
  async () => {
    await redisCleanup.del(REDIS_KEY, `${REDIS_KEY}:lock`);
  },
);
