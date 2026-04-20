import { describe, expect, it } from 'bun:test';
import { resolvePlatformConfig } from '../src/config/resolvePlatformConfig';
import { deepMerge } from '../src/override/resolveOverrides';
import { createPresetRegistry } from '../src/preset/presetRegistry';
import { resolveDomain } from '../src/preset/resolveDomain';
import { parseSstOutputs } from '../src/resource/provisionViaSst';
import { createProvisionerRegistry } from '../src/resource/provisionerRegistry';
import { generateInfraTemplate } from '../src/scaffold/infraTemplate';
import { generatePlatformTemplate } from '../src/scaffold/platformTemplate';
import { resolveRequiredKeys } from '../src/secrets/resolveRequiredKeys';

/** Cast a value to `never` without triggering object-literal type assertions. */
function asNever<T>(value: T): never {
  return value as never;
}

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

describe('deepMerge', () => {
  it('merges flat objects', () => {
    const result = deepMerge({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('source overrides target for same keys', () => {
    const result = deepMerge({ a: 1 }, { a: 2 });
    expect(result.a).toBe(2);
  });

  it('recursively merges nested objects', () => {
    const result = deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3, d: 4 } });
    expect(result).toEqual({ a: { b: 1, c: 3, d: 4 } });
  });

  it('arrays in source replace arrays in target', () => {
    const result = deepMerge({ a: [1, 2, 3] }, { a: [4, 5] });
    expect(result.a).toEqual([4, 5]);
  });

  it('does not mutate either input', () => {
    const target = { a: { b: 1 } };
    const source = { a: { c: 2 } };
    deepMerge(target, source);
    expect(target).toEqual({ a: { b: 1 } });
    expect(source).toEqual({ a: { c: 2 } });
  });

  it('null in source overrides target', () => {
    const result = deepMerge({ a: { b: 1 } }, { a: null as never });
    expect(result.a).toBeNull();
  });

  it('handles deeply nested merge', () => {
    const result = deepMerge({ a: { b: { c: { d: 1 } } } }, { a: { b: { c: { e: 2 } } } });
    expect(result).toEqual({ a: { b: { c: { d: 1, e: 2 } } } });
  });
});

// ---------------------------------------------------------------------------
// resolveDomain
// ---------------------------------------------------------------------------

describe('resolveDomain', () => {
  it('returns base domain when no suffix or config', () => {
    const result = resolveDomain('api.myapp.com', 'prod', asNever({}));
    expect(result).toBe('api.myapp.com');
  });

  it('applies domainSuffix by extracting subdomain', () => {
    const result = resolveDomain(
      'api.myapp.com',
      'dev',
      asNever({
        domainSuffix: '.dev.myapp.com',
      }),
    );
    expect(result).toBe('api.dev.myapp.com');
  });

  it('concatenates suffix when domain has no dot', () => {
    const result = resolveDomain('localhost', 'dev', asNever({ domainSuffix: '.dev.myapp.com' }));
    expect(result).toBe('localhost.dev.myapp.com');
  });

  it('uses stage-specific domain from domainConfig when present', () => {
    const result = resolveDomain('api.myapp.com', 'prod', asNever({}), {
      stages: { prod: 'api.production.myapp.com' },
    });
    expect(result).toBe('api.production.myapp.com');
  });

  it('domainConfig takes precedence over domainSuffix', () => {
    const result = resolveDomain(
      'api.myapp.com',
      'dev',
      asNever({ domainSuffix: '.dev.myapp.com' }),
      { stages: { dev: 'api.custom-dev.myapp.com' } },
    );
    expect(result).toBe('api.custom-dev.myapp.com');
  });

  it('falls back to suffix when domainConfig has no entry for this stage', () => {
    const result = resolveDomain(
      'api.myapp.com',
      'staging',
      asNever({ domainSuffix: '.staging.myapp.com' }),
      { stages: { prod: 'api.production.myapp.com' } },
    );
    expect(result).toBe('api.staging.myapp.com');
  });

  it('applies domainSuffix even for prod when the stage declares one', () => {
    const result = resolveDomain(
      'api.myapp.com',
      'prod',
      asNever({
        domainSuffix: '.prod.myapp.com',
      }),
    );
    expect(result).toBe('api.prod.myapp.com');
  });
});

// ---------------------------------------------------------------------------
// resolvePlatformConfig
// ---------------------------------------------------------------------------

describe('resolvePlatformConfig', () => {
  const baseConfig = {
    org: 'acme',
    provider: 'aws' as const,
    region: 'us-east-1',
    registry: { provider: 'local' as const, path: '.slingshot/registry.json' },
    stages: { dev: { env: {} } },
    platforms: {
      'client-a': {
        provider: 'aws' as const,
        region: 'eu-west-1',
        registry: { provider: 's3' as const, bucket: 'client-a-registry' },
        stages: { prod: { env: { NODE_ENV: 'production' } } },
      },
    },
  };

  it('returns raw config when no targetPlatform', () => {
    const result = resolvePlatformConfig(baseConfig as never);
    expect(result.region).toBe('us-east-1');
  });

  it('merges platform entry over top-level config', () => {
    const result = resolvePlatformConfig(baseConfig as never, 'client-a');
    expect(result.region).toBe('eu-west-1');
    expect(result.org).toBe('acme');
    expect(result.stages).toEqual({ prod: { env: { NODE_ENV: 'production' } } });
  });

  it('throws for unknown platform name', () => {
    expect(() => resolvePlatformConfig(baseConfig as never, 'unknown')).toThrow(
      'Platform "unknown" not found',
    );
  });

  it('lists available platforms in error message', () => {
    try {
      resolvePlatformConfig(baseConfig as never, 'nope');
    } catch (err: unknown) {
      expect((err as Error).message).toContain('client-a');
    }
  });

  it('says "(none)" when no platforms are defined', () => {
    const noPlatforms = { ...baseConfig, platforms: undefined };
    try {
      resolvePlatformConfig(noPlatforms as never, 'x');
    } catch (err: unknown) {
      expect((err as Error).message).toContain('(none)');
    }
  });

  it('falls back to top-level secrets/resources/defaults when platform entry omits them', () => {
    const config = {
      ...baseConfig,
      secrets: { provider: 'ssm' as const },
      defaults: { preset: 'ecs' },
    };
    const result = resolvePlatformConfig(config as never, 'client-a');
    expect(result.secrets).toEqual({ provider: 'ssm' });
    expect(result.defaults).toEqual({ preset: 'ecs' });
  });
});

// ---------------------------------------------------------------------------
// resolveRequiredKeys
// ---------------------------------------------------------------------------

describe('resolveRequiredKeys', () => {
  it('always includes baseline keys', () => {
    const keys = resolveRequiredKeys({});
    expect(keys).toContain('JWT_SECRET');
    expect(keys).toContain('DATA_ENCRYPTION_KEY');
  });

  it('includes postgres keys for postgres in uses', () => {
    const keys = resolveRequiredKeys({ uses: ['postgres'] });
    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('PGHOST');
  });

  it('includes redis keys for redis in uses', () => {
    const keys = resolveRequiredKeys({ uses: ['redis'] });
    expect(keys).toContain('REDIS_HOST');
  });

  it('collects keys from service-level uses', () => {
    const keys = resolveRequiredKeys({
      services: {
        api: { uses: ['postgres'] },
        worker: { uses: ['redis'] },
      },
    });
    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('REDIS_HOST');
  });

  it('deduplicates keys from multiple sources', () => {
    const keys = resolveRequiredKeys({
      uses: ['redis'],
      services: { api: { uses: ['redis'] } },
    });
    const redisHostCount = keys.filter(k => k === 'REDIS_HOST').length;
    expect(redisHostCount).toBe(1);
  });

  it('skips unknown resource types gracefully', () => {
    const keys = resolveRequiredKeys({ uses: ['unknown-resource'] });
    expect(keys).toContain('JWT_SECRET');
    expect(keys).not.toContain('unknown-resource');
  });
});

// ---------------------------------------------------------------------------
// createPresetRegistry
// ---------------------------------------------------------------------------

describe('createPresetRegistry', () => {
  const fakePreset = (name: string) => {
    const p = { name, generate: () => [], deploy: async () => ({ success: true }) };
    return p as never;
  };

  it('returns registered preset by name', () => {
    const reg = createPresetRegistry([fakePreset('ecs'), fakePreset('ec2-nginx')]);
    expect(reg.get('ecs')).toBeDefined();
    expect(reg.get('ec2-nginx')).toBeDefined();
  });

  it('throws for unknown preset name', () => {
    const reg = createPresetRegistry([fakePreset('ecs')]);
    expect(() => reg.get('unknown')).toThrow('Unknown preset: "unknown"');
  });

  it('lists available preset names', () => {
    const reg = createPresetRegistry([fakePreset('a'), fakePreset('b')]);
    expect(reg.names()).toEqual(['a', 'b']);
  });

  it('error message lists available presets', () => {
    const reg = createPresetRegistry([fakePreset('ecs'), fakePreset('lambda')]);
    try {
      reg.get('x');
    } catch (err: unknown) {
      expect((err as Error).message).toContain('ecs');
      expect((err as Error).message).toContain('lambda');
    }
  });
});

// ---------------------------------------------------------------------------
// createProvisionerRegistry
// ---------------------------------------------------------------------------

describe('createProvisionerRegistry', () => {
  const fakeProvisioner = (type: string) => {
    const p = {
      resourceType: type,
      provision: async () => ({ status: 'provisioned', outputs: {}, connectionEnv: {} }),
      destroy: async () => {},
      getConnectionEnv: () => ({}),
    };
    return p as never;
  };

  it('returns registered provisioner by type', () => {
    const reg = createProvisionerRegistry([fakeProvisioner('postgres'), fakeProvisioner('redis')]);
    expect(reg.get('postgres')).toBeDefined();
  });

  it('throws for unknown resource type', () => {
    const reg = createProvisionerRegistry([fakeProvisioner('postgres')]);
    expect(() => reg.get('unknown')).toThrow('No provisioner for resource type: "unknown"');
  });

  it('lists available resource types', () => {
    const reg = createProvisionerRegistry([fakeProvisioner('postgres'), fakeProvisioner('redis')]);
    expect(reg.types()).toEqual(['postgres', 'redis']);
  });
});

// ---------------------------------------------------------------------------
// generatePlatformTemplate
// ---------------------------------------------------------------------------

describe('generatePlatformTemplate', () => {
  it('generates valid TypeScript with defaults', () => {
    const output = generatePlatformTemplate();
    expect(output).toContain('import { definePlatform }');
    expect(output).toContain("org: 'myorg'");
    expect(output).toContain("region: 'us-east-1'");
    expect(output).toContain("preset: 'ecs'");
  });

  it('uses custom org and region', () => {
    const output = generatePlatformTemplate({ org: 'acme', region: 'eu-west-1' });
    expect(output).toContain("org: 'acme'");
    expect(output).toContain("region: 'eu-west-1'");
  });

  it('generates dev stage with domainSuffix', () => {
    const output = generatePlatformTemplate({ stages: ['dev'] });
    expect(output).toContain('domainSuffix');
    expect(output).toContain('development');
  });

  it('generates prod stage with scaling config', () => {
    const output = generatePlatformTemplate({ stages: ['prod'] });
    expect(output).toContain('scaling');
    expect(output).toContain('production');
  });

  it('generates custom stages with generic template', () => {
    const output = generatePlatformTemplate({ stages: ['staging'] });
    expect(output).toContain("NODE_ENV: 'staging'");
  });

  it('populates resources block when provided', () => {
    const output = generatePlatformTemplate({ resources: ['postgres', 'redis'] });
    expect(output).toContain('postgres');
    expect(output).toContain('redis');
    expect(output).toContain('provision: false');
  });

  it('comments out resources block when empty', () => {
    const output = generatePlatformTemplate({ resources: [] });
    expect(output).toContain('// resources:');
  });
});

// ---------------------------------------------------------------------------
// generateInfraTemplate
// ---------------------------------------------------------------------------

describe('generateInfraTemplate', () => {
  it('generates valid TypeScript with defaults', () => {
    const output = generateInfraTemplate();
    expect(output).toContain('import { defineInfra }');
    expect(output).toContain("stacks: ['main']");
    expect(output).toContain('port: 3000');
  });

  it('uses custom stacks and port', () => {
    const output = generateInfraTemplate({ stacks: ['api', 'workers'], port: 8080 });
    expect(output).toContain("'api'");
    expect(output).toContain("'workers'");
    expect(output).toContain('port: 8080');
  });
});

// ---------------------------------------------------------------------------
// parseSstOutputs
// ---------------------------------------------------------------------------

describe('parseSstOutputs', () => {
  it('parses JSON output with "outputs" key', () => {
    const raw = `Some preamble\n${JSON.stringify({ outputs: { dbHost: 'rds.example.com', dbPort: '5432' } })}\nDone.`;
    const result = parseSstOutputs(raw);
    expect(result.dbHost).toBe('rds.example.com');
    expect(result.dbPort).toBe('5432');
  });

  it('parses line-based key = value format', () => {
    const raw = `  dbHost = rds.example.com\n  dbPort = 5432\n`;
    const result = parseSstOutputs(raw);
    expect(result.dbHost).toBe('rds.example.com');
    expect(result.dbPort).toBe('5432');
  });

  it('falls back to line-based when JSON is invalid', () => {
    const raw = `not json { "outputs": invalid }\ndbHost = fallback.host\n`;
    const result = parseSstOutputs(raw);
    expect(result.dbHost).toBe('fallback.host');
  });

  it('returns empty object when no outputs found', () => {
    const result = parseSstOutputs('No output here.');
    expect(result).toEqual({});
  });

  it('converts non-string JSON values to strings', () => {
    const raw = JSON.stringify({ outputs: { port: 5432, enabled: true } });
    const result = parseSstOutputs(raw);
    expect(result.port).toBe('5432');
    expect(result.enabled).toBe('true');
  });
});
