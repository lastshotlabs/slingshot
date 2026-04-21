import { describe, expect, it, mock } from 'bun:test';
import { runRollback } from '../../../packages/slingshot-infra/src/deploy/rollback';
import type { DefineInfraConfig } from '../../../packages/slingshot-infra/src/types/infra';
import type { DefinePlatformConfig } from '../../../packages/slingshot-infra/src/types/platform';
import type { PresetProvider } from '../../../packages/slingshot-infra/src/types/preset';
import type {
  RegistryDocument,
  RegistryProvider,
} from '../../../packages/slingshot-infra/src/types/registry';

function createPlatform(overrides?: Partial<DefinePlatformConfig>): DefinePlatformConfig {
  return {
    org: 'test',
    provider: 'aws',
    region: 'us-east-1',
    registry: { provider: 'local', path: '/tmp/test.json' },
    stages: {
      prod: { env: {} },
    },
    stacks: {
      main: { preset: 'ecs' },
    },
    ...overrides,
  };
}

function createInfra(overrides?: Partial<DefineInfraConfig>): DefineInfraConfig {
  return {
    stacks: ['main'],
    uses: [],
    env: {},
    ...overrides,
  };
}

function createRegistryDoc(services?: RegistryDocument['services']): RegistryDocument {
  return {
    version: 1,
    platform: 'test',
    updatedAt: '',
    stacks: {},
    resources: {},
    services: services ?? {},
  };
}

function createMockRegistry(doc: RegistryDocument): RegistryProvider {
  return {
    name: 'mock',
    read: mock(() => Promise.resolve(doc)),
    write: mock(() => Promise.resolve({ etag: 'test' })),
    initialize: mock(() => Promise.resolve()),
    lock: mock(() => Promise.resolve({ etag: 'test', release: mock(() => Promise.resolve()) })),
  };
}

function createMockPreset(): PresetProvider {
  return {
    name: 'ecs',
    generate: mock(() => []),
    deploy: mock(() => Promise.resolve({ success: true })),
    provisionStack: mock(() => Promise.resolve({ success: true, outputs: {} })),
    destroyStack: mock(() => Promise.resolve()),
    defaultLogging: () => ({ driver: 'cloudwatch', retentionDays: 30 }),
  };
}

function createMockPresetRegistry(preset: PresetProvider) {
  return { get: () => preset };
}

