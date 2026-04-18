import { describe, expect, test } from 'bun:test';
import { deriveRequiredSecrets } from '../../src/framework/secrets/deriveRequiredSecrets';

describe('deriveRequiredSecrets', () => {
  test('requires legacy mongo and redis secrets when db config is empty', () => {
    const result = deriveRequiredSecrets({});

    expect(result.required).toEqual([
      'JWT_SECRET',
      'SLINGSHOT_DATA_ENCRYPTION_KEY',
      'REDIS_HOST',
      'MONGO_USER',
      'MONGO_PASSWORD',
      'MONGO_HOST',
      'MONGO_DB',
    ]);
    expect(result.optional).toEqual(['REDIS_USER', 'REDIS_PASSWORD']);
  });

  test('does not require mongo secrets for sqlite auth manifests that omit db.mongo', () => {
    const result = deriveRequiredSecrets({
      sqlite: './content.db',
      redis: false,
      sessions: 'sqlite',
      auth: 'sqlite',
    });

    expect(result.required).not.toContain('MONGO_USER');
    expect(result.required).not.toContain('MONGO_PASSWORD');
    expect(result.required).not.toContain('MONGO_HOST');
    expect(result.required).not.toContain('MONGO_DB');
  });

  test('does not require redis secrets when redis is disabled', () => {
    const result = deriveRequiredSecrets({
      sqlite: './app.db',
      redis: false,
      sessions: 'sqlite',
      cache: 'sqlite',
      auth: 'sqlite',
    });

    expect(result.required).not.toContain('REDIS_HOST');
    expect(result.optional).toEqual([]);
  });

  test('requires postgres apps to provide only redis secrets by default', () => {
    const result = deriveRequiredSecrets({
      postgres: 'postgres://user:pass@localhost:5432/app',
    } as Parameters<typeof deriveRequiredSecrets>[0] & { postgres: string });

    expect(result.required).toContain('REDIS_HOST');
    expect(result.required).not.toContain('MONGO_USER');
    expect(result.required).not.toContain('MONGO_PASSWORD');
    expect(result.required).not.toContain('MONGO_HOST');
    expect(result.required).not.toContain('MONGO_DB');
  });

  test('still requires mongo secrets when sqlite apps explicitly select mongo', () => {
    const result = deriveRequiredSecrets({
      sqlite: './mixed.db',
      redis: false,
      mongo: 'single',
      sessions: 'sqlite',
      auth: 'mongo',
    });

    expect(result.required).toContain('MONGO_USER');
    expect(result.required).toContain('MONGO_PASSWORD');
    expect(result.required).toContain('MONGO_HOST');
    expect(result.required).toContain('MONGO_DB');
  });

  test('requires separate mongo app and auth secret sets', () => {
    const result = deriveRequiredSecrets({
      mongo: 'separate',
      redis: false,
    });

    expect(result.required).toEqual([
      'JWT_SECRET',
      'SLINGSHOT_DATA_ENCRYPTION_KEY',
      'MONGO_USER',
      'MONGO_PASSWORD',
      'MONGO_HOST',
      'MONGO_DB',
      'MONGO_AUTH_USER',
      'MONGO_AUTH_PASSWORD',
      'MONGO_AUTH_HOST',
      'MONGO_AUTH_DB',
    ]);
  });
});
