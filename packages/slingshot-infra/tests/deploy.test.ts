import { describe, expect, it } from 'bun:test';
import { formatDeployPlan } from '../src/deploy/formatPlan';
import {
  extractServiceNameFromDockerfile,
  mapFileToOverrideKey,
} from '../src/deploy/overrideMapping';
import { computeDeployPlan } from '../src/deploy/plan';
import { resolveEnvironment } from '../src/deploy/resolveEnv';
import { runRollback } from '../src/deploy/rollback';
import type { RegistryDocument } from '../src/types/registry';
import type { RegistryProvider } from '../src/types/registry';

// ---------------------------------------------------------------------------
// resolveEnvironment
// ---------------------------------------------------------------------------

describe('resolveEnvironment', () => {
  const basePlatform = {
    org: 'acme',
    provider: 'aws' as const,
    region: 'us-east-1',
    registry: { provider: 'local' as const, path: '.slingshot/registry.json' },
    stages: {
      dev: { env: { NODE_ENV: 'development', LOG_LEVEL: 'debug' } },
      prod: { env: { NODE_ENV: 'production' } },
    },
  };

  const emptyRegistry: RegistryDocument = {
    version: 1,
    services: {},
    resources: {},
    updatedAt: new Date().toISOString(),
  };

  it('returns stage env as base layer', () => {
    const env = resolveEnvironment(basePlatform as never, {} as never, 'dev', emptyRegistry);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('returns empty object for unknown stage', () => {
    const env = resolveEnvironment(basePlatform as never, {} as never, 'staging', emptyRegistry);
    expect(Object.keys(env)).toHaveLength(0);
  });

  it('merges resource outputs from registry', () => {
    const registry: RegistryDocument = {
      ...emptyRegistry,
      resources: {
        postgres: {
          stages: {
            dev: { outputs: { DATABASE_URL: 'postgres://localhost/dev' }, status: 'provisioned' },
          },
        },
      },
    };
    const infra = { uses: ['postgres'] };
    const env = resolveEnvironment(basePlatform as never, infra as never, 'dev', registry);
    expect(env.DATABASE_URL).toBe('postgres://localhost/dev');
    expect(env.NODE_ENV).toBe('development');
  });

  it('skips missing resource entries gracefully', () => {
    const infra = { uses: ['nonexistent'] };
    const env = resolveEnvironment(basePlatform as never, infra as never, 'dev', emptyRegistry);
    expect(env.NODE_ENV).toBe('development');
  });

  it('app-level env overrides stage and resource env', () => {
    const infra = { env: { NODE_ENV: 'test', APP_KEY: 'value' } };
    const env = resolveEnvironment(basePlatform as never, infra as never, 'dev', emptyRegistry);
    expect(env.NODE_ENV).toBe('test');
    expect(env.APP_KEY).toBe('value');
  });

  it('service-level env overrides all other layers', () => {
    const infra = { env: { NODE_ENV: 'test' } };
    const service = { env: { NODE_ENV: 'service-override', SVC_KEY: 'svc' } };
    const env = resolveEnvironment(
      basePlatform as never,
      infra as never,
      'dev',
      emptyRegistry,
      service as never,
    );
    expect(env.NODE_ENV).toBe('service-override');
    expect(env.SVC_KEY).toBe('svc');
  });

  it('uses service.uses over infra.uses when service provided', () => {
    const registry: RegistryDocument = {
      ...emptyRegistry,
      resources: {
        redis: {
          stages: {
            dev: { outputs: { REDIS_HOST: 'redis://local' }, status: 'provisioned' },
          },
        },
        postgres: {
          stages: {
            dev: { outputs: { DATABASE_URL: 'pg://local' }, status: 'provisioned' },
          },
        },
      },
    };
    const infra = { uses: ['postgres'] };
    const service = { uses: ['redis'] };
    const env = resolveEnvironment(
      basePlatform as never,
      infra as never,
      'dev',
      registry,
      service as never,
    );
    expect(env.REDIS_HOST).toBe('redis://local');
    expect(env.DATABASE_URL).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeDeployPlan
// ---------------------------------------------------------------------------

describe('computeDeployPlan', () => {
  const emptyRegistry: RegistryDocument = {
    version: 1,
    services: {},
    resources: {},
    updatedAt: new Date().toISOString(),
  };

  it('marks new service as add', () => {
    const plan = computeDeployPlan({
      infra: { stacks: ['main'] } as never,
      stageName: 'dev',
      registry: emptyRegistry,
      imageTag: 'v1',
    });
    expect(plan.services).toHaveLength(1);
    expect(plan.services[0].status).toBe('add');
    expect(plan.services[0].serviceName).toBe('default');
    expect(plan.services[0].newImageTag).toBe('v1');
    expect(plan.summary.additions).toBe(1);
  });

  it('marks unchanged when image tag matches', () => {
    const registry: RegistryDocument = {
      ...emptyRegistry,
      services: {
        default: {
          stack: 'main',
          stages: {
            dev: { imageTag: 'v1', status: 'deployed' },
          },
        },
      },
    };
    const plan = computeDeployPlan({
      infra: { stacks: ['main'] } as never,
      stageName: 'dev',
      registry,
      imageTag: 'v1',
    });
    expect(plan.services[0].status).toBe('unchanged');
    expect(plan.summary.unchanged).toBe(1);
    expect(plan.services[0].changes).toHaveLength(0);
  });

  it('marks update when image tag differs', () => {
    const registry: RegistryDocument = {
      ...emptyRegistry,
      services: {
        default: {
          stack: 'main',
          stages: {
            dev: { imageTag: 'v1', status: 'deployed' },
          },
        },
      },
    };
    const plan = computeDeployPlan({
      infra: { stacks: ['main'] } as never,
      stageName: 'dev',
      registry,
      imageTag: 'v2',
    });
    expect(plan.services[0].status).toBe('update');
    expect(plan.services[0].currentImageTag).toBe('v1');
    expect(plan.services[0].newImageTag).toBe('v2');
    expect(plan.summary.updates).toBe(1);
    expect(plan.services[0].changes[0]).toContain('v1');
    expect(plan.services[0].changes[0]).toContain('v2');
  });

  it('includes stack change when stack differs', () => {
    const registry: RegistryDocument = {
      ...emptyRegistry,
      services: {
        default: {
          stack: 'old-stack',
          stages: {
            dev: { imageTag: 'v1', status: 'deployed' },
          },
        },
      },
    };
    const plan = computeDeployPlan({
      infra: { stacks: ['new-stack'] } as never,
      stageName: 'dev',
      registry,
      imageTag: 'v2',
    });
    expect(plan.services[0].changes).toHaveLength(2);
    expect(plan.services[0].changes[1]).toContain('old-stack');
    expect(plan.services[0].changes[1]).toContain('new-stack');
  });

  it('handles multi-service infra', () => {
    const plan = computeDeployPlan({
      infra: {
        stacks: ['main'],
        services: {
          api: { path: 'packages/api' },
          worker: { path: 'packages/worker', stacks: ['workers'] },
        },
      } as never,
      stageName: 'dev',
      registry: emptyRegistry,
      imageTag: 'v1',
    });
    expect(plan.services).toHaveLength(2);
    const names = plan.services.map(s => s.serviceName);
    expect(names).toContain('api');
    expect(names).toContain('worker');
    const workerEntry = plan.services.find(s => s.serviceName === 'worker')!;
    expect(workerEntry.stackName).toBe('workers');
  });

  it('aggregates summary counts correctly', () => {
    const registry: RegistryDocument = {
      ...emptyRegistry,
      services: {
        api: {
          stack: 'main',
          stages: {
            dev: { imageTag: 'v1', status: 'deployed' },
          },
        },
      },
    };
    const plan = computeDeployPlan({
      infra: {
        stacks: ['main'],
        services: {
          api: { path: 'packages/api' },
          worker: { path: 'packages/worker' },
        },
      } as never,
      stageName: 'dev',
      registry,
      imageTag: 'v1',
    });
    expect(plan.summary.unchanged).toBe(1);
    expect(plan.summary.additions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatDeployPlan
// ---------------------------------------------------------------------------

describe('formatDeployPlan', () => {
  it('formats an add entry with + indicator', () => {
    const output = formatDeployPlan({
      services: [
        {
          serviceName: 'api',
          stackName: 'main',
          status: 'add',
          newImageTag: 'v1',
          changes: ['stack: main (new)', 'image tag: v1 (new)'],
        },
      ],
      summary: { additions: 1, updates: 0, unchanged: 0 },
    });
    expect(output).toContain('+ api (main)');
    expect(output).toContain('stack: main (new)');
    expect(output).toContain('Plan: 1 to add, 0 to update, 0 unchanged');
  });

  it('formats an update entry with ~ indicator', () => {
    const output = formatDeployPlan({
      services: [
        {
          serviceName: 'api',
          stackName: 'main',
          status: 'update',
          currentImageTag: 'v1',
          newImageTag: 'v2',
          changes: ['image tag: v1 \u2192 v2'],
        },
      ],
      summary: { additions: 0, updates: 1, unchanged: 0 },
    });
    expect(output).toContain('~ api (main)');
    expect(output).toContain('image tag: v1 \u2192 v2');
  });

  it('formats an unchanged entry with = indicator', () => {
    const output = formatDeployPlan({
      services: [
        {
          serviceName: 'api',
          stackName: 'main',
          status: 'unchanged',
          currentImageTag: 'v1',
          newImageTag: 'v1',
          changes: [],
        },
      ],
      summary: { additions: 0, updates: 0, unchanged: 1 },
    });
    expect(output).toContain('= api (main)');
  });

  it('includes the Deploy Plan header', () => {
    const output = formatDeployPlan({
      services: [],
      summary: { additions: 0, updates: 0, unchanged: 0 },
    });
    expect(output).toContain('Deploy Plan');
    expect(output).toContain('==========');
  });
});

// ---------------------------------------------------------------------------
// overrideMapping
// ---------------------------------------------------------------------------

describe('mapFileToOverrideKey', () => {
  it('maps Dockerfile to "dockerfile"', () => {
    expect(mapFileToOverrideKey('Dockerfile')).toBe('dockerfile');
    expect(mapFileToOverrideKey('services/api/Dockerfile')).toBe('dockerfile');
    expect(mapFileToOverrideKey('Dockerfile.api')).toBe('dockerfile');
  });

  it('maps docker-compose files to "dockerCompose"', () => {
    expect(mapFileToOverrideKey('docker-compose.yml')).toBe('dockerCompose');
    expect(mapFileToOverrideKey('docker-compose.prod.yml')).toBe('dockerCompose');
  });

  it('maps .github paths to "gha"', () => {
    expect(mapFileToOverrideKey('.github/workflows/deploy.yml')).toBe('gha');
  });

  it('maps sst.config to "sst"', () => {
    expect(mapFileToOverrideKey('sst.config.ts')).toBe('sst');
  });

  it('maps Caddyfile to "caddy"', () => {
    expect(mapFileToOverrideKey('Caddyfile')).toBe('caddy');
  });

  it('maps nginx paths to "nginx"', () => {
    expect(mapFileToOverrideKey('nginx.conf')).toBe('nginx');
    expect(mapFileToOverrideKey('config/nginx/default.conf')).toBe('nginx');
  });

  it('returns null for unrecognized paths', () => {
    expect(mapFileToOverrideKey('package.json')).toBeNull();
    expect(mapFileToOverrideKey('README.md')).toBeNull();
  });
});

describe('extractServiceNameFromDockerfile', () => {
  it('extracts service name from Dockerfile.api', () => {
    expect(extractServiceNameFromDockerfile('Dockerfile.api')).toBe('api');
  });

  it('extracts service name from nested path', () => {
    expect(extractServiceNameFromDockerfile('services/Dockerfile.worker')).toBe('worker');
  });

  it('returns null for plain Dockerfile', () => {
    expect(extractServiceNameFromDockerfile('Dockerfile')).toBeNull();
  });

  it('returns null for non-Dockerfile paths', () => {
    expect(extractServiceNameFromDockerfile('package.json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runRollback
// ---------------------------------------------------------------------------

describe('runRollback', () => {
  function createMockRegistry(
    doc: RegistryDocument | null,
  ): RegistryProvider & { calls: string[] } {
    const calls: string[] = [];
    return {
      name: 'mock',
      calls,
      async read() {
        calls.push('read');
        return doc ? structuredClone(doc) : null;
      },
      async write(d: RegistryDocument) {
        calls.push('write');
        return { etag: 'new' };
      },
      async initialize() {
        calls.push('initialize');
      },
      async lock() {
        calls.push('lock');
        return {
          etag: 'e1',
          release: async () => {
            calls.push('release');
          },
        };
      },
    };
  }

  const basePlatform = {
    org: 'acme',
    provider: 'aws' as const,
    region: 'us-east-1',
    registry: { provider: 'local' as const, path: '.slingshot/registry.json' },
    stages: { prod: { env: { NODE_ENV: 'production' } } },
    stacks: { main: { preset: 'ecs' } },
  };

  const baseInfra = { stacks: ['main'] };

  const fakePreset = {
    name: 'ecs',
    generate: () => [],
    deploy: async () => ({ success: true }),
  };
  const fakePresetRegistry = { get: () => fakePreset };

  it('acquires lock before reading registry', async () => {
    const registryDoc: RegistryDocument = {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        api: {
          stack: 'main',
          stages: {
            prod: {
              imageTag: 'v2',
              status: 'deployed',
              previousTags: [{ imageTag: 'v1', deployedAt: new Date().toISOString() }],
            },
          },
        },
      },
      resources: {},
    };
    const mock = createMockRegistry(registryDoc);

    await runRollback({
      platform: basePlatform as never,
      infra: baseInfra as never,
      stageName: 'prod',
      registry: mock,
      presetRegistry: fakePresetRegistry as never,
      appRoot: process.cwd(),
      serviceName: 'api',
    });

    const lockIdx = mock.calls.indexOf('lock');
    const readIdx = mock.calls.indexOf('read');
    const writeIdx = mock.calls.indexOf('write');
    const releaseIdx = mock.calls.indexOf('release');

    expect(lockIdx).toBeLessThan(readIdx);
    expect(readIdx).toBeLessThan(writeIdx);
    expect(writeIdx).toBeLessThan(releaseIdx);
  });

  it('releases lock when registry is not initialized', async () => {
    const mock = createMockRegistry(null);

    await expect(
      runRollback({
        platform: basePlatform as never,
        infra: baseInfra as never,
        stageName: 'prod',
        registry: mock,
        presetRegistry: fakePresetRegistry as never,
        appRoot: process.cwd(),
      }),
    ).rejects.toThrow('Registry not initialized');

    expect(mock.calls).toContain('lock');
    expect(mock.calls).toContain('release');
  });

  it('throws for unknown stage', async () => {
    const mock = createMockRegistry(null);

    await expect(
      runRollback({
        platform: basePlatform as never,
        infra: baseInfra as never,
        stageName: 'staging',
        registry: mock,
        presetRegistry: fakePresetRegistry as never,
        appRoot: process.cwd(),
      }),
    ).rejects.toThrow('Stage "staging" not found');
  });

  it('rolls back to previous tag when no targetTag specified', async () => {
    const registryDoc: RegistryDocument = {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        api: {
          stack: 'main',
          stages: {
            prod: {
              imageTag: 'v3',
              status: 'deployed',
              previousTags: [
                { imageTag: 'v1', deployedAt: new Date().toISOString() },
                { imageTag: 'v2', deployedAt: new Date().toISOString() },
              ],
            },
          },
        },
      },
      resources: {},
    };
    const mock = createMockRegistry(registryDoc);

    const result = await runRollback({
      platform: basePlatform as never,
      infra: baseInfra as never,
      stageName: 'prod',
      registry: mock,
      presetRegistry: fakePresetRegistry as never,
      appRoot: process.cwd(),
      serviceName: 'api',
    });

    expect(result.services).toHaveLength(1);
    expect(result.services[0].previousTag).toBe('v3');
    expect(result.services[0].rolledBackTag).toBe('v2');
    expect(result.services[0].success).toBe(true);
  });

  it('uses explicit targetTag when provided', async () => {
    const registryDoc: RegistryDocument = {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        api: {
          stack: 'main',
          stages: {
            prod: {
              imageTag: 'v3',
              status: 'deployed',
              previousTags: [{ imageTag: 'v2', deployedAt: new Date().toISOString() }],
            },
          },
        },
      },
      resources: {},
    };
    const mock = createMockRegistry(registryDoc);

    const result = await runRollback({
      platform: basePlatform as never,
      infra: baseInfra as never,
      stageName: 'prod',
      registry: mock,
      presetRegistry: fakePresetRegistry as never,
      appRoot: process.cwd(),
      serviceName: 'api',
      targetTag: 'v1',
    });

    expect(result.services[0].rolledBackTag).toBe('v1');
  });

  it('reports error when service has no previous tags', async () => {
    const registryDoc: RegistryDocument = {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        api: {
          stack: 'main',
          stages: {
            prod: { imageTag: 'v1', status: 'deployed', previousTags: [] },
          },
        },
      },
      resources: {},
    };
    const mock = createMockRegistry(registryDoc);

    const result = await runRollback({
      platform: basePlatform as never,
      infra: baseInfra as never,
      stageName: 'prod',
      registry: mock,
      presetRegistry: fakePresetRegistry as never,
      appRoot: process.cwd(),
      serviceName: 'api',
    });

    expect(result.services[0].success).toBe(false);
    expect(result.services[0].error).toContain('No previous tags');
  });
});
