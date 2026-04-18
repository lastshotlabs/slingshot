import { describe, expect, it, mock } from 'bun:test';
import { destroyResources } from '../../../packages/slingshot-infra/src/resource/destroyResources';
import type { DefinePlatformConfig } from '../../../packages/slingshot-infra/src/types/platform';
import type {
  RegistryDocument,
  RegistryProvider,
} from '../../../packages/slingshot-infra/src/types/registry';
import type { ResourceProvisionerContext } from '../../../packages/slingshot-infra/src/types/resource';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePlatformConfig(
  resources: DefinePlatformConfig['resources'] = {},
): DefinePlatformConfig {
  return {
    org: 'testorg',
    provider: 'aws',
    region: 'us-east-1',
    registry: { provider: 'local', path: '/tmp/test.json' },
    stages: { dev: {}, prod: {} },
    resources,
  };
}

function makeRegistryDoc(overrides?: Partial<RegistryDocument>): RegistryDocument {
  return {
    version: 1,
    platform: 'testorg',
    updatedAt: new Date().toISOString(),
    stacks: {},
    resources: {},
    services: {},
    ...overrides,
  };
}

function makeRegistry(doc: RegistryDocument): RegistryProvider {
  const lockRelease = mock(async () => {});
  return {
    name: 'mock',
    read: mock(async () => doc),
    write: mock(async () => ({ etag: 'test-etag' })),
    initialize: mock(async () => {}),
    lock: mock(async () => ({ etag: 'test-etag', release: lockRelease })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('destroyResources', () => {
  it('returns skipped when resource has no stage entry in registry', async () => {
    const platform = makePlatformConfig({
      postgres: { type: 'postgres', provision: false },
    });
    const registry = makeRegistry(makeRegistryDoc());

    const results = await destroyResources({ platform, stageName: 'dev', registry });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('postgres');
    expect(results[0].status).toBe('skipped');
  });

  it('calls provisioner destroy for provisioned resources', async () => {
    const platform = makePlatformConfig({
      postgres: { type: 'postgres', provision: false },
    });
    const doc = makeRegistryDoc({
      resources: {
        postgres: {
          type: 'postgres',
          stages: {
            dev: {
              status: 'provisioned',
              outputs: {},
              provisionedAt: new Date().toISOString(),
            },
          },
        },
      },
    });
    const registry = makeRegistry(doc);

    const results = await destroyResources({ platform, stageName: 'dev', registry });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('postgres');
    expect(results[0].status).toBe('destroyed');
  });

  it('removes stage entry from registry after successful destroy', async () => {
    const platform = makePlatformConfig({
      postgres: { type: 'postgres', provision: false },
    });
    const doc = makeRegistryDoc({
      resources: {
        postgres: {
          type: 'postgres',
          stages: {
            dev: {
              status: 'provisioned',
              outputs: {},
              provisionedAt: new Date().toISOString(),
            },
          },
        },
      },
    });
    const registry = makeRegistry(doc);

    await destroyResources({ platform, stageName: 'dev', registry });

    expect(registry.write).toHaveBeenCalledTimes(1);
    const writtenDoc = (registry.write as ReturnType<typeof mock>).mock
      .calls[0][0] as RegistryDocument;
    expect(writtenDoc.resources.postgres?.stages.dev).toBeUndefined();
  });

  it('throws when deployed services exist for the stage', async () => {
    const platform = makePlatformConfig({
      postgres: { type: 'postgres', provision: false },
    });
    const doc = makeRegistryDoc({
      services: {
        api: {
          stack: 'main',
          repo: 'github.com/org/api',
          uses: ['postgres'],
          stages: {
            dev: {
              imageTag: 'v1.0.0',
              deployedAt: new Date().toISOString(),
              status: 'deployed',
            },
          },
        },
      },
    });
    const registry = makeRegistry(doc);

    await expect(destroyResources({ platform, stageName: 'dev', registry })).rejects.toThrow(
      "Stage 'dev' has deployed services. Run 'slingshot rollback' or remove services first.",
    );
  });

  it('destroys only the specified resource when resource flag is provided', async () => {
    const platform = makePlatformConfig({
      postgres: { type: 'postgres', provision: false },
      redis: { type: 'redis', provision: false },
    });
    const doc = makeRegistryDoc({
      resources: {
        postgres: {
          type: 'postgres',
          stages: {
            dev: { status: 'provisioned', outputs: {}, provisionedAt: new Date().toISOString() },
          },
        },
        redis: {
          type: 'redis',
          stages: {
            dev: { status: 'provisioned', outputs: {}, provisionedAt: new Date().toISOString() },
          },
        },
      },
    });
    const registry = makeRegistry(doc);

    const results = await destroyResources({
      platform,
      stageName: 'dev',
      resource: 'postgres',
      registry,
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('postgres');
    expect(results[0].status).toBe('destroyed');
  });

  it('throws when specified resource does not exist in platform config', async () => {
    const platform = makePlatformConfig({
      postgres: { type: 'postgres', provision: false },
    });
    const registry = makeRegistry(makeRegistryDoc());

    await expect(
      destroyResources({ platform, stageName: 'dev', resource: 'nonexistent', registry }),
    ).rejects.toThrow('Resource "nonexistent" not found');
  });

  it('returns error status when provisioner destroy throws', async () => {
    const platform = makePlatformConfig({
      postgres: { type: 'postgres', provision: true },
    });
    const doc = makeRegistryDoc({
      resources: {
        postgres: {
          type: 'postgres',
          stages: {
            dev: { status: 'provisioned', outputs: {}, provisionedAt: new Date().toISOString() },
          },
        },
      },
    });
    const registry = makeRegistry(doc);
    const destroy = mock(async (_ctx: ResourceProvisionerContext) => {
      throw new Error('provisioner destroy failed');
    });

    const results = await destroyResources({
      platform,
      stageName: 'dev',
      registry,
      provisioners: {
        get: (_type: string) => ({ destroy }),
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('postgres');
    expect(results[0].status).toBe('error');
    expect(results[0].message).toContain('provisioner destroy failed');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('writes registry once after processing all resources', async () => {
    const platform = makePlatformConfig({
      postgres: { type: 'postgres', provision: false },
      redis: { type: 'redis', provision: false },
    });
    const doc = makeRegistryDoc({
      resources: {
        postgres: {
          type: 'postgres',
          stages: {
            dev: { status: 'provisioned', outputs: {}, provisionedAt: new Date().toISOString() },
          },
        },
        redis: {
          type: 'redis',
          stages: {
            dev: { status: 'provisioned', outputs: {}, provisionedAt: new Date().toISOString() },
          },
        },
      },
    });
    const registry = makeRegistry(doc);

    await destroyResources({ platform, stageName: 'dev', registry });

    expect(registry.write).toHaveBeenCalledTimes(1);
  });
});
