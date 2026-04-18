import { describe, expect, it } from 'bun:test';
import { defineInfra } from '../../../packages/slingshot-infra/src/config/infraSchema';

describe('defineInfra', () => {
  it('validates single-service config', () => {
    const config = defineInfra({
      stacks: ['main'],
      domain: 'api.myapp.com',
      size: 'small',
      uses: ['postgres', 'redis'],
      healthCheck: '/health',
    });

    expect(config.stacks).toEqual(['main']);
    expect(config.domain).toBe('api.myapp.com');
    expect(config.size).toBe('small');
    expect(config.uses).toEqual(['postgres', 'redis']);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('validates multi-service config', () => {
    const config = defineInfra({
      services: {
        api: {
          path: 'apps/api',
          stacks: ['main'],
          domain: 'api.myapp.com',
          uses: ['postgres', 'redis'],
          scaling: { min: 2, max: 10 },
        },
        ws: {
          path: 'apps/ws',
          stacks: ['main'],
          domain: 'ws.myapp.com',
          uses: ['redis'],
          scaling: { memory: 1024 },
        },
        jobs: {
          path: 'apps/jobs',
          stacks: ['workers'],
          uses: ['postgres', 'redis'],
        },
      },
    });

    expect(Object.keys(config.services!)).toEqual(['api', 'ws', 'jobs']);
    expect(config.services!.api.scaling?.min).toBe(2);
    expect(config.services!.ws.scaling?.memory).toBe(1024);
  });

  it('validates overrides', () => {
    const config = defineInfra({
      stacks: ['main'],
      overrides: {
        dockerfile: './custom/Dockerfile',
        gha: {
          steps: {
            before: [{ name: 'Migrate', run: 'bun run migrate' }],
          },
        },
        sst: { service: { architecture: 'arm64' } },
      },
    });

    expect(config.overrides?.dockerfile).toBe('./custom/Dockerfile');
    expect(typeof config.overrides?.gha).toBe('object');
  });

  it('validates health check config object', () => {
    const config = defineInfra({
      stacks: ['main'],
      healthCheck: {
        path: '/healthz',
        intervalSeconds: 10,
        timeoutSeconds: 5,
        healthyThreshold: 3,
        unhealthyThreshold: 2,
      },
    });

    const hc = config.healthCheck as { path: string; intervalSeconds: number };
    expect(hc.path).toBe('/healthz');
    expect(hc.intervalSeconds).toBe(10);
  });

  it('validates logging config', () => {
    const config = defineInfra({
      stacks: ['main'],
      logging: {
        driver: 'cloudwatch',
        retentionDays: 90,
        logGroup: '/slingshot/api',
      },
    });

    expect(config.logging?.driver).toBe('cloudwatch');
    expect(config.logging?.retentionDays).toBe(90);
  });

  it('validates env vars', () => {
    const config = defineInfra({
      stacks: ['main'],
      env: { API_KEY: 'test123', DEBUG: 'true' },
    });

    expect(config.env?.API_KEY).toBe('test123');
  });

  it('throws on missing stacks for single-service', () => {
    expect(() =>
      defineInfra({
        domain: 'api.myapp.com',
      }),
    ).toThrow();
  });

  it('allows services without top-level stacks', () => {
    const config = defineInfra({
      services: {
        api: { path: 'apps/api', stacks: ['main'] },
      },
    });

    expect(config.services!.api.stacks).toEqual(['main']);
  });
});
