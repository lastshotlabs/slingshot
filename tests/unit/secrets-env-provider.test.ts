import { createEnvSecretRepository } from '@framework/secrets/providers/envProvider';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

describe('createEnvSecretRepository', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.TEST_SECRET = process.env.TEST_SECRET;
    savedEnv.TEST_OTHER = process.env.TEST_OTHER;
    savedEnv.MYAPP_DB_HOST = process.env.MYAPP_DB_HOST;

    process.env.TEST_SECRET = 's3cret';
    process.env.TEST_OTHER = 'other-val';
    process.env.MYAPP_DB_HOST = 'localhost:5432';
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  test('get returns env var value', async () => {
    const provider = createEnvSecretRepository();
    expect(await provider.get('TEST_SECRET')).toBe('s3cret');
  });

  test('get returns null for missing key', async () => {
    const provider = createEnvSecretRepository();
    expect(await provider.get('NONEXISTENT_KEY_XYZ')).toBeNull();
  });

  test('getMany returns map of found keys', async () => {
    const provider = createEnvSecretRepository();
    const result = await provider.getMany(['TEST_SECRET', 'TEST_OTHER', 'MISSING_KEY']);

    expect(result.get('TEST_SECRET')).toBe('s3cret');
    expect(result.get('TEST_OTHER')).toBe('other-val');
    expect(result.has('MISSING_KEY')).toBe(false);
  });

  test('prefix is prepended to key lookups', async () => {
    const provider = createEnvSecretRepository({ prefix: 'MYAPP_' });
    expect(await provider.get('DB_HOST')).toBe('localhost:5432');
    expect(await provider.get('TEST_SECRET')).toBeNull();
  });

  test('prefix works with getMany', async () => {
    const provider = createEnvSecretRepository({ prefix: 'MYAPP_' });
    const result = await provider.getMany(['DB_HOST', 'NOPE']);
    expect(result.get('DB_HOST')).toBe('localhost:5432');
    expect(result.has('NOPE')).toBe(false);
  });

  test("provider name is 'env'", () => {
    const provider = createEnvSecretRepository();
    expect(provider.name).toBe('env');
  });
});
