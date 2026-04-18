import { describe, expect, it } from 'bun:test';
import { generateNginxConfig } from '../../../packages/slingshot-infra/src/preset/ec2-nginx/generators/nginx';
import type { NginxConfig } from '../../../packages/slingshot-infra/src/types/infra';
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

function createCtxWithNginx(nginx: NginxConfig, extra?: Partial<PresetContext>): PresetContext {
  return createCtx({
    infra: {
      stacks: ['main'],
      domain: 'api.myapp.com',
      port: 3000,
      nginx,
    },
    ...extra,
  });
}

describe('Nginx directives generator', () => {
  describe('gzip', () => {
    it('generates gzip on by default', () => {
      const result = generateNginxConfig(createCtx());
      expect(result.content).toContain('gzip on;');
      expect(result.content).toContain('gzip_comp_level 6;');
      expect(result.content).toContain('gzip_min_length 1k;');
      expect(result.content).toContain('gzip_vary on;');
      expect(result.content).toContain('text/plain');
      expect(result.content).toContain('application/json');
    });

    it('omits gzip block when gzip: false', () => {
      const result = generateNginxConfig(createCtxWithNginx({ gzip: false }));
      expect(result.content).not.toContain('gzip on;');
      expect(result.content).not.toContain('gzip_comp_level');
      // Section markers should still be present
      expect(result.content).toContain('# --- section:gzip ---');
      expect(result.content).toContain('# --- end:gzip ---');
    });

    it('uses custom gzip level and types', () => {
      const result = generateNginxConfig(
        createCtxWithNginx({
          gzip: {
            level: 9,
            minLength: '256',
            types: ['text/html', 'image/svg+xml'],
          },
        }),
      );
      expect(result.content).toContain('gzip_comp_level 9;');
      expect(result.content).toContain('gzip_min_length 256;');
      expect(result.content).toContain('gzip_types text/html image/svg+xml;');
    });
  });

  describe('rate limiting', () => {
    it('does not include rate limiting by default', () => {
      const result = generateNginxConfig(createCtx());
      expect(result.content).not.toContain('limit_req_zone');
      expect(result.content).not.toContain('limit_req zone');
    });

    it('generates rate limiting zone and limit_req directives', () => {
      const result = generateNginxConfig(
        createCtxWithNginx({
          rateLimit: { requestsPerSecond: 5, burst: 10, zone: 'my_zone' },
        }),
      );
      expect(result.content).toContain(
        'limit_req_zone $binary_remote_addr zone=my_zone:10m rate=5r/s;',
      );
      expect(result.content).toContain('limit_req zone=my_zone burst=10 nodelay;');
    });

    it('uses default rate limit values', () => {
      const result = generateNginxConfig(
        createCtxWithNginx({
          rateLimit: {},
        }),
      );
      expect(result.content).toContain('zone=api_limit:10m rate=10r/s;');
      expect(result.content).toContain('limit_req zone=api_limit burst=20 nodelay;');
    });
  });

  describe('WebSocket', () => {
    it('does not include WebSocket headers by default', () => {
      const result = generateNginxConfig(createCtx());
      expect(result.content).not.toContain('proxy_http_version 1.1;');
      expect(result.content).not.toContain('Upgrade');
      expect(result.content).not.toContain('"upgrade"');
    });

    it('includes WebSocket headers when enabled', () => {
      const result = generateNginxConfig(createCtxWithNginx({ websocket: true }));
      expect(result.content).toContain('proxy_http_version 1.1;');
      expect(result.content).toContain('proxy_set_header Upgrade $http_upgrade;');
      expect(result.content).toContain('proxy_set_header Connection "upgrade";');
    });
  });

  describe('static files', () => {
    it('does not include static files location by default', () => {
      const result = generateNginxConfig(createCtx());
      expect(result.content).not.toContain('alias');
      expect(result.content).not.toContain('# --- section:static-files ---');
    });

    it('generates static files location with cache control', () => {
      const result = generateNginxConfig(
        createCtxWithNginx({
          staticFiles: {
            urlPath: '/static/',
            fsPath: '/app/public/',
            cacheControl: '30d',
          },
        }),
      );
      expect(result.content).toContain('location /static/');
      expect(result.content).toContain('alias /app/public/;');
      expect(result.content).toContain('expires 30d;');
      expect(result.content).toContain('add_header Cache-Control "public, immutable";');
      expect(result.content).toContain('# --- section:static-files ---');
      expect(result.content).toContain('# --- end:static-files ---');
    });

    it('generates static files without cache control', () => {
      const result = generateNginxConfig(
        createCtxWithNginx({
          staticFiles: {
            urlPath: '/assets/',
            fsPath: '/app/dist/',
          },
        }),
      );
      expect(result.content).toContain('location /assets/');
      expect(result.content).toContain('alias /app/dist/;');
      expect(result.content).not.toContain('expires');
      expect(result.content).not.toContain('Cache-Control');
    });
  });

  describe('client body size', () => {
    it('defaults to 10m', () => {
      const result = generateNginxConfig(createCtx());
      expect(result.content).toContain('client_max_body_size 10m;');
    });

    it('uses custom clientMaxBodySize', () => {
      const result = generateNginxConfig(
        createCtxWithNginx({
          clientMaxBodySize: '50m',
        }),
      );
      expect(result.content).toContain('client_max_body_size 50m;');
    });
  });

  describe('timeouts', () => {
    it('generates default timeouts', () => {
      const result = generateNginxConfig(createCtx());
      expect(result.content).toContain('proxy_connect_timeout 60s;');
      expect(result.content).toContain('proxy_read_timeout 60s;');
      expect(result.content).toContain('proxy_send_timeout 60s;');
      expect(result.content).toContain('keepalive_timeout 65s;');
    });

    it('uses custom timeouts', () => {
      const result = generateNginxConfig(
        createCtxWithNginx({
          timeouts: {
            connect: '30s',
            read: '120s',
            send: '90s',
            keepalive: '75s',
          },
        }),
      );
      expect(result.content).toContain('proxy_connect_timeout 30s;');
      expect(result.content).toContain('proxy_read_timeout 120s;');
      expect(result.content).toContain('proxy_send_timeout 90s;');
      expect(result.content).toContain('keepalive_timeout 75s;');
    });
  });

  describe('load balancing', () => {
    it('defaults to round-robin (no directive)', () => {
      const result = generateNginxConfig(createCtx());
      expect(result.content).toContain('upstream api');
      expect(result.content).not.toContain('least_conn;');
      expect(result.content).not.toContain('ip_hash;');
    });

    it('generates least-conn strategy', () => {
      const result = generateNginxConfig(
        createCtxWithNginx({
          loadBalancing: 'least-conn',
        }),
      );
      expect(result.content).toContain('least_conn;');
    });

    it('generates ip-hash strategy', () => {
      const result = generateNginxConfig(
        createCtxWithNginx({
          loadBalancing: 'ip-hash',
        }),
      );
      expect(result.content).toContain('ip_hash;');
    });

    it('upstream block always contains server directive', () => {
      const result = generateNginxConfig(createCtx());
      expect(result.content).toContain('server api:3000;');
    });
  });

  describe('custom directives', () => {
    it('injects custom directives into http block', () => {
      const result = generateNginxConfig(
        createCtxWithNginx({
          customDirectives: ['proxy_buffer_size 128k;', 'proxy_buffers 4 256k;'],
        }),
      );
      expect(result.content).toContain('proxy_buffer_size 128k;');
      expect(result.content).toContain('proxy_buffers 4 256k;');
      expect(result.content).toContain('# --- section:custom-directives ---');
      expect(result.content).toContain('# --- end:custom-directives ---');
    });

    it('does not include custom directives section when empty', () => {
      const result = generateNginxConfig(createCtx());
      expect(result.content).not.toContain('# --- section:custom-directives ---');
    });
  });

  describe('SSL + all directives combined', () => {
    it('generates full SSL config with all directives', () => {
      const ctx = createCtxWithNginx({
        loadBalancing: 'least-conn',
        websocket: true,
        gzip: { level: 8, types: ['text/plain', 'application/json'] },
        rateLimit: { requestsPerSecond: 20, burst: 40 },
        staticFiles: { urlPath: '/static/', fsPath: '/app/public/', cacheControl: '7d' },
        clientMaxBodySize: '25m',
        timeouts: { connect: '30s', read: '120s', send: '60s', keepalive: '70s' },
        customDirectives: ['add_header X-Frame-Options DENY;'],
      });

      const result = generateNginxConfig(ctx);

      // SSL blocks
      expect(result.content).toContain('listen 443 ssl http2;');
      expect(result.content).toContain('ssl_certificate');
      expect(result.content).toContain('ssl_protocols TLSv1.2 TLSv1.3;');
      expect(result.content).toContain('return 301 https://$host$request_uri;');
      expect(result.content).toContain('acme-challenge');

      // Gzip
      expect(result.content).toContain('gzip_comp_level 8;');

      // Rate limiting
      expect(result.content).toContain('rate=20r/s;');
      expect(result.content).toContain('burst=40 nodelay;');

      // WebSocket
      expect(result.content).toContain('proxy_http_version 1.1;');

      // Static files
      expect(result.content).toContain('location /static/');
      expect(result.content).toContain('expires 7d;');

      // Body size
      expect(result.content).toContain('client_max_body_size 25m;');

      // Timeouts
      expect(result.content).toContain('proxy_connect_timeout 30s;');
      expect(result.content).toContain('proxy_read_timeout 120s;');

      // Load balancing
      expect(result.content).toContain('least_conn;');

      // Custom directives
      expect(result.content).toContain('add_header X-Frame-Options DENY;');

      // Upstream
      expect(result.content).toContain('upstream api');
      expect(result.content).toContain('proxy_pass http://api;');

      // Section markers
      expect(result.content).toContain('# --- section:events ---');
      expect(result.content).toContain('# --- section:http ---');
      expect(result.content).toContain('# --- section:gzip ---');
      expect(result.content).toContain('# --- section:proxy ---');
      expect(result.content).toContain('# --- section:upstream-api ---');
    });
  });

  describe('HTTP-only mode', () => {
    it('generates HTTP-only config with all directives', () => {
      const ctx = createCtx({
        infra: {
          stacks: ['main'],
          domain: 'api.myapp.com',
          port: 3000,
          domains: {
            api: { stages: { prod: 'api.myapp.com' }, ssl: false },
          },
          nginx: {
            websocket: true,
            rateLimit: { requestsPerSecond: 10 },
            staticFiles: { urlPath: '/assets/', fsPath: '/app/dist/', cacheControl: '1h' },
          },
        },
      });

      const result = generateNginxConfig(ctx);

      // No SSL blocks
      expect(result.content).not.toContain('listen 443');
      expect(result.content).not.toContain('ssl_certificate');
      expect(result.content).not.toContain('return 301 https://');

      // HTTP server
      expect(result.content).toContain('listen 80;');
      expect(result.content).toContain('server_name api.myapp.com;');

      // All directives still present
      expect(result.content).toContain('proxy_http_version 1.1;');
      expect(result.content).toContain('limit_req zone=');
      expect(result.content).toContain('location /assets/');
      expect(result.content).toContain('expires 1h;');
    });
  });

  describe('structure', () => {
    it('generates nginx.conf path', () => {
      const result = generateNginxConfig(createCtx());
      expect(result.path).toBe('nginx.conf');
      expect(result.ephemeral).toBe(true);
    });

    it('includes standard proxy headers', () => {
      const result = generateNginxConfig(createCtx());
      expect(result.content).toContain('proxy_set_header Host $host;');
      expect(result.content).toContain('proxy_set_header X-Real-IP $remote_addr;');
      expect(result.content).toContain(
        'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      );
      expect(result.content).toContain('proxy_set_header X-Forwarded-Proto $scheme;');
    });

    it('includes section markers for override support', () => {
      const result = generateNginxConfig(createCtx());
      expect(result.content).toContain('# --- section:events ---');
      expect(result.content).toContain('# --- end:events ---');
      expect(result.content).toContain('# --- section:http ---');
      expect(result.content).toContain('# --- end:http ---');
      expect(result.content).toContain('# --- section:server-api ---');
      expect(result.content).toContain('# --- end:server-api ---');
      expect(result.content).toContain('# --- section:upstream-api ---');
      expect(result.content).toContain('# --- end:upstream-api ---');
      expect(result.content).toContain('# --- section:gzip ---');
      expect(result.content).toContain('# --- end:gzip ---');
      expect(result.content).toContain('# --- section:client-body ---');
      expect(result.content).toContain('# --- end:client-body ---');
      expect(result.content).toContain('# --- section:timeouts ---');
      expect(result.content).toContain('# --- end:timeouts ---');
      expect(result.content).toContain('# --- section:proxy ---');
      expect(result.content).toContain('# --- end:proxy ---');
    });
  });
});
