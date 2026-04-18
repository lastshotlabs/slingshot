import { describe, expect, it } from 'bun:test';
import { resolveEnvironment } from '../../../packages/slingshot-infra/src/deploy/resolveEnv';
import type { DefineInfraConfig } from '../../../packages/slingshot-infra/src/types/infra';
import type { DefinePlatformConfig } from '../../../packages/slingshot-infra/src/types/platform';
import type { RegistryDocument } from '../../../packages/slingshot-infra/src/types/registry';

function createPlatform(overrides?: Partial<DefinePlatformConfig>): DefinePlatformConfig {
  return {
    org: 'test',
    provider: 'aws',
    region: 'us-east-1',
    registry: { provider: 'local', path: '/tmp/test.json' },
    stages: {
      prod: { env: { NODE_ENV: 'production' } },
    },
    ...overrides,
  };
}

function createInfra(overrides?: Partial<DefineInfraConfig>): DefineInfraConfig {
  return {
    stacks: ['main'],
    uses: ['postgres'],
    env: { APP_NAME: 'myapp' },
    ...overrides,
  };
}

function createRegistry(overrides?: Partial<RegistryDocument>): RegistryDocument {
  return {
    version: 1,
    platform: 'test',
    updatedAt: '',
    stacks: {},
    resources: {
      postgres: {
        type: 'postgres',
        stages: {
          prod: {
            status: 'provisioned',
            outputs: {
              DATABASE_URL: 'postgres://localhost/mydb',
              PGHOST: 'localhost',
              PGPORT: '5432',
            },
            provisionedAt: '',
          },
        },
      },
    },
    services: {},
    ...overrides,
  };
}

describe('resolveEnvironment', () => {
  it('includes platform stage env', () => {
    const env = resolveEnvironment(
      createPlatform(),
      createInfra({ uses: [], env: {} }),
      'prod',
      createRegistry({ resources: {} }),
    );

    expect(env.NODE_ENV).toBe('production');
  });

  it('auto-wires resource outputs', () => {
    const env = resolveEnvironment(createPlatform(), createInfra(), 'prod', createRegistry());

    expect(env.DATABASE_URL).toBe('postgres://localhost/mydb');
    expect(env.PGHOST).toBe('localhost');
    expect(env.PGPORT).toBe('5432');
  });

  it('includes app-level env', () => {
    const env = resolveEnvironment(createPlatform(), createInfra(), 'prod', createRegistry());

    expect(env.APP_NAME).toBe('myapp');
  });

  it('app env overrides platform env', () => {
    const env = resolveEnvironment(
      createPlatform({ stages: { prod: { env: { APP_NAME: 'platform-name' } } } }),
      createInfra({ env: { APP_NAME: 'app-name' } }),
      'prod',
      createRegistry({ resources: {} }),
    );

    expect(env.APP_NAME).toBe('app-name');
  });

  it('service-level env overrides app-level', () => {
    const env = resolveEnvironment(
      createPlatform(),
      createInfra({ env: { PORT: '3000' } }),
      'prod',
      createRegistry({ resources: {} }),
      { path: 'apps/api', env: { PORT: '8080' } },
    );

    expect(env.PORT).toBe('8080');
  });

  it('skips missing resource stages', () => {
    const env = resolveEnvironment(
      createPlatform(),
      createInfra({ uses: ['redis'] }),
      'prod',
      createRegistry({ resources: {} }),
    );

    expect(env.REDIS_HOST).toBeUndefined();
  });

  it('handles empty uses array', () => {
    const env = resolveEnvironment(
      createPlatform(),
      createInfra({ uses: [], env: {} }),
      'prod',
      createRegistry(),
    );

    expect(env.NODE_ENV).toBe('production');
    expect(env.DATABASE_URL).toBeUndefined();
  });
});
