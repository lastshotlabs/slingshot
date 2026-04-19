import { describe, expect, it } from 'bun:test';
import { runDeployPipeline } from '../../../packages/slingshot-infra/src/deploy/pipeline';
import type { DefineInfraConfig } from '../../../packages/slingshot-infra/src/types/infra';
import type { DefinePlatformConfig } from '../../../packages/slingshot-infra/src/types/platform';
import type {
  DeployResult,
  PresetProvider,
} from '../../../packages/slingshot-infra/src/types/preset';
import type {
  RegistryDocument,
  RegistryLock,
  RegistryProvider,
} from '../../../packages/slingshot-infra/src/types/registry';

function createMockPreset(overrides?: Partial<PresetProvider>): PresetProvider {
  return {
    name: 'mock-preset',
    generate: () => [{ path: 'Dockerfile.default', content: 'FROM node:20', ephemeral: true }],
    deploy: async (): Promise<DeployResult> => ({ success: true }),
    provisionStack: async () => ({ success: true, outputs: {} }),
    destroyStack: async () => {},
    defaultLogging: () => ({ driver: 'local', retentionDays: 7 }),
    ...overrides,
  };
}

function createMockRegistry(doc: RegistryDocument | null): RegistryProvider {
  let stored = doc ? structuredClone(doc) : null;
  return {
    name: 'mock',
    async read() {
      return stored ? structuredClone(stored) : null;
    },
    async write(d: RegistryDocument) {
      stored = structuredClone(d);
      return { etag: 'mock-etag' };
    },
    async initialize() {},
    async lock(): Promise<RegistryLock> {
      return { etag: 'mock-etag', release: async () => {} };
    },
  };
}

function createPlatform(overrides?: Partial<DefinePlatformConfig>): DefinePlatformConfig {
  return {
    org: 'testorg',
    provider: 'aws',
    region: 'us-east-1',
    registry: { provider: 'local', path: '/tmp/test.json' },
    stacks: { main: { preset: 'mock-preset' } },
    stages: { prod: { env: { NODE_ENV: 'production' } } },
    ...overrides,
  };
}

function createInfra(overrides?: Partial<DefineInfraConfig>): DefineInfraConfig {
  return {
    stacks: ['main'],
    repo: 'test-app',
    ...overrides,
  };
}

function createRegistryDoc(): RegistryDocument {
  return {
    version: 1,
    platform: 'testorg',
    updatedAt: '',
    stacks: { main: { preset: 'mock-preset', stages: {} } },
    resources: {},
    services: {},
  };
}

