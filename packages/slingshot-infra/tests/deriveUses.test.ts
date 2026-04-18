import { describe, expect, it } from 'bun:test';
import { compareInfraResources, deriveUsesFromAppConfig } from '../src/config/deriveUsesFromApp';

// ---------------------------------------------------------------------------
// deriveUsesFromAppConfig
// ---------------------------------------------------------------------------

describe('deriveUsesFromAppConfig', () => {
  it('returns empty array for empty config', () => {
    expect(deriveUsesFromAppConfig({})).toEqual([]);
  });

  it('detects redis when db.redis is truthy', () => {
    const result = deriveUsesFromAppConfig({ db: { redis: true } });
    expect(result).toContain('redis');
  });

  it('does not detect redis when db.redis is false', () => {
    const result = deriveUsesFromAppConfig({ db: { redis: false } });
    expect(result).not.toContain('redis');
  });

  it('does not detect redis when db.redis is undefined', () => {
    const result = deriveUsesFromAppConfig({ db: {} });
    expect(result).not.toContain('redis');
  });

  it('detects mongo when db.mongo is truthy', () => {
    const result = deriveUsesFromAppConfig({ db: { mongo: 'single' } });
    expect(result).toContain('mongo');
  });

  it('does not detect mongo when db.mongo is false', () => {
    const result = deriveUsesFromAppConfig({ db: { mongo: false } });
    expect(result).not.toContain('mongo');
  });

  it('detects postgres when db.sessions is "postgres"', () => {
    const result = deriveUsesFromAppConfig({ db: { sessions: 'postgres' } });
    expect(result).toContain('postgres');
  });

  it('detects postgres when db.auth is "postgres"', () => {
    const result = deriveUsesFromAppConfig({ db: { auth: 'postgres' } });
    expect(result).toContain('postgres');
  });

  it('does not detect postgres for non-postgres store values', () => {
    const result = deriveUsesFromAppConfig({ db: { sessions: 'redis', cache: 'memory' } });
    expect(result).not.toContain('postgres');
  });

  it('detects redis when jobs is configured', () => {
    const result = deriveUsesFromAppConfig({ jobs: { workers: 2 } });
    expect(result).toContain('redis');
  });

  it('detects redis when ssr.isr.adapter is "redis"', () => {
    const result = deriveUsesFromAppConfig({ ssr: { isr: { adapter: 'redis' } } });
    expect(result).toContain('redis');
  });

  it('detects redis when ssr.isr.adapter is an object (handler ref)', () => {
    const result = deriveUsesFromAppConfig({
      ssr: { isr: { adapter: { handler: 'redis-isr-adapter' } } },
    });
    expect(result).toContain('redis');
  });

  it('does not detect redis when ssr.isr.adapter is "memory"', () => {
    const result = deriveUsesFromAppConfig({ ssr: { isr: { adapter: 'memory' } } });
    expect(result).not.toContain('redis');
  });

  it('deduplicates redis from multiple sources', () => {
    const result = deriveUsesFromAppConfig({
      db: { redis: true },
      jobs: { workers: 1 },
      ssr: { isr: { adapter: 'redis' } },
    });
    const redisCount = result.filter(r => r === 'redis').length;
    expect(redisCount).toBe(1);
  });

  it('detects multiple resources simultaneously', () => {
    const result = deriveUsesFromAppConfig({
      db: { redis: true, mongo: 'single', sessions: 'postgres' },
    });
    expect(result).toContain('redis');
    expect(result).toContain('mongo');
    expect(result).toContain('postgres');
    expect(result).toHaveLength(3);
  });

  it('never throws on unknown shapes', () => {
    expect(() => deriveUsesFromAppConfig({ foo: 'bar', db: 42 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// compareInfraResources
// ---------------------------------------------------------------------------

describe('compareInfraResources', () => {
  it('returns empty diagnostics when everything matches', () => {
    const result = compareInfraResources({
      infraUses: ['postgres'],
      platformResources: ['postgres'],
      derivedUses: ['postgres'],
    });
    expect(result.warnings).toHaveLength(0);
    expect(result.infos).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
  });

  it('warns when uses references a resource not in platform', () => {
    const result = compareInfraResources({
      infraUses: ['redis'],
      platformResources: [],
      derivedUses: [],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].resource).toBe('redis');
    expect(result.warnings[0].message).toContain('not defined in platform');
  });

  it('reports info when platform has unused resources', () => {
    const result = compareInfraResources({
      infraUses: [],
      platformResources: ['kafka'],
      derivedUses: [],
    });
    expect(result.infos).toHaveLength(1);
    expect(result.infos[0].resource).toBe('kafka');
    expect(result.infos[0].message).toContain('not referenced in uses');
  });

  it('suggests when derived uses are missing from explicit uses', () => {
    const result = compareInfraResources({
      infraUses: [],
      platformResources: [],
      derivedUses: ['redis'],
    });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].resource).toBe('redis');
    expect(result.suggestions[0].message).toContain('detected in app config');
  });

  it('does not suggest resources already in uses', () => {
    const result = compareInfraResources({
      infraUses: ['redis'],
      platformResources: ['redis'],
      derivedUses: ['redis'],
    });
    expect(result.suggestions).toHaveLength(0);
  });
});
