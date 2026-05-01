import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { compareInfraResources, deriveUsesFromAppConfig } from '../src/config/deriveUsesFromApp';
import { defineInfra } from '../src/config/infraSchema';
import { definePlatform } from '../src/config/platformSchema';
import { formatDeployPlan } from '../src/deploy/formatPlan';
import { runDeployPipeline } from '../src/deploy/pipeline';
import { computeDeployPlan } from '../src/deploy/plan';
import { resolveEnvironment } from '../src/deploy/resolveEnv';
import { runRollback } from '../src/deploy/rollback';
import { loadInfraConfig } from '../src/loader/loadInfraConfig';
import { loadPlatformConfig } from '../src/loader/loadPlatformConfig';
import { createPresetRegistry } from '../src/preset/presetRegistry';
import {
  deregisterApp,
  getAppsByResource,
  getAppsByStack,
  listApps,
  registerApp,
} from '../src/registry/appRegistry';
import { createRegistryFromConfig } from '../src/registry/createRegistryFromConfig';
import { createLocalRegistry } from '../src/registry/localRegistry';
import { parseRegistryUrl } from '../src/registry/parseRegistryUrl';
import { digestFetch, mapAwsRegionToAtlas } from '../src/resource/atlasClient';
import { destroyResources } from '../src/resource/destroyResources';
import { createDocumentDbProvisioner } from '../src/resource/provisioners/documentdb';
import { createKafkaProvisioner } from '../src/resource/provisioners/kafka';
import { createMongoProvisioner } from '../src/resource/provisioners/mongo';
import { createPostgresProvisioner } from '../src/resource/provisioners/postgres';
import { createRedisProvisioner } from '../src/resource/provisioners/redis';
import { generateInfraTemplate } from '../src/scaffold/infraTemplate';
import { generatePlatformTemplate } from '../src/scaffold/platformTemplate';
import { resolveRequiredKeys } from '../src/secrets/resolveRequiredKeys';
import { createSecretsManager } from '../src/secrets/secretsManager';
import {
  createMockProvisioner,
  createMockRegistryProvider,
  createMockSecretsManager,
  createTestPlatformConfig,
  createTestProvisionerContext,
} from '../src/testing';
import type { DeployResult, PresetProvider } from '../src/types/preset';
import type { RegistryDocument, RegistryProvider } from '../src/types/registry';
import { createEmptyRegistryDocument } from '../src/types/registry';
import type { ResourceProvisionerContext } from '../src/types/resource';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'slingshot-smoke-'));
}

/** Stub preset that generates a Dockerfile and reports success on deploy. */
function stubPreset(name = 'ecs'): PresetProvider {
  const resultRaw = { success: true };
  const result = resultRaw as unknown as DeployResult;
  const preset = {
    name,
    generate: () => [
      { path: 'Dockerfile', content: 'FROM node:20\nCMD ["node"]', ephemeral: false },
    ],
    deploy: async () => result,
  };
  return preset as unknown as PresetProvider;
}

function createFrozenPlatform() {
  return definePlatform({
    org: 'smoke-org',
    provider: 'aws',
    region: 'us-east-1',
    registry: { provider: 'local', path: '.slingshot/registry.json' },
    stages: {
      dev: { env: { NODE_ENV: 'development' } },
      prod: { env: { NODE_ENV: 'production' } },
    },
    stacks: { main: { preset: 'ecs' } },
  });
}

function createFrozenInfra() {
  return defineInfra({
    stacks: ['main'],
    port: 3000,
    size: 'small',
    healthCheck: '/health',
  });
}

// ---------------------------------------------------------------------------
// 1. Local registry full lifecycle
// ---------------------------------------------------------------------------

