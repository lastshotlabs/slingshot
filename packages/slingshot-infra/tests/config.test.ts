import { describe, expect, it } from 'bun:test';
import { defineInfra } from '../src/config/infraSchema';
import { definePlatform } from '../src/config/platformSchema';

// ---------------------------------------------------------------------------
// definePlatform
// ---------------------------------------------------------------------------

describe('definePlatform', () => {
  const minimal = {
    org: 'acme',
    provider: 'aws' as const,
    region: 'us-east-1',
    registry: { provider: 'local' as const, path: '.slingshot/registry.json' },
    stages: { dev: { env: { NODE_ENV: 'development' } } },
  };

  it('returns a frozen config for valid input', () => {
    const result = definePlatform(minimal);
    expect(result.org).toBe('acme');
    expect(result.provider).toBe('aws');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('deep-freezes nested objects (rule 10)', () => {
    const result = definePlatform(minimal);
    expect(Object.isFrozen(result.registry)).toBe(true);
    expect(Object.isFrozen(result.stages)).toBe(true);
    expect(Object.isFrozen(result.stages.dev)).toBe(true);
    expect(Object.isFrozen(result.stages.dev.env)).toBe(true);
  });

  it('throws on missing required fields', () => {
    const empty: never = {} as never;
    expect(() => definePlatform(empty)).toThrow('[slingshot-infra] Invalid platform config');
  });

  it('accepts s3 registry with bucket', () => {
    const config = {
      ...minimal,
      registry: { provider: 's3' as const, bucket: 'my-bucket' },
    };
    expect(() => definePlatform(config)).not.toThrow();
  });

  it('rejects s3 registry without bucket', () => {
    const config = {
      ...minimal,
      registry: { provider: 's3' as const },
    };
    expect(() => definePlatform(config)).toThrow('bucket');
  });

  it('accepts redis registry with url', () => {
    const config = {
      ...minimal,
      registry: { provider: 'redis' as const, url: 'redis://localhost:6379' },
    };
    expect(() => definePlatform(config)).not.toThrow();
  });

  it('rejects redis registry without url', () => {
    const config = {
      ...minimal,
      registry: { provider: 'redis' as const },
    };
    expect(() => definePlatform(config)).toThrow('url');
  });

  it('accepts postgres registry with connectionString', () => {
    const config = {
      ...minimal,
      registry: { provider: 'postgres' as const, connectionString: 'postgres://localhost/db' },
    };
    expect(() => definePlatform(config)).not.toThrow();
  });

  it('rejects postgres registry without connectionString', () => {
    const config = {
      ...minimal,
      registry: { provider: 'postgres' as const },
    };
    expect(() => definePlatform(config)).toThrow('connectionString');
  });

  it('accepts documentdb resource type', () => {
    const config = {
      ...minimal,
      resources: {
        docdb: { type: 'documentdb' as const, provision: true },
      },
    };
    expect(() => definePlatform(config)).not.toThrow();
  });

  it('accepts all valid resource types', () => {
    for (const type of ['postgres', 'redis', 'kafka', 'mongo', 'documentdb'] as const) {
      const config = {
        ...minimal,
        resources: { [type]: { type, provision: false } },
      };
      expect(() => definePlatform(config)).not.toThrow();
    }
  });

  it('rejects cloudflare DNS without apiToken', () => {
    const config = {
      ...minimal,
      dns: { provider: 'cloudflare' as const },
    };
    expect(() => definePlatform(config)).toThrow('apiToken');
  });

  it('accepts cloudflare DNS with apiToken', () => {
    const config = {
      ...minimal,
      dns: { provider: 'cloudflare' as const, apiToken: 'tok-123' },
    };
    expect(() => definePlatform(config)).not.toThrow();
  });

  it('accepts manual DNS without apiToken', () => {
    const config = {
      ...minimal,
      dns: { provider: 'manual' as const },
    };
    expect(() => definePlatform(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// defineInfra
// ---------------------------------------------------------------------------

describe('defineInfra', () => {
  it('returns a frozen config for valid single-service input', () => {
    const result = defineInfra({
      stacks: ['main'],
      port: 3000,
      size: 'small',
    });
    expect(result.stacks).toEqual(['main']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('deep-freezes nested objects (rule 10)', () => {
    const result = defineInfra({
      stacks: ['main'],
      port: 3000,
      env: { NODE_ENV: 'production' },
    });
    expect(Object.isFrozen(result.env)).toBe(true);
    expect(Object.isFrozen(result.stacks)).toBe(true);
  });

  it('rejects single-service app without stacks', () => {
    expect(() => defineInfra({ port: 3000 })).toThrow('stacks');
  });

  it('accepts multi-service app with services (no top-level stacks required)', () => {
    const result = defineInfra({
      services: {
        api: { path: 'packages/api', stacks: ['main'] },
        worker: { path: 'packages/worker', stacks: ['workers'] },
      },
    });
    expect(result.services).toBeDefined();
  });

  it('accepts multi-service app with both services and top-level stacks', () => {
    expect(() =>
      defineInfra({
        stacks: ['main'],
        services: {
          api: { path: 'packages/api' },
        },
      }),
    ).not.toThrow();
  });

  it('accepts all size presets', () => {
    for (const size of ['small', 'medium', 'large', 'xlarge'] as const) {
      expect(() => defineInfra({ stacks: ['main'], size })).not.toThrow();
    }
  });

  it('accepts string health check', () => {
    expect(() => defineInfra({ stacks: ['main'], healthCheck: '/health' })).not.toThrow();
  });

  it('accepts object health check', () => {
    expect(() =>
      defineInfra({
        stacks: ['main'],
        healthCheck: { path: '/health', intervalSeconds: 30 },
      }),
    ).not.toThrow();
  });

  it('accepts nginx config', () => {
    expect(() =>
      defineInfra({
        stacks: ['main'],
        nginx: {
          loadBalancing: 'least-conn',
          websocket: true,
          gzip: { level: 5 },
          rateLimit: { requestsPerSecond: 10, burst: 20 },
        },
      }),
    ).not.toThrow();
  });

  it('accepts override map', () => {
    expect(() =>
      defineInfra({
        stacks: ['main'],
        overrides: {
          dockerfile: './Dockerfile.prod',
          dockerCompose: { services: { api: { environment: { FOO: 'bar' } } } },
        },
      }),
    ).not.toThrow();
  });
});