describe('runRollback', () => {
  it('uses previous tag when no target specified', async () => {
    const preset = createMockPreset();
    const doc = createRegistryDoc({
      api: {
        stack: 'main',
        repo: '',
        uses: [],
        stages: {
          prod: {
            imageTag: 'v2',
            deployedAt: '2026-01-02T00:00:00Z',
            status: 'deployed',
            previousTags: [{ imageTag: 'v1', deployedAt: '2026-01-01T00:00:00Z' }],
          },
        },
      },
    });

    const registry = createMockRegistry(doc);
    const result = await runRollback({
      platform: createPlatform(),
      infra: createInfra(),
      stageName: 'prod',
      registry,
      presetRegistry: createMockPresetRegistry(preset),
      appRoot: '/tmp/app',
    });

    expect(result.services).toHaveLength(1);
    expect(result.services[0].name).toBe('api');
    expect(result.services[0].previousTag).toBe('v2');
    expect(result.services[0].rolledBackTag).toBe('v1');
    expect(result.services[0].success).toBe(true);
  });

  it('rolls back to specific tag', async () => {
    const preset = createMockPreset();
    const doc = createRegistryDoc({
      api: {
        stack: 'main',
        repo: '',
        uses: [],
        stages: {
          prod: {
            imageTag: 'v3',
            deployedAt: '2026-01-03T00:00:00Z',
            status: 'deployed',
            previousTags: [
              { imageTag: 'v1', deployedAt: '2026-01-01T00:00:00Z' },
              { imageTag: 'v2', deployedAt: '2026-01-02T00:00:00Z' },
            ],
          },
        },
      },
    });

    const registry = createMockRegistry(doc);
    const result = await runRollback({
      platform: createPlatform(),
      infra: createInfra(),
      stageName: 'prod',
      registry,
      presetRegistry: createMockPresetRegistry(preset),
      appRoot: '/tmp/app',
      targetTag: 'v1',
    });

    expect(result.services[0].rolledBackTag).toBe('v1');
    expect(result.services[0].success).toBe(true);
  });

  it('errors when no previous tags available', async () => {
    const preset = createMockPreset();
    const doc = createRegistryDoc({
      api: {
        stack: 'main',
        repo: '',
        uses: [],
        stages: {
          prod: {
            imageTag: 'v1',
            deployedAt: '2026-01-01T00:00:00Z',
            status: 'deployed',
          },
        },
      },
    });

    const registry = createMockRegistry(doc);
    const result = await runRollback({
      platform: createPlatform(),
      infra: createInfra(),
      stageName: 'prod',
      registry,
      presetRegistry: createMockPresetRegistry(preset),
      appRoot: '/tmp/app',
    });

    expect(result.services[0].success).toBe(false);
    expect(result.services[0].error).toContain('No previous tags');
  });

  it('updates registry after rollback', async () => {
    const preset = createMockPreset();
    const doc = createRegistryDoc({
      api: {
        stack: 'main',
        repo: '',
        uses: [],
        stages: {
          prod: {
            imageTag: 'v2',
            deployedAt: '2026-01-02T00:00:00Z',
            status: 'deployed',
            previousTags: [{ imageTag: 'v1', deployedAt: '2026-01-01T00:00:00Z' }],
          },
        },
      },
    });

    const registry = createMockRegistry(doc);
    await runRollback({
      platform: createPlatform(),
      infra: createInfra(),
      stageName: 'prod',
      registry,
      presetRegistry: createMockPresetRegistry(preset),
      appRoot: '/tmp/app',
    });

    // Registry should have been written
    expect(registry.write).toHaveBeenCalled();

    // The doc should now reflect the rolled-back tag
    const stageData = doc.services.api.stages.prod;
    expect(stageData.imageTag).toBe('v1');
    expect(stageData.status).toBe('deployed');
    // The previous v2 tag should be in history
    expect(stageData.previousTags).toContainEqual(expect.objectContaining({ imageTag: 'v2' }));
  });

  it('rolls back a single service when serviceName specified', async () => {
    const preset = createMockPreset();
    const doc = createRegistryDoc({
      api: {
        stack: 'main',
        repo: '',
        uses: [],
        stages: {
          prod: {
            imageTag: 'v2',
            deployedAt: '2026-01-02T00:00:00Z',
            status: 'deployed',
            previousTags: [{ imageTag: 'v1', deployedAt: '2026-01-01T00:00:00Z' }],
          },
        },
      },
      web: {
        stack: 'main',
        repo: '',
        uses: [],
        stages: {
          prod: {
            imageTag: 'w2',
            deployedAt: '2026-01-02T00:00:00Z',
            status: 'deployed',
            previousTags: [{ imageTag: 'w1', deployedAt: '2026-01-01T00:00:00Z' }],
          },
        },
      },
    });

    const registry = createMockRegistry(doc);
    const result = await runRollback({
      platform: createPlatform(),
      infra: createInfra(),
      stageName: 'prod',
      registry,
      presetRegistry: createMockPresetRegistry(preset),
      appRoot: '/tmp/app',
      serviceName: 'api',
    });

    // Only api should be rolled back
    expect(result.services).toHaveLength(1);
    expect(result.services[0].name).toBe('api');
    expect(result.services[0].rolledBackTag).toBe('v1');

    // web should remain unchanged
    expect(doc.services.web.stages.prod.imageTag).toBe('w2');
  });
});
