import { describe, expect, it } from 'bun:test';
import { generateInfraTemplate } from '../../../packages/slingshot-infra/src/scaffold/infraTemplate';
import { generatePlatformTemplate } from '../../../packages/slingshot-infra/src/scaffold/platformTemplate';

describe('generatePlatformTemplate', () => {
  it('includes definePlatform import', () => {
    const result = generatePlatformTemplate();
    expect(result).toContain("import { definePlatform } from '@lastshotlabs/slingshot-infra'");
  });

  it('includes all required config sections', () => {
    const result = generatePlatformTemplate();
    expect(result).toContain('org:');
    expect(result).toContain('provider:');
    expect(result).toContain('region:');
    expect(result).toContain('registry:');
    expect(result).toContain('stages:');
    expect(result).toContain('stacks:');
  });

  it('applies custom org and region', () => {
    const result = generatePlatformTemplate({ org: 'acme', region: 'eu-west-1' });
    expect(result).toContain("org: 'acme'");
    expect(result).toContain("region: 'eu-west-1'");
  });

  it('applies custom preset', () => {
    const result = generatePlatformTemplate({ preset: 'ec2-nginx' });
    expect(result).toContain("preset: 'ec2-nginx'");
  });

  it('includes selected resources when provided', () => {
    const result = generatePlatformTemplate({ resources: ['postgres', 'redis'] });
    expect(result).toContain('resources: {');
    expect(result).toContain('postgres: {');
    expect(result).toContain("type: 'postgres'");
    expect(result).toContain('redis: {');
    expect(result).toContain("type: 'redis'");
  });

  it('uses sensible defaults when no options provided', () => {
    const result = generatePlatformTemplate();
    expect(result).toContain("org: 'myorg'");
    expect(result).toContain("region: 'us-east-1'");
    expect(result).toContain("preset: 'ecs'");
    expect(result).toContain("provider: 'local'");
  });

  it('contains export default', () => {
    const result = generatePlatformTemplate();
    expect(result).toContain('export default definePlatform(');
  });

  it('includes inline comments', () => {
    const result = generatePlatformTemplate();
    expect(result).toContain('// ---');
  });
});

describe('generateInfraTemplate', () => {
  it('includes defineInfra import', () => {
    const result = generateInfraTemplate();
    expect(result).toContain("import { defineInfra } from '@lastshotlabs/slingshot-infra'");
  });

  it('includes all required config sections', () => {
    const result = generateInfraTemplate();
    expect(result).toContain('stacks:');
    expect(result).toContain('size:');
    expect(result).toContain('port:');
    expect(result).toContain('healthCheck:');
  });

  it('includes uses array with comment about resources', () => {
    const result = generateInfraTemplate();
    expect(result).toContain('uses: []');
    expect(result).toContain('resource');
  });

  it('applies custom stacks', () => {
    const result = generateInfraTemplate({ stacks: ['web', 'worker'] });
    expect(result).toContain("stacks: ['web', 'worker']");
  });

  it('applies custom port', () => {
    const result = generateInfraTemplate({ port: 8080 });
    expect(result).toContain('port: 8080');
  });

  it('uses sensible defaults when no options provided', () => {
    const result = generateInfraTemplate();
    expect(result).toContain("stacks: ['main']");
    expect(result).toContain('port: 3000');
    expect(result).toContain("size: 'small'");
    expect(result).toContain("healthCheck: '/health'");
  });

  it('contains export default', () => {
    const result = generateInfraTemplate();
    expect(result).toContain('export default defineInfra(');
  });
});
