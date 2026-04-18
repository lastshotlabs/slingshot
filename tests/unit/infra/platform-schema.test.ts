import { describe, expect, it } from 'bun:test';
import { definePlatform } from '../../../packages/slingshot-infra/src/config/platformSchema';

describe('definePlatform', () => {
  it('validates and returns a frozen config', () => {
    const config = definePlatform({
      org: 'testorg',
      provider: 'aws',
      region: 'us-east-1',
      registry: { provider: 'local', path: '/tmp/registry.json' },
      stages: {
        dev: { env: { NODE_ENV: 'development' } },
        prod: { env: { NODE_ENV: 'production' } },
      },
    });

    expect(config.org).toBe('testorg');
    expect(config.provider).toBe('aws');
    expect(config.stages.dev.env?.NODE_ENV).toBe('development');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('validates stacks with presets', () => {
    const config = definePlatform({
      org: 'testorg',
      provider: 'aws',
      region: 'us-east-1',
      registry: { provider: 'local', path: '/tmp/registry.json' },
      stacks: {
        main: { preset: 'ecs' },
        'dev-box': { preset: 'ec2-nginx' },
      },
      stages: { dev: {} },
    });

    expect(config.stacks?.main.preset).toBe('ecs');
    expect(config.stacks?.['dev-box'].preset).toBe('ec2-nginx');
  });

  it('validates shared resources', () => {
    const config = definePlatform({
      org: 'testorg',
      provider: 'aws',
      region: 'us-east-1',
      registry: { provider: 'local', path: '/tmp/registry.json' },
      resources: {
        postgres: {
          type: 'postgres',
          provision: true,
          stages: {
            dev: { instanceClass: 'db.t3.micro', storageGb: 20 },
            prod: { instanceClass: 'db.t3.medium', storageGb: 100 },
          },
        },
        redis: { type: 'redis', provision: true },
      },
      stages: { dev: {}, prod: {} },
    });

    expect(config.resources?.postgres.provision).toBe(true);
    expect(config.resources?.postgres.stages?.dev.instanceClass).toBe('db.t3.micro');
  });

  it('validates scaling config in stage overrides', () => {
    const config = definePlatform({
      org: 'testorg',
      provider: 'aws',
      region: 'us-east-1',
      registry: { provider: 'local', path: '/tmp/registry.json' },
      stacks: { main: { preset: 'ecs' } },
      stages: {
        prod: {
          stacks: {
            main: {
              scaling: { min: 2, max: 10, targetCpuPercent: 70 },
            },
          },
        },
      },
    });

    expect(config.stages.prod.stacks?.main.scaling?.min).toBe(2);
    expect(config.stages.prod.stacks?.main.scaling?.max).toBe(10);
  });

  it('validates platform defaults', () => {
    const config = definePlatform({
      org: 'testorg',
      provider: 'aws',
      region: 'us-east-1',
      registry: { provider: 'local', path: '/tmp/registry.json' },
      stages: { dev: {} },
      defaults: {
        preset: 'ecs',
        scaling: { min: 1, max: 3, cpu: 256, memory: 512 },
        logging: { driver: 'cloudwatch', retentionDays: 30 },
      },
    });

    expect(config.defaults?.preset).toBe('ecs');
    expect(config.defaults?.scaling?.cpu).toBe(256);
  });

  it('throws on missing org', () => {
    expect(() =>
      definePlatform({
        org: '',
        provider: 'aws',
        region: 'us-east-1',
        registry: { provider: 'local', path: '/tmp/test.json' },
        stages: { dev: {} },
      }),
    ).toThrow('Invalid platform config');
  });

  it('throws on s3 registry without bucket', () => {
    expect(() =>
      definePlatform({
        org: 'test',
        provider: 'aws',
        region: 'us-east-1',
        registry: { provider: 's3' },
        stages: { dev: {} },
      }),
    ).toThrow();
  });

  it('validates multi-platform config', () => {
    const config = definePlatform({
      org: 'testorg',
      provider: 'aws',
      region: 'us-east-1',
      registry: { provider: 'local', path: '/tmp/registry.json' },
      stages: { dev: {} },
      platforms: {
        'client-a': {
          provider: 'aws',
          region: 'eu-west-1',
          registry: { provider: 'local', path: '/tmp/client-a.json' },
          stages: { prod: {} },
        },
      },
    });

    expect(config.platforms?.['client-a'].region).toBe('eu-west-1');
  });
});
