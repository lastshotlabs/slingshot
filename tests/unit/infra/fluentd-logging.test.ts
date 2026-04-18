import { describe, expect, it } from 'bun:test';
import { generateDockerCompose } from '../../../packages/slingshot-infra/src/preset/ec2-nginx/generators/dockerCompose';
import { generateFluentdConfig } from '../../../packages/slingshot-infra/src/preset/shared/generateFluentdConfig';
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

describe('Fluentd config generator', () => {
  it('generates fluent.conf when driver is fluentd', () => {
    const result = generateFluentdConfig(undefined, 'myapp');
    expect(result.path).toBe('fluent.conf');
    expect(result.ephemeral).toBe(true);
    expect(result.content).toContain('@type forward');
    expect(result.content).toContain('port 24224');
    expect(result.content).toContain('bind 0.0.0.0');
  });

  it('uses custom endpoint port', () => {
    const result = generateFluentdConfig({ endpoint: '10.0.0.5:24225' }, 'myapp');
    expect(result.content).toContain('port 24225');
  });

  it('uses default tag prefix from app name', () => {
    const result = generateFluentdConfig(undefined, 'myapp');
    expect(result.content).toContain('<match myapp.**>');
  });

  it('uses custom tag prefix', () => {
    const result = generateFluentdConfig({ tagPrefix: 'custom-prefix' }, 'myapp');
    expect(result.content).toContain('<match custom-prefix.**>');
  });

  it('generates stdout output by default when no outputs specified', () => {
    const result = generateFluentdConfig(undefined, 'myapp');
    expect(result.content).toContain('@type stdout');
  });

  it('generates elasticsearch output', () => {
    const result = generateFluentdConfig(
      {
        outputs: [
          {
            type: 'elasticsearch',
            config: { host: 'es.internal', port: '9200' },
          },
        ],
      },
      'myapp',
    );
    expect(result.content).toContain('@type elasticsearch');
    expect(result.content).toContain('host es.internal');
    expect(result.content).toContain('logstash_format true');
    expect(result.content).toContain('logstash_prefix myapp');
  });

  it('generates multiple outputs', () => {
    const result = generateFluentdConfig(
      {
        outputs: [
          { type: 'elasticsearch' },
          { type: 'stdout' },
          { type: 's3', config: { s3_bucket: 'my-logs', s3_region: 'us-east-1' } },
        ],
      },
      'myapp',
    );
    expect(result.content).toContain('@type elasticsearch');
    expect(result.content).toContain('@type stdout');
    expect(result.content).toContain('@type s3');
    expect(result.content).toContain('s3_bucket my-logs');
  });

  it('generates cloudwatch output', () => {
    const result = generateFluentdConfig(
      {
        outputs: [
          { type: 'cloudwatch', config: { log_group_name: '/ecs/myapp', region: 'us-east-1' } },
        ],
      },
      'myapp',
    );
    expect(result.content).toContain('@type cloudwatch_logs');
    expect(result.content).toContain('log_group_name /ecs/myapp');
  });
});

describe('Docker Compose with fluentd logging', () => {
  it('includes fluentd service when driver is fluentd', () => {
    const ctx = createCtx({
      infra: {
        stacks: ['main'],
        domain: 'api.myapp.com',
        port: 3000,
        logging: { driver: 'fluentd' },
      },
    });
    const result = generateDockerCompose(ctx);
    expect(result.content).toContain('fluentd:');
    expect(result.content).toContain('image: fluent/fluentd:v1.16-1');
    expect(result.content).toContain('"24224:24224"');
    expect(result.content).toContain('fluent.conf:/fluentd/etc/fluent.conf:ro');
  });

  it('configures service logging with fluentd driver', () => {
    const ctx = createCtx({
      infra: {
        stacks: ['main'],
        domain: 'api.myapp.com',
        port: 3000,
        logging: { driver: 'fluentd' },
      },
    });
    const result = generateDockerCompose(ctx);
    expect(result.content).toContain('driver: fluentd');
    expect(result.content).toContain('fluentd-address: "localhost:24224"');
    expect(result.content).toContain('tag: "api.api"');
  });

  it('uses custom fluentd endpoint in docker compose', () => {
    const ctx = createCtx({
      infra: {
        stacks: ['main'],
        domain: 'api.myapp.com',
        port: 3000,
        logging: {
          driver: 'fluentd',
          fluentd: { endpoint: '10.0.0.5:24225' },
        },
      },
    });
    const result = generateDockerCompose(ctx);
    expect(result.content).toContain('fluentd-address: "10.0.0.5:24225"');
  });

  it('uses custom tag prefix in docker compose', () => {
    const ctx = createCtx({
      infra: {
        stacks: ['main'],
        domain: 'api.myapp.com',
        port: 3000,
        logging: {
          driver: 'fluentd',
          fluentd: { tagPrefix: 'myproject' },
        },
      },
    });
    const result = generateDockerCompose(ctx);
    expect(result.content).toContain('tag: "myproject.api"');
  });

  it('uses json-file logging when driver is not fluentd', () => {
    const ctx = createCtx({
      infra: {
        stacks: ['main'],
        domain: 'api.myapp.com',
        port: 3000,
        logging: { driver: 'local' },
      },
    });
    const result = generateDockerCompose(ctx);
    expect(result.content).toContain('driver: json-file');
    expect(result.content).not.toContain('fluentd:');
  });

  it('adds depends_on fluentd for services', () => {
    const ctx = createCtx({
      infra: {
        stacks: ['main'],
        domain: 'api.myapp.com',
        port: 3000,
        logging: { driver: 'fluentd' },
      },
    });
    const result = generateDockerCompose(ctx);
    expect(result.content).toContain('depends_on:');
    expect(result.content).toContain('- fluentd');
  });
});
