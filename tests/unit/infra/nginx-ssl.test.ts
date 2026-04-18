import { describe, expect, it } from 'bun:test';
import { generateDockerCompose } from '../../../packages/slingshot-infra/src/preset/ec2-nginx/generators/dockerCompose';
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

describe('Nginx SSL generator', () => {
  it('default config with domain generates SSL blocks', () => {
    const result = generateNginxConfig(createCtx());
    expect(result.path).toBe('nginx.conf');
    expect(result.ephemeral).toBe(true);
    expect(result.content).toContain('listen 443 ssl http2');
    expect(result.content).toContain(
      'ssl_certificate /etc/letsencrypt/live/api.myapp.com/fullchain.pem',
    );
    expect(result.content).toContain(
      'ssl_certificate_key /etc/letsencrypt/live/api.myapp.com/privkey.pem',
    );
    // HTTP block should redirect to HTTPS
    expect(result.content).toContain('return 301 https://$host$request_uri');
  });

  it('ssl: false on domain generates HTTP-only block', () => {
    const result = generateNginxConfig(
      createCtx({
        infra: {
          stacks: ['main'],
          domain: 'api.myapp.com',
          port: 3000,
          domains: {
            api: { stages: { prod: 'api.myapp.com' }, ssl: false },
          },
        },
      }),
    );
    expect(result.content).toContain('listen 80');
    expect(result.content).not.toContain('listen 443');
    expect(result.content).not.toContain('ssl_certificate');
    expect(result.content).toContain('upstream api');
    expect(result.content).toContain('server api:3000');
    expect(result.content).toContain('proxy_pass http://api');
  });

  it('uses custom cert/key paths when provided', () => {
    const result = generateNginxConfig(createCtx(), {
      certPath: '/custom/cert.pem',
      keyPath: '/custom/key.pem',
    });
    expect(result.content).toContain('ssl_certificate /custom/cert.pem');
    expect(result.content).toContain('ssl_certificate_key /custom/key.pem');
  });

  it('ACME challenge location present in HTTP block for SSL domains', () => {
    const result = generateNginxConfig(createCtx());
    expect(result.content).toContain('location /.well-known/acme-challenge/');
    expect(result.content).toContain('root /var/www/certbot');
  });

  it('SSL protocols and ciphers configured', () => {
    const result = generateNginxConfig(createCtx());
    expect(result.content).toContain('ssl_protocols TLSv1.2 TLSv1.3');
    expect(result.content).toContain('ssl_ciphers HIGH:!aNULL:!MD5');
    expect(result.content).toContain('ssl_prefer_server_ciphers on');
    expect(result.content).toContain('ssl_session_cache shared:SSL:10m');
    expect(result.content).toContain('ssl_session_timeout 10m');
  });

  it('multiple services each get their own SSL blocks', () => {
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
    // Both services get SSL blocks
    expect(result.content).toContain('server_name api.myapp.com');
    expect(result.content).toContain('server_name admin.myapp.com');
    expect(result.content).toContain(
      'ssl_certificate /etc/letsencrypt/live/api.myapp.com/fullchain.pem',
    );
    expect(result.content).toContain(
      'ssl_certificate /etc/letsencrypt/live/admin.myapp.com/fullchain.pem',
    );
    expect(result.content).toContain('upstream api');
    expect(result.content).toContain('server api:3000');
    expect(result.content).toContain('upstream admin');
    expect(result.content).toContain('server admin:3001');
    // Section markers for both
    expect(result.content).toContain('# --- section:server-api ---');
    expect(result.content).toContain('# --- end:server-api ---');
    expect(result.content).toContain('# --- section:server-admin ---');
    expect(result.content).toContain('# --- end:server-admin ---');
  });

  it('keeps section markers for override support', () => {
    const result = generateNginxConfig(createCtx());
    expect(result.content).toContain('# --- section:events ---');
    expect(result.content).toContain('# --- end:events ---');
    expect(result.content).toContain('# --- section:http ---');
    expect(result.content).toContain('# --- end:http ---');
    expect(result.content).toContain('# --- section:server-api ---');
    expect(result.content).toContain('# --- end:server-api ---');
  });
});

describe('Docker Compose with certbot', () => {
  it('certbot service added to docker compose when enabled', () => {
    const result = generateDockerCompose(createCtx(), { nginx: true, certbot: true });
    expect(result.content).toContain('nginx:');
    expect(result.content).toContain('image: nginx:alpine');
    expect(result.content).toContain('certbot:');
    expect(result.content).toContain('image: certbot/certbot');
    expect(result.content).toContain('certbot_data:');
    expect(result.content).toContain('certbot_certs:');
    // Shared volumes between nginx and certbot
    expect(result.content).toContain('certbot_data:/var/www/certbot:ro');
    expect(result.content).toContain('certbot_certs:/etc/letsencrypt:ro');
    // Should not contain caddy
    expect(result.content).not.toContain('caddy:');
  });

  it('nginx without certbot has no certbot service', () => {
    const result = generateDockerCompose(createCtx(), { nginx: true, certbot: false });
    expect(result.content).toContain('nginx:');
    expect(result.content).toContain('image: nginx:alpine');
    expect(result.content).not.toContain('certbot:');
    expect(result.content).not.toContain('certbot_data:');
  });

  it('default (no proxy opts) still generates caddy', () => {
    const result = generateDockerCompose(createCtx());
    expect(result.content).toContain('caddy:');
    expect(result.content).toContain('caddy:2-alpine');
    expect(result.content).not.toContain('nginx:');
  });
});
