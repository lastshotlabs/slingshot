import { describe, expect, it } from 'bun:test';
import { generateCaddyfile } from '../../../packages/slingshot-infra/src/preset/ec2-nginx/generators/caddy';
import { generateDockerCompose } from '../../../packages/slingshot-infra/src/preset/ec2-nginx/generators/dockerCompose';
import { generateEc2Dockerfile } from '../../../packages/slingshot-infra/src/preset/ec2-nginx/generators/dockerfile';
import { generateDockerfiles } from '../../../packages/slingshot-infra/src/preset/ecs/generators/dockerfile';
import { generateSstConfig } from '../../../packages/slingshot-infra/src/preset/ecs/generators/sst';
import type { PresetContext } from '../../../packages/slingshot-infra/src/types/preset';

function createCtx(overrides?: Partial<PresetContext>): PresetContext {
  return {
    platform: {
      org: 'testorg',
      provider: 'aws',
      region: 'us-east-1',
      registry: { provider: 'local', path: '/tmp/test.json' },
      stages: { prod: {} },
    },
    infra: {
      stacks: ['main'],
      domain: 'api.myapp.com',
      port: 3000,
    },
    stage: {},
    stageName: 'prod',
    stack: { preset: 'ecs' },
    stackName: 'main',
    registry: {
      version: 1,
      platform: 'test',
      updatedAt: '',
      stacks: {},
      resources: {},
      services: {},
    },
    resolvedEnv: { NODE_ENV: 'production', DATABASE_URL: 'postgres://localhost/db' },
    appRoot: '/app',
    serviceName: 'api',
    imageTag: '20260330-120000-abc1',
    dockerRegistry: 'testorg',
    ...overrides,
  };
}

describe('ECS Dockerfile generator', () => {
  it('generates a valid Dockerfile', () => {
    const results = generateDockerfiles(createCtx());
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.path).toBe('Dockerfile.api');
    expect(result.ephemeral).toBe(true);
    expect(result.content).toContain('FROM oven/bun:1');
    expect(result.content).toContain('EXPOSE 3000');
    expect(result.content).toContain('CMD ["bun"');
  });

  it('generates per-service Dockerfiles for multi-service', () => {
    const results = generateDockerfiles(
      createCtx({
        infra: {
          stacks: ['main'],
          services: {
            api: { path: 'apps/api', stacks: ['main'], port: 4000 },
            ws: { path: 'apps/ws', stacks: ['main'], port: 5000 },
          },
        },
        stackName: 'main',
      }),
    );
    expect(results).toHaveLength(2);
    expect(results[0].path).toBe('Dockerfile.api');
    expect(results[0].content).toContain('EXPOSE 4000');
    expect(results[1].path).toBe('Dockerfile.ws');
    expect(results[1].content).toContain('EXPOSE 5000');
  });

  it('includes section markers for overrides', () => {
    const results = generateDockerfiles(createCtx());
    expect(results[0].content).toContain('# --- section:base ---');
    expect(results[0].content).toContain('# --- end:base ---');
    expect(results[0].content).toContain('# --- section:run ---');
    expect(results[0].content).toContain('# --- end:run ---');
  });
});

describe('SST config generator', () => {
  it('generates SST config with domain', () => {
    const result = generateSstConfig(createCtx());
    expect(result.path).toBe('sst.config.ts');
    expect(result.ephemeral).toBe(true);
    expect(result.content).toContain('api.myapp.com');
    expect(result.content).toContain('testorg-main');
    expect(result.content).toContain('NODE_ENV: "production"');
    expect(result.content).toContain('DATABASE_URL:');
  });

  it('applies size preset', () => {
    const result = generateSstConfig(
      createCtx({
        infra: { stacks: ['main'], size: 'large' },
      }),
    );
    expect(result.content).toContain('1 vCPU');
    expect(result.content).toContain('2 GB');
  });

  it('generates multi-service SST config', () => {
    const result = generateSstConfig(
      createCtx({
        infra: {
          stacks: ['main'],
          services: {
            api: { path: 'apps/api', stacks: ['main'], domain: 'api.myapp.com', port: 3000 },
            ws: { path: 'apps/ws', stacks: ['main'], domain: 'ws.myapp.com', port: 4000 },
          },
        },
        resolvedEnv: {
          api: { NODE_ENV: 'production', DB_URL: 'pg://localhost' },
          ws: { NODE_ENV: 'production', REDIS_URL: 'redis://localhost' },
        },
        stackName: 'main',
      }),
    );
    expect(result.content).toContain('addService("api"');
    expect(result.content).toContain('addService("ws"');
    expect(result.content).toContain('api.myapp.com');
    expect(result.content).toContain('ws.myapp.com');
    expect(result.content).toContain('DB_URL:');
    expect(result.content).toContain('REDIS_URL:');
  });
});

describe('EC2 Dockerfile generator', () => {
  it('generates Alpine-based Dockerfile', () => {
    const result = generateEc2Dockerfile(createCtx());
    expect(result.content).toContain('oven/bun:1-alpine');
    expect(result.path).toContain('Dockerfile.');
  });
});

describe('Docker Compose generator', () => {
  it('generates compose with Caddy and service', () => {
    const result = generateDockerCompose(createCtx());
    expect(result.path).toBe('docker-compose.yml');
    expect(result.content).toContain('caddy:');
    expect(result.content).toContain('caddy:2-alpine');
    expect(result.content).toContain('api:');
    expect(result.content).toContain('NODE_ENV: "production"');
    expect(result.content).toContain('max-size: "50m"');
  });

  it('generates compose for multi-service', () => {
    const result = generateDockerCompose(
      createCtx({
        infra: {
          stacks: ['main'],
          services: {
            api: { path: 'apps/api', stacks: ['main'], domain: 'api.myapp.com', port: 3000 },
            admin: { path: 'apps/admin', stacks: ['main'], domain: 'admin.myapp.com', port: 3001 },
          },
        },
        stackName: 'main',
      }),
    );
    expect(result.content).toContain('api:');
    expect(result.content).toContain('admin:');
  });
});

describe('Caddyfile generator', () => {
  it('generates Caddyfile with domain routing', () => {
    const result = generateCaddyfile(createCtx());
    expect(result.path).toBe('Caddyfile');
    expect(result.content).toContain('api.myapp.com');
    expect(result.content).toContain('reverse_proxy');
    expect(result.content).toContain('encode gzip');
  });

  it('generates multi-service Caddyfile', () => {
    const result = generateCaddyfile(
      createCtx({
        infra: {
          stacks: ['main'],
          services: {
            api: { path: 'apps/api', stacks: ['main'], domain: 'api.myapp.com', port: 3000 },
            admin: { path: 'apps/admin', stacks: ['main'], domain: 'admin.myapp.com', port: 3001 },
          },
        },
        stackName: 'main',
      }),
    );
    expect(result.content).toContain('api.myapp.com');
    expect(result.content).toContain('admin.myapp.com');
    expect(result.content).toContain('reverse_proxy api:3000');
    expect(result.content).toContain('reverse_proxy admin:3001');
  });
});
