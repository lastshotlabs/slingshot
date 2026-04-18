import { describe, expect, it } from 'bun:test';
import { generateNginxConfig } from '../../../packages/slingshot-infra/src/preset/ec2-nginx/generators/nginx';
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
    stack: { preset: 'ec2-nginx' },
    stackName: 'main',
    registry: {
      version: 1,
      platform: 'test',
      updatedAt: '',
      stacks: {},
      resources: {},
      services: {},
    },
    resolvedEnv: { NODE_ENV: 'production' },
    appRoot: '/app',
    serviceName: 'api',
    imageTag: '20260330-120000-abc1',
    dockerRegistry: 'testorg',
    ...overrides,
  };
}

describe('Nginx config generator', () => {
  it('generates nginx.conf with domain routing', () => {
    const result = generateNginxConfig(createCtx());
    expect(result.path).toBe('nginx.conf');
    expect(result.ephemeral).toBe(true);
    expect(result.content).toContain('worker_connections 1024');
    expect(result.content).toContain('server_name api.myapp.com');
    expect(result.content).toContain('upstream api');
    expect(result.content).toContain('server api:3000');
    expect(result.content).toContain('proxy_pass http://api');
    expect(result.content).toContain('proxy_set_header Host $host');
    expect(result.content).toContain('proxy_set_header X-Real-IP $remote_addr');
  });

  it('generates multi-service nginx config', () => {
    const result = generateNginxConfig(
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
    expect(result.content).toContain('server_name api.myapp.com');
    expect(result.content).toContain('server_name admin.myapp.com');
    expect(result.content).toContain('upstream api');
    expect(result.content).toContain('server api:3000');
    expect(result.content).toContain('upstream admin');
    expect(result.content).toContain('server admin:3001');
  });

  it('uses default port 3000 when not specified', () => {
    const result = generateNginxConfig(
      createCtx({
        infra: {
          stacks: ['main'],
          domain: 'app.example.com',
        },
      }),
    );
    expect(result.content).toContain('upstream api');
    expect(result.content).toContain('server api:3000');
  });

  it('includes section markers for override support', () => {
    const result = generateNginxConfig(createCtx());
    expect(result.content).toContain('# --- section:events ---');
    expect(result.content).toContain('# --- end:events ---');
    expect(result.content).toContain('# --- section:http ---');
    expect(result.content).toContain('# --- end:http ---');
    expect(result.content).toContain('# --- section:server-api ---');
    expect(result.content).toContain('# --- end:server-api ---');
  });

  it('filters services by stack', () => {
    const result = generateNginxConfig(
      createCtx({
        infra: {
          stacks: ['main'],
          services: {
            api: { path: 'apps/api', stacks: ['main'], domain: 'api.myapp.com', port: 3000 },
            worker: {
              path: 'apps/worker',
              stacks: ['background'],
              domain: 'worker.myapp.com',
              port: 4000,
            },
          },
        },
        stackName: 'main',
      }),
    );
    expect(result.content).toContain('server_name api.myapp.com');
    expect(result.content).not.toContain('server_name worker.myapp.com');
  });

  it('includes X-Forwarded-For and X-Forwarded-Proto headers', () => {
    const result = generateNginxConfig(createCtx());
    expect(result.content).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for');
    expect(result.content).toContain('proxy_set_header X-Forwarded-Proto $scheme');
  });
});