describe('runDeployPipeline', () => {
  it('dry-run mode generates files but does not call deploy', async () => {
    let deployCalled = false;
    const preset = createMockPreset({
      deploy: async () => {
        deployCalled = true;
        return { success: true };
      },
    });

    const registry = createMockRegistry(createRegistryDoc());

    const result = await runDeployPipeline({
      platform: createPlatform(),
      infra: createInfra(),
      stageName: 'prod',
      registry,
      presetRegistry: { get: () => preset },
      appRoot: '/app',
      dryRun: true,
    });

    expect(deployCalled).toBe(false);
    expect(result.services).toHaveLength(1);
    expect(result.services[0].result.success).toBe(true);
  });

  it('normal mode calls deploy', async () => {
    let deployCalled = false;
    const preset = createMockPreset({
      deploy: async () => {
        deployCalled = true;
        return { success: true, serviceUrl: 'https://api.myapp.com' };
      },
    });

    const registry = createMockRegistry(createRegistryDoc());

    const result = await runDeployPipeline({
      platform: createPlatform(),
      infra: createInfra(),
      stageName: 'prod',
      registry,
      presetRegistry: { get: () => preset },
      appRoot: '/app',
    });

    expect(deployCalled).toBe(true);
    expect(result.services[0].result.success).toBe(true);
    expect(result.services[0].result.serviceUrl).toBe('https://api.myapp.com');
  });

  it('registry is updated after deploy', async () => {
    const registryProvider = createMockRegistry(createRegistryDoc());
    const preset = createMockPreset();

    await runDeployPipeline({
      platform: createPlatform(),
      infra: createInfra(),
      stageName: 'prod',
      registry: registryProvider,
      presetRegistry: { get: () => preset },
      appRoot: '/app',
    });

    const doc = await registryProvider.read();
    expect(doc).not.toBeNull();
    expect(doc!.services.default).toBeDefined();
    expect(doc!.services.default.stages.prod.status).toBe('deployed');
  });

  it('passes sibling services to preset context and stores service metadata in the registry', async () => {
    const registryDoc = createRegistryDoc();
    registryDoc.services.api = {
      stack: 'main',
      repo: 'repo-b',
      uses: ['shared'],
      env: { API_ONLY: '1' },
      port: 4000,
      domain: 'api.example.com',
      image: 'ghcr.io/repo-b/api:old',
      stages: {
        prod: {
          imageTag: 'old',
          deployedAt: '2024-01-01T00:00:00.000Z',
          status: 'deployed',
        },
      },
    };

    let sawSibling = false;
    const preset = createMockPreset({
      generate: ctx => {
        sawSibling = true;
        expect(ctx.siblingServices).toHaveLength(1);
        expect(ctx.siblingServices?.[0].name).toBe('api');
        expect(ctx.siblingServices?.[0].domain).toBe('api.example.com');
        return [{ path: 'Dockerfile.default', content: 'FROM node:20', ephemeral: true }];
      },
    });

    const registryProvider = createMockRegistry(registryDoc);

    await runDeployPipeline({
      platform: createPlatform(),
      infra: createInfra({
        services: {
          web: {
            path: 'apps/web',
            stacks: ['main'],
            port: 3001,
            domain: 'web.example.com',
            uses: ['shared'],
            env: { WEB_ONLY: '1' },
          },
        },
      }),
      stageName: 'prod',
      registry: registryProvider,
      presetRegistry: { get: () => preset },
      appRoot: '/app',
    });

    expect(sawSibling).toBe(true);
    const doc = await registryProvider.read();
    expect(doc!.services.web.stack).toBe('main');
    expect(doc!.services.web.repo).toBe('test-app');
    expect(doc!.services.web.port).toBe(3001);
    expect(doc!.services.web.domain).toBe('web.example.com');
    expect(doc!.services.web.image).toContain('/web:');
    expect(doc!.services.web.uses).toEqual(['shared']);
    expect(doc!.services.web.env).toMatchObject({ WEB_ONLY: '1' });
  });

  it('acquires the registry lock before reading and releases it after writing', async () => {
    const calls: string[] = [];
    const registryDoc = createRegistryDoc();
    const registry: RegistryProvider = {
      name: 'trace',
      async read() {
        calls.push('read');
        return structuredClone(registryDoc);
      },
      async write(d: RegistryDocument) {
        calls.push('write');
        Object.assign(registryDoc, structuredClone(d));
        return { etag: 'trace-etag' };
      },
      async initialize() {},
      async lock(ttlMs?: number): Promise<RegistryLock> {
        calls.push(`lock:${ttlMs ?? 0}`);
        return { etag: 'trace-etag', release: async () => void calls.push('release') };
      },
    };

    await runDeployPipeline({
      platform: createPlatform(),
      infra: createInfra(),
      stageName: 'prod',
      registry,
      presetRegistry: { get: () => createMockPreset() },
      appRoot: '/app',
    });

    expect(calls[0]).toBe('lock:120000');
    expect(calls[1]).toBe('read');
    expect(calls).toContain('write');
    expect(calls[calls.length - 1]).toBe('release');
    expect(calls.indexOf('lock:120000')).toBeLessThan(calls.indexOf('read'));
    expect(calls.indexOf('read')).toBeLessThan(calls.indexOf('write'));
    expect(calls.indexOf('write')).toBeLessThan(calls.indexOf('release'));
  });

  it('missing stage throws', async () => {
    const preset = createMockPreset();
    const registry = createMockRegistry(createRegistryDoc());

    await expect(
      runDeployPipeline({
        platform: createPlatform(),
        infra: createInfra(),
        stageName: 'staging',
        registry,
        presetRegistry: { get: () => preset },
        appRoot: '/app',
      }),
    ).rejects.toThrow('Stage "staging" not found');
  });

  it('missing stack throws', async () => {
    const preset = createMockPreset();
    const registry = createMockRegistry(createRegistryDoc());

    await expect(
      runDeployPipeline({
        platform: createPlatform({ stacks: {} }),
        infra: createInfra({ stacks: ['nonexistent'] }),
        stageName: 'prod',
        registry,
        presetRegistry: { get: () => preset },
        appRoot: '/app',
      }),
    ).rejects.toThrow('Stack "nonexistent" not found');
  });

  it('throws when registry is not initialized', async () => {
    const preset = createMockPreset();
    const registry = createMockRegistry(null);

    await expect(
      runDeployPipeline({
        platform: createPlatform(),
        infra: createInfra(),
        stageName: 'prod',
        registry,
        presetRegistry: { get: () => preset },
        appRoot: '/app',
      }),
    ).rejects.toThrow('Registry not initialized');
  });

  it('dry-run does not update registry', async () => {
    const registryProvider = createMockRegistry(createRegistryDoc());
    const preset = createMockPreset();

    await runDeployPipeline({
      platform: createPlatform(),
      infra: createInfra(),
      stageName: 'prod',
      registry: registryProvider,
      presetRegistry: { get: () => preset },
      appRoot: '/app',
      dryRun: true,
    });

    const doc = await registryProvider.read();
    expect(doc!.services).toEqual({});
  });
});
