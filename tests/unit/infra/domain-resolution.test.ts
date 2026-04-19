import { describe, expect, it } from 'bun:test';
import { resolveDomain } from '../../../packages/slingshot-infra/src/preset/resolveDomain';
import type { DomainConfig } from '../../../packages/slingshot-infra/src/types/infra';
import type { StageConfig } from '../../../packages/slingshot-infra/src/types/platform';

describe('resolveDomain', () => {
  it('stage-specific domain from DomainConfig takes priority', () => {
    const domainConfig: DomainConfig = {
      stages: { staging: 'staging-api.myapp.com', prod: 'api.myapp.com' },
    };
    const stage: StageConfig = { domainSuffix: '.staging.myapp.com' };

    const result = resolveDomain('api.myapp.com', 'staging', stage, domainConfig);
    expect(result).toBe('staging-api.myapp.com');
  });

  it('stage-specific domain for prod takes priority over base domain', () => {
    const domainConfig: DomainConfig = {
      stages: { prod: 'custom-prod.myapp.com' },
    };
    const stage: StageConfig = {};

    const result = resolveDomain('api.myapp.com', 'prod', stage, domainConfig);
    expect(result).toBe('custom-prod.myapp.com');
  });

  it('domainSuffix applied for non-prod stages', () => {
    const stage: StageConfig = { domainSuffix: '.dev.myapp.com' };

    const result = resolveDomain('api.myapp.com', 'dev', stage);
    expect(result).toBe('api.dev.myapp.com');
  });

  it('prod stage applies domainSuffix when explicitly declared', () => {
    const stage: StageConfig = { domainSuffix: '.prod.myapp.com' };

    const result = resolveDomain('api.myapp.com', 'prod', stage);
    expect(result).toBe('api.prod.myapp.com');
  });

  it('subdomain extraction with suffix application', () => {
    const stage: StageConfig = { domainSuffix: '.staging.example.io' };

    const result = resolveDomain('admin.example.com', 'staging', stage);
    expect(result).toBe('admin.staging.example.io');
  });

  it('base domain without subdomain gets suffix appended', () => {
    const stage: StageConfig = { domainSuffix: '.staging.myapp.com' };

    const result = resolveDomain('myapp', 'staging', stage);
    expect(result).toBe('myapp.staging.myapp.com');
  });

  it('returns base domain when no suffix and no domainConfig', () => {
    const stage: StageConfig = {};

    const result = resolveDomain('api.myapp.com', 'dev', stage);
    expect(result).toBe('api.myapp.com');
  });

  it('returns base domain for prod even with no domainConfig', () => {
    const stage: StageConfig = {};

    const result = resolveDomain('api.myapp.com', 'prod', stage);
    expect(result).toBe('api.myapp.com');
  });

  it('domainConfig with no matching stage falls through to suffix', () => {
    const domainConfig: DomainConfig = { stages: { prod: 'api.myapp.com' } };
    const stage: StageConfig = { domainSuffix: '.dev.myapp.com' };

    const result = resolveDomain('api.myapp.com', 'dev', stage, domainConfig);
    expect(result).toBe('api.dev.myapp.com');
  });

  it('domainConfig with no matching stage and no suffix returns base', () => {
    const domainConfig: DomainConfig = { stages: { prod: 'api.myapp.com' } };
    const stage: StageConfig = {};

    const result = resolveDomain('api.myapp.com', 'dev', stage, domainConfig);
    expect(result).toBe('api.myapp.com');
  });
});