describe('smoke: local registry lifecycle', () => {
  it('initialize → write → read → lock → write(etag) → read round-trip', async () => {
    const dir = makeTempDir();
    const registryPath = join(dir, 'registry.json');
    try {
      const registry = createLocalRegistry({ path: registryPath });

      // Phase 1: initialize creates empty doc
      await registry.initialize();
      const initial = await registry.read();
      expect(initial).not.toBeNull();
      expect(Object.keys(initial!.services)).toHaveLength(0);

      // Phase 2: write a service
      initial!.services.api = {
        stack: 'main',
        stages: { dev: { imageTag: 'v1', status: 'deployed' } },
      };
      await registry.write(initial!);

      // Phase 3: read it back
      const afterWrite = await registry.read();
      expect(afterWrite!.services.api.stages.dev.imageTag).toBe('v1');

      // Phase 4: lock → read → conditional write
      const lock = await registry.lock();
      const locked = await registry.read();
      locked!.services.api.stages.dev.imageTag = 'v2';
      const { etag } = await registry.write(locked!, lock.etag);
      await lock.release();

      // Phase 5: verify final state
      const final = await registry.read();
      expect(final!.services.api.stages.dev.imageTag).toBe('v2');
      expect(etag).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parseRegistryUrl → createRegistryFromConfig → use', async () => {
    const dir = makeTempDir();
    const registryPath = join(dir, 'from-url.json');
    try {
      const config = parseRegistryUrl(registryPath);
      expect(config.provider).toBe('local');

      const registry = createRegistryFromConfig(config);
      await registry.initialize();
      const doc = await registry.read();
      expect(doc).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Config → plan → format end-to-end
// ---------------------------------------------------------------------------

describe('smoke: config → plan → format', () => {
  it('frozen configs feed into deploy plan and format cleanly', () => {
    const platform = createFrozenPlatform();
    const infra = createFrozenInfra();

    expect(Object.isFrozen(platform)).toBe(true);
    expect(Object.isFrozen(infra)).toBe(true);

    const registry: RegistryDocument = {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {},
      resources: {},
    };

    const plan = computeDeployPlan({
      infra: infra as never,
      stageName: 'dev',
      registry,
      imageTag: 'v1',
    });

    expect(plan.summary.additions).toBe(1);
    expect(plan.services[0].status).toBe('add');

    const output = formatDeployPlan(plan);
    expect(output).toContain('Deploy Plan');
    expect(output).toContain('+ default (main)');
    expect(output).toContain('1 to add');
  });
});

// ---------------------------------------------------------------------------
// 3. Deploy pipeline end-to-end with mock preset + local registry
// ---------------------------------------------------------------------------

describe('smoke: deploy pipeline', () => {
  it('full deploy: lock → generate → deploy → registry updated', async () => {
    const dir = makeTempDir();
    const registryPath = join(dir, 'pipeline-reg.json');
    try {
      const registry = createLocalRegistry({ path: registryPath });
      await registry.initialize();

      const platform = createFrozenPlatform();
      const infra = createFrozenInfra();
      const preset = stubPreset();
      const presetRegistry = createPresetRegistry([preset]);

      const result = await runDeployPipeline({
        platform: platform as never,
        infra: infra as never,
        stageName: 'dev',
        registry,
        presetRegistry,
        appRoot: process.cwd(),
      });

      expect(result.services).toHaveLength(1);
      expect(result.services[0].result.success).toBe(true);

      // Verify registry was updated
      const doc = await registry.read();
      expect(doc!.services.default).toBeDefined();
      expect(doc!.services.default.stages.dev.imageTag).toBeDefined();
      expect(doc!.services.default.stages.dev.status).toBe('deployed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('plan mode returns plan without modifying registry', async () => {
    const dir = makeTempDir();
    const registryPath = join(dir, 'plan-reg.json');
    try {
      const registry = createLocalRegistry({ path: registryPath });
      await registry.initialize();

      const platform = createFrozenPlatform();
      const infra = createFrozenInfra();

      const result = await runDeployPipeline({
        platform: platform as never,
        infra: infra as never,
        stageName: 'dev',
        registry,
        presetRegistry: createPresetRegistry([stubPreset()]),
        appRoot: process.cwd(),
        plan: true,
      });

      expect(result.plan).toBeDefined();
      expect(result.plan!.summary.additions).toBe(1);
      expect(result.services).toHaveLength(0);

      // Registry should still be empty (no deploy happened)
      const doc = await registry.read();
      expect(Object.keys(doc!.services)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deploy then rollback round-trip', async () => {
    const dir = makeTempDir();
    const registryPath = join(dir, 'rollback-reg.json');
    try {
      const registry = createLocalRegistry({ path: registryPath });
      await registry.initialize();

      const platform = createFrozenPlatform();
      const infra = createFrozenInfra();
      const preset = stubPreset();
      const presetRegistry = createPresetRegistry([preset]);

      // Deploy v1
      await runDeployPipeline({
        platform: platform as never,
        infra: infra as never,
        stageName: 'dev',
        registry,
        presetRegistry,
        appRoot: process.cwd(),
      });

      const afterV1 = await registry.read();
      const v1Tag = afterV1!.services.default.stages.dev.imageTag;

      // Deploy v2
      await runDeployPipeline({
        platform: platform as never,
        infra: infra as never,
        stageName: 'dev',
        registry,
        presetRegistry,
        appRoot: process.cwd(),
      });

      const afterV2 = await registry.read();
      const v2Tag = afterV2!.services.default.stages.dev.imageTag;
      expect(v2Tag).not.toBe(v1Tag);

      // Rollback to v1
      const rollbackResult = await runRollback({
        platform: platform as never,
        infra: infra as never,
        stageName: 'dev',
        registry,
        presetRegistry,
        appRoot: process.cwd(),
        serviceName: 'default',
        targetTag: v1Tag,
      });

      expect(rollbackResult.services).toHaveLength(1);
      expect(rollbackResult.services[0].rolledBackTag).toBe(v1Tag);
      expect(rollbackResult.services[0].previousTag).toBe(v2Tag);
      expect(rollbackResult.services[0].success).toBe(true);

      // Verify registry reflects the rollback
      const afterRollback = await registry.read();
      expect(afterRollback!.services.default.stages.dev.imageTag).toBe(v1Tag);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Scaffold → parse round-trip
// ---------------------------------------------------------------------------

describe('smoke: scaffold templates produce parseable output', () => {
  it('platform template contains all required fields for definePlatform', () => {
    const source = generatePlatformTemplate({
      org: 'testco',
      region: 'eu-west-1',
      stages: ['dev', 'prod'],
      resources: ['postgres'],
    });

    // Verify template contains all fields that definePlatform requires
    expect(source).toContain("org: 'testco'");
    expect(source).toContain("provider: 'aws'");
    expect(source).toContain("region: 'eu-west-1'");
    expect(source).toContain('registry:');
    expect(source).toContain('stages:');
    expect(source).toContain('stacks:');
    expect(source).toContain('import { definePlatform }');
  });

  it('infra template contains all required fields for defineInfra', () => {
    const source = generateInfraTemplate({
      stacks: ['api-stack', 'worker-stack'],
      port: 8080,
    });

    expect(source).toContain("'api-stack'");
    expect(source).toContain("'worker-stack'");
    expect(source).toContain('port: 8080');
    expect(source).toContain('import { defineInfra }');
  });
});

// ---------------------------------------------------------------------------
// 5. Derived uses → required keys → env resolution chain
// ---------------------------------------------------------------------------

describe('smoke: config derivation chain', () => {
  it('app config → derived uses → required keys → env resolution', () => {
    const appConfig = {
      db: { redis: true, sessions: 'postgres' },
      jobs: { workers: 2 },
    };

    // Step 1: derive uses
    const uses = deriveUsesFromAppConfig(appConfig);
    expect(uses).toContain('redis');
    expect(uses).toContain('postgres');

    // Step 2: resolve required keys
    const keys = resolveRequiredKeys({ uses });
    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('REDIS_HOST');
    expect(keys).toContain('JWT_SECRET');

    // Step 3: compare against platform
    const diags = compareInfraResources({
      infraUses: uses,
      platformResources: ['redis'],
      derivedUses: uses,
    });
    // postgres is in uses but not in platform resources → warning
    expect(diags.warnings.some(w => w.resource === 'postgres')).toBe(true);
    // redis is in both → no warning or suggestion
    expect(diags.warnings.some(w => w.resource === 'redis')).toBe(false);
    expect(diags.suggestions).toHaveLength(0);

    // Step 4: resolve env with registry outputs
    const platform = createFrozenPlatform();
    const registry: RegistryDocument = {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {},
      resources: {
        redis: {
          stages: {
            dev: { outputs: { REDIS_HOST: 'redis://local:6379' }, status: 'provisioned' },
          },
        },
      },
    };
    const infraConfig = { uses, env: { APP_NAME: 'myapp' } };
    const env = resolveEnvironment(platform as never, infraConfig as never, 'dev', registry);
    expect(env.NODE_ENV).toBe('development');
    expect(env.REDIS_HOST).toBe('redis://local:6379');
    expect(env.APP_NAME).toBe('myapp');
  });
});

describe('smoke: production support modules', () => {
  it('loads infra configs from an app root and platform configs by walking upward', async () => {
    const dir = makeTempDir();
    const appDir = join(dir, 'apps', 'api');
    mkdirSync(appDir, { recursive: true });
    try {
      const platformPath = join(dir, 'slingshot.platform.js');
      const infraPath = join(appDir, 'slingshot.infra.js');
      writeFileSync(
        platformPath,
        [
          'export default {',
          "  org: 'loader-org',",
          "  provider: 'aws',",
          "  region: 'us-west-2',",
          "  registry: { provider: 'local', path: '.slingshot/registry.json' },",
          "  stages: { prod: { env: { NODE_ENV: 'production' } } },",
          "  stacks: { main: { preset: 'ecs' } },",
          '};',
          '',
        ].join('\n'),
      );
      writeFileSync(
        infraPath,
        [
          'export default {',
          "  stacks: ['main'],",
          '  port: 8080,',
          "  uses: ['postgres'],",
          '};',
          '',
        ].join('\n'),
      );

      const infra = await loadInfraConfig(appDir);
      const platform = await loadPlatformConfig(appDir);

      expect(infra.configPath).toBe(infraPath);
      expect(infra.config.port).toBe(8080);
      expect(platform.configPath).toBe(platformPath);
      expect(platform.config.org).toBe('loader-org');
      expect(platform.config.stages.prod.env?.NODE_ENV).toBe('production');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers, queries, and deregisters apps with optimistic registry writes', async () => {
    const registry = createMockRegistryProvider();

    await registerApp(registry, {
      name: 'api',
      repo: 'github.com/acme/api',
      stacks: ['main'],
      uses: ['postgres', 'redis'],
    });
    await registerApp(registry, {
      name: 'worker',
      repo: 'github.com/acme/worker',
      stacks: ['jobs'],
      uses: ['redis'],
    });

    expect((await listApps(registry)).map(app => app.name).sort()).toEqual(['api', 'worker']);
    expect((await getAppsByStack(registry, 'main')).map(app => app.name)).toEqual(['api']);
    expect((await getAppsByResource(registry, 'redis')).map(app => app.name).sort()).toEqual([
      'api',
      'worker',
    ]);

    await deregisterApp(registry, 'api');
    expect((await listApps(registry)).map(app => app.name)).toEqual(['worker']);
  });

  it('builds Atlas digest requests and maps AWS regions to Atlas region names', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Digest realm="Atlas", nonce="abc123", qop="auth", opaque="opaque-token"',
          },
        });
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      const response = await digestFetch(
        'https://cloud.mongodb.com/api/atlas/v2.0/groups/project-1/clusters?pretty=true',
        {
          method: 'POST',
          body: JSON.stringify({ name: 'cluster' }),
          publicKey: 'public-key',
          privateKey: 'private-key',
          headers: { 'X-Test': 'yes' },
        },
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect(calls[0].init?.headers).toMatchObject({
        Accept: 'application/vnd.atlas.2023-01-01+json',
        'Content-Type': 'application/json',
        'X-Test': 'yes',
      });
      const auth = (calls[1].init?.headers as Record<string, string>).Authorization;
      expect(auth).toStartWith('Digest ');
      expect(auth).toContain('username="public-key"');
      expect(auth).toContain('realm="Atlas"');
      expect(auth).toContain('nonce="abc123"');
      expect(auth).toContain('uri="/api/atlas/v2.0/groups/project-1/clusters?pretty=true"');
      expect(auth).toContain('qop=auth');
      expect(auth).toContain('opaque="opaque-token"');
      expect(mapAwsRegionToAtlas('us-east-1')).toBe('US_EAST_1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolves manual connection output env for every built-in resource provisioner', async () => {
    const postgres = createPostgresProvisioner();
    const postgresOutput = await postgres.provision(
      createTestProvisionerContext('db', {
        config: {
          type: 'postgres',
          provision: false,
          connection: {
            host: 'db.internal',
            port: '5433',
            user: 'app',
            password: 'secret',
            database: 'appdb',
          },
        },
      }),
    );
    expect(postgresOutput.connectionEnv.DATABASE_URL).toBe(
      'postgres://app:secret@db.internal:5433/appdb',
    );
    expect(postgres.getConnectionEnv(postgresOutput).PGHOST).toBe('db.internal');

    const redis = createRedisProvisioner();
    const redisOutput = await redis.provision(
      createTestProvisionerContext('cache', {
        config: {
          type: 'redis',
          provision: false,
          connection: { host: 'cache.internal', password: 'pw' },
        },
      }),
    );
    expect(redisOutput.connectionEnv.REDIS_URL).toBe('redis://cache.internal:6379');
    expect(redisOutput.connectionEnv.REDIS_PASSWORD).toBe('pw');

    const kafka = createKafkaProvisioner();
    const kafkaOutput = await kafka.provision(
      createTestProvisionerContext('events', {
        config: {
          type: 'kafka',
          provision: false,
          connection: { brokers: 'broker-a:9092,broker-b:9092' },
        },
      }),
    );
    expect(kafkaOutput.connectionEnv.KAFKA_BROKERS).toBe('broker-a:9092,broker-b:9092');

    const mongo = createMongoProvisioner();
    const mongoOutput = await mongo.provision(
      createTestProvisionerContext('docs', {
        config: {
          type: 'mongo',
          provision: false,
          connection: {
            host: 'cluster.mongodb.net',
            username: 'app user',
            password: 'p@ss',
            database: 'appdb',
          },
        },
      }),
    );
    expect(mongoOutput.connectionEnv.MONGO_URL).toBe(
      'mongodb+srv://app%20user:p%40ss@cluster.mongodb.net/appdb',
    );

    const documentDb = createDocumentDbProvisioner();
    const documentDbOutput = await documentDb.provision(
      createTestProvisionerContext('docdb', {
        config: {
          type: 'documentdb',
          provision: false,
          connection: {
            host: 'docdb.internal',
            user: 'admin',
            password: 'secret',
            database: 'docs',
          },
        },
      }),
    );
    expect(documentDbOutput.connectionEnv.DOCUMENTDB_URL).toBe(
      'mongodb://admin:secret@docdb.internal:27017/docs?tls=true&retryWrites=false',
    );

    await postgres.destroy(createTestProvisionerContext('db', { config: postgresOutput as never }));
    await redis.destroy(createTestProvisionerContext('cache', { config: redisOutput as never }));
    await kafka.destroy(createTestProvisionerContext('events', { config: kafkaOutput as never }));
    await mongo.destroy(createTestProvisionerContext('docs', { config: mongoOutput as never }));
    await documentDb.destroy(
      createTestProvisionerContext('docdb', { config: documentDbOutput as never }),
    );
  });

  it('pushes, pulls, and checks file and env-backed secrets', async () => {
    const dir = makeTempDir();
    const secretsDir = join(dir, 'secrets');
    try {
      writeFileSync(
        join(dir, '.env.prod'),
        [
          '# ignored comment',
          'API_KEY="from-env"',
          'MULTI="line one',
          'line two"',
          'EMPTY=',
          '',
        ].join('\n'),
      );

      const manager = createSecretsManager({ provider: 'file', directory: secretsDir }, 'prod');

      await expect(manager.push(dir, ['API_KEY', 'MULTI', 'EMPTY', 'MISSING'])).resolves.toEqual({
        pushed: ['API_KEY', 'MULTI'],
      });
      expect(readFileSync(join(secretsDir, 'API_KEY'), 'utf-8')).toBe('from-env');
      expect(readFileSync(join(secretsDir, 'MULTI'), 'utf-8')).toBe('line one\nline two');

      writeFileSync(join(secretsDir, 'PULLED'), 'from-secret-store\n');
      await expect(manager.pull(dir, ['PULLED', 'MISSING'])).resolves.toEqual({
        pulled: ['PULLED'],
      });
      expect(readFileSync(join(dir, '.env.prod'), 'utf-8')).toContain('PULLED=from-secret-store');
      await expect(manager.check(['API_KEY', 'PULLED', 'MISSING'])).resolves.toEqual({
        found: ['API_KEY', 'PULLED'],
        missing: ['MISSING'],
      });

      const previous = process.env.SLINGSHOT_INFRA_TEST_SECRET;
      process.env.SLINGSHOT_INFRA_TEST_SECRET = 'present';
      try {
        await expect(
          createSecretsManager({ provider: 'env' }, 'prod').check([
            'SLINGSHOT_INFRA_TEST_SECRET',
            'SLINGSHOT_INFRA_MISSING_SECRET',
          ]),
        ).resolves.toEqual({
          found: ['SLINGSHOT_INFRA_TEST_SECRET'],
          missing: ['SLINGSHOT_INFRA_MISSING_SECRET'],
        });
      } finally {
        if (previous === undefined) {
          delete process.env.SLINGSHOT_INFRA_TEST_SECRET;
        } else {
          process.env.SLINGSHOT_INFRA_TEST_SECRET = previous;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('destroys provisioned resources and records skips and failures without deployed services', async () => {
    const doc = createEmptyRegistryDocument('test-org');
    const now = new Date().toISOString();
    doc.resources.db = {
      type: 'postgres',
      stages: { dev: { status: 'provisioned', outputs: { host: 'db' }, provisionedAt: now } },
    };
    doc.resources.cache = { type: 'redis', stages: {} };
    doc.resources.events = {
      type: 'kafka',
      stages: {
        dev: { status: 'provisioned', outputs: { brokers: 'broker' }, provisionedAt: now },
      },
    };
    const registry = createMockRegistryProvider(doc);
    const destroyed: string[] = [];
    const provisioners = {
      get(type: string) {
        return {
          async destroy(ctx: ResourceProvisionerContext): Promise<void> {
            if (ctx.resourceName === 'events') {
              throw new Error('destroy failed');
            }
            destroyed.push(`${type}:${ctx.resourceName}:${ctx.stageName}`);
          },
        };
      },
    };

    const platform = createTestPlatformConfig({
      resources: {
        db: { type: 'postgres', provision: false },
        cache: { type: 'redis', provision: false },
        events: { type: 'kafka', provision: false },
      },
    });

    const results = await destroyResources({
      platform,
      stageName: 'dev',
      registry,
      provisioners,
    });

    expect(results).toEqual([
      { name: 'db', status: 'destroyed' },
      { name: 'cache', status: 'skipped', message: 'Not provisioned for stage "dev"' },
      { name: 'events', status: 'error', message: 'destroy failed' },
    ]);
    expect(destroyed).toEqual(['postgres:db:dev']);
    expect(registry.document.resources.db.stages.dev).toBeUndefined();
    expect(registry.document.resources.events.stages.dev).toBeDefined();
  });

  it('refuses resource destruction when a service is still deployed on the stage', async () => {
    const doc = createEmptyRegistryDocument('test-org');
    doc.services.api = {
      stack: 'main',
      repo: 'github.com/acme/api',
      uses: [],
      stages: {
        dev: {
          imageTag: 'v1',
          deployedAt: new Date().toISOString(),
          status: 'deployed',
        },
      },
    };

    await expect(
      destroyResources({
        platform: createTestPlatformConfig({
          resources: { db: { type: 'postgres', provision: false } },
        }),
        stageName: 'dev',
        registry: createMockRegistryProvider(doc),
      }),
    ).rejects.toThrow("Stage 'dev' has deployed services");
  });
});

describe('smoke: testing helper exports', () => {
  it('creates a mock provisioner with tracked provision and destroy calls', async () => {
    const provisioner = createMockProvisioner('postgres', {
      outputs: { host: 'db.internal' },
      connectionEnv: { DATABASE_URL: 'postgres://db.internal/app' },
    });
    const ctx = createTestProvisionerContext('primary-db');

    const output = await provisioner.provision(ctx);
    await provisioner.destroy(ctx);

    expect(output.status).toBe('provisioned');
    expect(output.outputs.host).toBe('db.internal');
    expect(provisioner.getConnectionEnv(output).DATABASE_URL).toBe('postgres://db.internal/app');
    expect(provisioner.provisionCalls).toEqual([ctx]);
    expect(provisioner.destroyCalls).toEqual([ctx]);
  });

  it('creates in-memory registry and secrets manager fixtures', async () => {
    const registry = createMockRegistryProvider();
    await registry.initialize();

    const doc = await registry.read();
    expect(doc?.services).toEqual({});

    if (!doc) {
      throw new Error('expected mock registry document');
    }
    doc.services.api = {
      stack: 'main',
      stages: { prod: { imageTag: 'v1', status: 'deployed' } },
    };
    const write = await registry.write(doc);
    const lock = await registry.lock();

    expect(write.etag).toBe('2');
    expect(lock.etag).toBe('2');
    expect(registry.document.services.api.stages.prod.imageTag).toBe('v1');
    await lock.release();

    const secrets = createMockSecretsManager({ API_KEY: 'secret' });
    await expect(secrets.push('/tmp/app', ['API_KEY', 'MISSING'])).resolves.toEqual({
      pushed: ['API_KEY'],
    });
    await expect(secrets.pull('/tmp/app', ['API_KEY', 'MISSING'])).resolves.toEqual({
      pulled: ['API_KEY'],
    });
    await expect(secrets.check(['API_KEY', 'MISSING'])).resolves.toEqual({
      found: ['API_KEY'],
      missing: ['MISSING'],
    });
  });

  it('creates default platform and provisioner context fixtures with overrides', () => {
    const platform = createTestPlatformConfig({
      region: 'us-west-2',
      stages: { prod: { env: { NODE_ENV: 'production' } } },
    });
    const ctx = createTestProvisionerContext('cache', {
      config: { type: 'redis', provision: true },
      stageName: 'prod',
    });

    expect(platform.org).toBe('test-org');
    expect(platform.region).toBe('us-west-2');
    expect(platform.stages.prod.env?.NODE_ENV).toBe('production');
    expect(ctx.resourceName).toBe('cache');
    expect(ctx.config.type).toBe('redis');
    expect(ctx.stageName).toBe('prod');
  });
});
