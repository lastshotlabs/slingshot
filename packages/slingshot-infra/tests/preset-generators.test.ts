import { describe, expect, it } from 'bun:test';
import { createEc2NginxPreset } from '../src/preset/ec2-nginx/ec2NginxPreset';
import { createEcsPreset } from '../src/preset/ecs/ecsPreset';
import type { PresetContext } from '../src/types/preset';

// ---------------------------------------------------------------------------
// Minimal PresetContext builder
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<PresetContext>): PresetContext {
  return {
    platform: {
      org: 'testco',
      provider: 'aws',
      region: 'us-east-1',
      registry: { provider: 'local', path: '.slingshot/registry.json' },
      stages: {
        dev: { env: { NODE_ENV: 'development' } },
        prod: { env: { NODE_ENV: 'production' } },
      },
      stacks: { main: { preset: 'ecs' } },
    } as never,
    infra: {
      stacks: ['main'],
      port: 3000,
      size: 'small',
      healthCheck: '/health',
    } as never,
    stage: { env: { NODE_ENV: 'development' } } as never,
    stageName: 'dev',
    stack: { preset: 'ecs' } as never,
    stackName: 'main',
    registry: {
      version: 1,
      platform: '',
      updatedAt: new Date().toISOString(),
      stacks: {},
      resources: {},
      services: {},
    },
    resolvedEnv: { NODE_ENV: 'development', PORT: '3000' },
    appRoot: '/app',
    serviceName: 'default',
    imageTag: '20240101-abc1234',
    dockerRegistry: 'ghcr.io/testco',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ECS preset generate()
// ---------------------------------------------------------------------------

describe('ECS preset: generate()', () => {
  const preset = createEcsPreset();

  it('has name "ecs"', () => {
    expect(preset.name).toBe('ecs');
  });

  it('generates a Dockerfile', () => {
    const files = preset.generate(makeContext());
    const dockerfiles = files.filter(f => f.path.startsWith('Dockerfile'));
    expect(dockerfiles.length).toBeGreaterThanOrEqual(1);
    expect(dockerfiles[0].content).toContain('FROM');
  });

  it('generates sst.config.ts', () => {
    const files = preset.generate(makeContext());
    const sst = files.find(f => f.path === 'sst.config.ts');
    expect(sst).toBeDefined();
    expect(sst!.content).toContain('$config(');
    expect(sst!.content).toContain('testco');
    expect(sst!.ephemeral).toBe(true);
  });

  it('generates a GitHub Actions workflow', () => {
    const files = preset.generate(makeContext());
    const gha = files.find(f => f.path.includes('.github/workflows/'));
    expect(gha).toBeDefined();
    expect(gha!.content).toContain('sst deploy');
    expect(gha!.path).toContain('dev');
    expect(gha!.ephemeral).toBe(true);
  });

  it('includes env vars in SST config', () => {
    const files = preset.generate(makeContext());
    const sst = files.find(f => f.path === 'sst.config.ts');
    expect(sst!.content).toContain('NODE_ENV');
  });

  it('includes port and health check in SST config', () => {
    const files = preset.generate(makeContext());
    const sst = files.find(f => f.path === 'sst.config.ts');
    expect(sst!.content).toContain('3000');
    expect(sst!.content).toContain('/health');
  });

  it('generates fluentd config when logging driver is fluentd', () => {
    const ctx = makeContext({
      infra: {
        stacks: ['main'],
        port: 3000,
        size: 'small',
        healthCheck: '/health',
        logging: { driver: 'fluentd', fluentd: {} },
      } as never,
    });
    const files = preset.generate(ctx);
    const fluentd = files.find(f => f.path.includes('fluent'));
    expect(fluentd).toBeDefined();
  });

  it('does not generate fluentd config when logging driver is not fluentd', () => {
    const files = preset.generate(makeContext());
    const fluentd = files.find(f => f.path.includes('fluent'));
    expect(fluentd).toBeUndefined();
  });

  it('uses stage name in GHA workflow path', () => {
    const ctx = makeContext({ stageName: 'production' });
    const files = preset.generate(ctx);
    const gha = files.find(f => f.path.includes('.github/workflows/'));
    expect(gha!.path).toContain('production');
  });

  it('defaultLogging returns cloudwatch with 30 day retention', () => {
    expect(preset.defaultLogging()).toEqual({ driver: 'cloudwatch', retentionDays: 30 });
  });
});

// ---------------------------------------------------------------------------
// ECS preset with multi-service infra
// ---------------------------------------------------------------------------

describe('ECS preset: multi-service', () => {
  const preset = createEcsPreset();

  it('generates one Dockerfile per service on the stack', () => {
    const ctx = makeContext({
      infra: {
        stacks: ['main'],
        port: 3000,
        size: 'small',
        healthCheck: '/health',
        services: {
          api: { port: 3000, stacks: ['main'] },
          worker: { port: 4000, stacks: ['main'] },
          scheduler: { port: 5000, stacks: ['other'] },
        },
      } as never,
    });
    const files = preset.generate(ctx);
    const dockerfiles = files.filter(f => f.path.startsWith('Dockerfile'));
    // Only api and worker are on 'main' stack
    expect(dockerfiles.length).toBe(2);
    expect(dockerfiles.some(f => f.path.includes('api'))).toBe(true);
    expect(dockerfiles.some(f => f.path.includes('worker'))).toBe(true);
    expect(dockerfiles.some(f => f.path.includes('scheduler'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EC2/nginx preset generate() — Caddy (default)
// ---------------------------------------------------------------------------

describe('EC2/nginx preset: generate() with Caddy', () => {
  const preset = createEc2NginxPreset();

  it('has name "ec2-nginx"', () => {
    expect(preset.name).toBe('ec2-nginx');
  });

  it('generates a Dockerfile', () => {
    const files = preset.generate(makeContext());
    const dockerfiles = files.filter(f => f.path.startsWith('Dockerfile'));
    expect(dockerfiles.length).toBeGreaterThanOrEqual(1);
    expect(dockerfiles[0].content).toContain('FROM');
  });

  it('generates docker-compose.yml', () => {
    const files = preset.generate(makeContext());
    const compose = files.find(f => f.path === 'docker-compose.yml');
    expect(compose).toBeDefined();
    expect(compose!.content).toContain('services:');
    expect(compose!.ephemeral).toBe(true);
  });

  it('generates a Caddyfile (default proxy)', () => {
    const files = preset.generate(makeContext());
    const caddy = files.find(f => f.path === 'Caddyfile');
    expect(caddy).toBeDefined();
    expect(caddy!.ephemeral).toBe(true);
  });

  it('does not generate nginx.conf with Caddy proxy', () => {
    const files = preset.generate(makeContext());
    const nginx = files.find(f => f.path === 'nginx.conf');
    expect(nginx).toBeUndefined();
  });

  it('generates a GitHub Actions workflow', () => {
    const files = preset.generate(makeContext());
    const gha = files.find(f => f.path.includes('.github/workflows/'));
    expect(gha).toBeDefined();
    expect(gha!.content).toContain('docker');
    expect(gha!.ephemeral).toBe(true);
  });

  it('defaultLogging returns local with 14 day retention', () => {
    expect(preset.defaultLogging()).toEqual({ driver: 'local', retentionDays: 14 });
  });
});

// ---------------------------------------------------------------------------
// EC2/nginx preset generate() — nginx mode
// ---------------------------------------------------------------------------

describe('EC2/nginx preset: generate() with nginx', () => {
  const preset = createEc2NginxPreset({ proxy: 'nginx' });

  it('generates nginx.conf instead of Caddyfile', () => {
    const ctx = makeContext({
      infra: {
        stacks: ['main'],
        port: 3000,
        size: 'small',
        healthCheck: '/health',
        domain: 'api.example.com',
      } as never,
    });
    const files = preset.generate(ctx);
    const nginx = files.find(f => f.path === 'nginx.conf');
    expect(nginx).toBeDefined();
    expect(nginx!.content).toContain('upstream');
    expect(nginx!.content).toContain('server');

    const caddy = files.find(f => f.path === 'Caddyfile');
    expect(caddy).toBeUndefined();
  });

  it('docker-compose includes nginx service', () => {
    const files = preset.generate(makeContext());
    const compose = files.find(f => f.path === 'docker-compose.yml');
    expect(compose!.content).toContain('nginx');
  });
});

// ---------------------------------------------------------------------------
// EC2/nginx preset with multi-service infra
// ---------------------------------------------------------------------------

describe('EC2/nginx preset: multi-service', () => {
  const preset = createEc2NginxPreset();

  it('generates Dockerfiles for each service on the stack', () => {
    const ctx = makeContext({
      infra: {
        stacks: ['main'],
        port: 3000,
        size: 'small',
        healthCheck: '/health',
        services: {
          api: { port: 3000, stacks: ['main'] },
          worker: { port: 4000, stacks: ['main'] },
          scheduler: { port: 5000, stacks: ['other'] },
        },
      } as never,
    });
    const files = preset.generate(ctx);
    const dockerfiles = files.filter(f => f.path.startsWith('Dockerfile'));
    expect(dockerfiles.length).toBe(2);
  });

  it('docker-compose includes all services on the stack', () => {
    const ctx = makeContext({
      infra: {
        stacks: ['main'],
        port: 3000,
        size: 'small',
        healthCheck: '/health',
        services: {
          api: { port: 3000, stacks: ['main'], domain: 'api.example.com' },
          worker: { port: 4000, stacks: ['main'] },
        },
      } as never,
    });
    const files = preset.generate(ctx);
    const compose = files.find(f => f.path === 'docker-compose.yml');
    expect(compose!.content).toContain('api');
    expect(compose!.content).toContain('worker');
  });
});

// ---------------------------------------------------------------------------
// EC2/nginx preset with fluentd logging
// ---------------------------------------------------------------------------

describe('EC2/nginx preset: fluentd logging', () => {
  const preset = createEc2NginxPreset();

  it('generates fluentd config when logging driver is fluentd', () => {
    const ctx = makeContext({
      infra: {
        stacks: ['main'],
        port: 3000,
        size: 'small',
        healthCheck: '/health',
        logging: { driver: 'fluentd', fluentd: {} },
      } as never,
    });
    const files = preset.generate(ctx);
    const fluentd = files.find(f => f.path.includes('fluent'));
    expect(fluentd).toBeDefined();
    expect(fluentd!.ephemeral).toBe(true);
  });
});
