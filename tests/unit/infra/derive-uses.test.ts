import { describe, expect, it } from 'bun:test';
import {
  compareInfraResources,
  deriveUsesFromAppConfig,
} from '../../../packages/slingshot-infra/src/config/deriveUsesFromApp';

describe('deriveUsesFromAppConfig', () => {
  it('returns empty array for empty config', () => {
    expect(deriveUsesFromAppConfig({})).toEqual([]);
  });

  it('returns empty array for config with empty db', () => {
    expect(deriveUsesFromAppConfig({ db: {} })).toEqual([]);
  });

  it('detects redis when db.redis is true', () => {
    const result = deriveUsesFromAppConfig({ db: { redis: true } });
    expect(result).toContain('redis');
  });

  it('does not include redis when db.redis is false', () => {
    const result = deriveUsesFromAppConfig({ db: { redis: false } });
    expect(result).not.toContain('redis');
  });

  it('detects mongo when db.mongo is "single"', () => {
    const result = deriveUsesFromAppConfig({ db: { mongo: 'single' } });
    expect(result).toContain('mongo');
  });

  it('detects mongo when db.mongo is "separate"', () => {
    const result = deriveUsesFromAppConfig({ db: { mongo: 'separate' } });
    expect(result).toContain('mongo');
  });

  it('does not include mongo when db.mongo is false', () => {
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

  it('detects postgres when db.cache is "postgres"', () => {
    const result = deriveUsesFromAppConfig({ db: { cache: 'postgres' } });
    expect(result).toContain('postgres');
  });

  it('detects postgres when db.oauthState is "postgres"', () => {
    const result = deriveUsesFromAppConfig({ db: { oauthState: 'postgres' } });
    expect(result).toContain('postgres');
  });

  it('detects redis from jobs config', () => {
    const result = deriveUsesFromAppConfig({ jobs: { statusEndpoint: true } });
    expect(result).toContain('redis');
  });

  it('detects multiple resources and deduplicates', () => {
    const result = deriveUsesFromAppConfig({
      db: {
        redis: true,
        mongo: 'single',
        sessions: 'postgres',
      },
      jobs: { statusEndpoint: true }, // also implies redis
    });

    expect(result).toContain('redis');
    expect(result).toContain('mongo');
    expect(result).toContain('postgres');
    // redis should only appear once even though both db.redis and jobs imply it
    expect(result.filter(r => r === 'redis')).toHaveLength(1);
  });

  it('handles config with no db key gracefully', () => {
    const result = deriveUsesFromAppConfig({ routesDir: '/routes', meta: { name: 'test' } });
    expect(result).toEqual([]);
  });

  it('handles jobs without db still detecting redis', () => {
    const result = deriveUsesFromAppConfig({ jobs: {} });
    expect(result).toContain('redis');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for compareInfraResources
// ---------------------------------------------------------------------------

describe('compareInfraResources', () => {
  it('returns no diagnostics when everything is consistent', () => {
    const result = compareInfraResources({
      infraUses: ['postgres', 'redis'],
      platformResources: ['postgres', 'redis'],
      derivedUses: ['postgres', 'redis'],
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.infos).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
  });

  it('warns when uses declares a resource not in platform', () => {
    const result = compareInfraResources({
      infraUses: ['postgres', 'kafka'],
      platformResources: ['postgres'],
      derivedUses: [],
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].resource).toBe('kafka');
    expect(result.warnings[0].message).toContain('kafka');
    expect(result.warnings[0].message).toContain('not defined in platform');
  });

  it('reports info for unused platform resources', () => {
    const result = compareInfraResources({
      infraUses: ['postgres'],
      platformResources: ['postgres', 'redis', 'kafka'],
      derivedUses: [],
    });

    expect(result.infos).toHaveLength(2);
    const resources = result.infos.map(i => i.resource);
    expect(resources).toContain('redis');
    expect(resources).toContain('kafka');
  });

  it('suggests resources derived from app config but missing from uses', () => {
    const result = compareInfraResources({
      infraUses: ['postgres'],
      platformResources: ['postgres', 'redis'],
      derivedUses: ['postgres', 'redis'],
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].resource).toBe('redis');
    expect(result.suggestions[0].message).toContain('detected in app config');
  });

  it('handles empty inputs gracefully', () => {
    const result = compareInfraResources({
      infraUses: [],
      platformResources: [],
      derivedUses: [],
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.infos).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
  });

  it('handles all diagnostics at once', () => {
    const result = compareInfraResources({
      infraUses: ['postgres', 'meilisearch'],
      platformResources: ['postgres', 'redis'],
      derivedUses: ['postgres', 'redis'],
    });

    // meilisearch in uses but not in platform -> warning
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].resource).toBe('meilisearch');

    // redis in platform but not in uses -> info
    expect(result.infos).toHaveLength(1);
    expect(result.infos[0].resource).toBe('redis');

    // redis derived but not in uses -> suggestion
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].resource).toBe('redis');
  });
});
