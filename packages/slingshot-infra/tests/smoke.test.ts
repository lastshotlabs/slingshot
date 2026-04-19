import { mkdtempSync, rmSync } from 'node:fs';
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
import { createPresetRegistry } from '../src/preset/presetRegistry';
import { createRegistryFromConfig } from '../src/registry/createRegistryFromConfig';
import { createLocalRegistry } from '../src/registry/localRegistry';
import { parseRegistryUrl } from '../src/registry/parseRegistryUrl';
import { generateInfraTemplate } from '../src/scaffold/infraTemplate';
import { generatePlatformTemplate } from '../src/scaffold/platformTemplate';
import { resolveRequiredKeys } from '../src/secrets/resolveRequiredKeys';
import type { DeployResult, PresetProvider } from '../src/types/preset';
import type { RegistryDocument } from '../src/types/registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'slingshot-smoke-'));
}

/** Stub preset that generates a Dockerfile and reports success on deploy. */
function stubPreset(name = 'ecs'): PresetProvider {
  const result: DeployResult = { success: true } as never;
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
    const env = resolveEnvironment(
      platform as never,
      infraConfig as never,
      'dev',
      registry,
    );
    expect(env.NODE_ENV).toBe('development');
    expect(env.REDIS_HOST).toBe('redis://local:6379');
    expect(env.APP_NAME).toBe('myapp');
  });
});
