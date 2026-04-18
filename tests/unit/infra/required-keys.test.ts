import { describe, expect, it } from 'bun:test';
import { resolveRequiredKeys } from '../../../packages/slingshot-infra/src/secrets/resolveRequiredKeys';

describe('resolveRequiredKeys', () => {
  it('app using postgres gets DATABASE_URL, PGHOST, etc.', () => {
    const keys = resolveRequiredKeys({ uses: ['postgres'] });

    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('PGHOST');
    expect(keys).toContain('PGPORT');
    expect(keys).toContain('PGUSER');
    expect(keys).toContain('PGPASSWORD');
    expect(keys).toContain('PGDATABASE');
  });

  it('app using redis gets REDIS_HOST, REDIS_USER, REDIS_PASSWORD', () => {
    const keys = resolveRequiredKeys({ uses: ['redis'] });

    expect(keys).toContain('REDIS_HOST');
    expect(keys).toContain('REDIS_USER');
    expect(keys).toContain('REDIS_PASSWORD');
  });

  it('app using kafka gets KAFKA_BROKERS', () => {
    const keys = resolveRequiredKeys({ uses: ['kafka'] });

    expect(keys).toContain('KAFKA_BROKERS');
  });

  it('always includes JWT_SECRET and DATA_ENCRYPTION_KEY', () => {
    const keys = resolveRequiredKeys({});

    expect(keys).toContain('JWT_SECRET');
    expect(keys).toContain('DATA_ENCRYPTION_KEY');
  });

  it('multi-service with different uses deduplicates', () => {
    const keys = resolveRequiredKeys({
      uses: ['postgres'],
      services: {
        api: { uses: ['postgres', 'redis'] },
        worker: { uses: ['redis', 'kafka'] },
      },
    });

    // Postgres keys should appear only once
    const pgCount = keys.filter(k => k === 'DATABASE_URL').length;
    expect(pgCount).toBe(1);

    // Redis keys should appear only once
    const redisCount = keys.filter(k => k === 'REDIS_HOST').length;
    expect(redisCount).toBe(1);

    // All resource types should be present
    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('REDIS_HOST');
    expect(keys).toContain('KAFKA_BROKERS');
    expect(keys).toContain('JWT_SECRET');
    expect(keys).toContain('DATA_ENCRYPTION_KEY');
  });

  it('multiple uses at app level deduplicates', () => {
    const keys = resolveRequiredKeys({ uses: ['postgres', 'redis'] });

    // No duplicates
    const unique = [...new Set(keys)];
    expect(keys.length).toBe(unique.length);
  });

  it('unknown resource type is silently ignored', () => {
    const keys = resolveRequiredKeys({ uses: ['unknown-resource'] });

    // Only JWT_SECRET and DATA_ENCRYPTION_KEY
    expect(keys).toEqual(['JWT_SECRET', 'DATA_ENCRYPTION_KEY']);
  });

  it('services without uses contribute nothing extra', () => {
    const keys = resolveRequiredKeys({
      services: {
        api: {},
        worker: {},
      },
    });

    expect(keys).toEqual(['JWT_SECRET', 'DATA_ENCRYPTION_KEY']);
  });

  it('combines top-level uses with service-level uses', () => {
    const keys = resolveRequiredKeys({
      uses: ['postgres'],
      services: {
        worker: { uses: ['kafka'] },
      },
    });

    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('KAFKA_BROKERS');
    expect(keys).toContain('JWT_SECRET');
  });
});
