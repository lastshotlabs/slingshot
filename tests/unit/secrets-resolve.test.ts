import { resolveSecretBundle, resolveSecretRepoFromInput } from '@framework/secrets';
import { resolveSecrets } from '@framework/secrets/resolveSecrets';
import { describe, expect, test } from 'bun:test';
import type { SecretRepository, SecretSchema } from '@lastshotlabs/slingshot-core';

function createMockProvider(secrets: Record<string, string>): SecretRepository {
  let initCalled = false;

  return {
    name: 'mock',

    async initialize() {
      initCalled = true;
    },

    async get(key) {
      return secrets[key] ?? null;
    },

    async getMany(keys) {
      const result = new Map<string, string>();
      for (const key of keys) {
        if (key in secrets) result.set(key, secrets[key]);
      }
      return result;
    },
  };
}

describe('resolveSecrets', () => {
  test('resolves all secrets from schema', async () => {
    const provider = createMockProvider({
      JWT_SECRET: 'my-jwt-secret',
      REDIS_HOST: 'localhost:6379',
    });

    const schema = {
      jwtSecret: { path: 'JWT_SECRET', required: false },
      redisHost: { path: 'REDIS_HOST', required: false },
    } as const satisfies SecretSchema;

    const result = await resolveSecrets(provider, schema);
    expect(result.jwtSecret).toBe('my-jwt-secret');
    expect(result.redisHost).toBe('localhost:6379');
  });

  test('applies default when secret is missing and not required', async () => {
    const provider = createMockProvider({});

    const schema = {
      apiKey: { path: 'API_KEY', required: false, default: 'default-key' },
    } as const satisfies SecretSchema;

    const result = await resolveSecrets(provider, schema);
    expect(result.apiKey).toBe('default-key');
  });

  test('returns undefined for optional missing secrets without default', async () => {
    const provider = createMockProvider({});

    const schema = {
      optional: { path: 'OPTIONAL_KEY', required: false },
    } as const satisfies SecretSchema;

    const result = await resolveSecrets(provider, schema);
    expect(result.optional).toBeUndefined();
  });

  test('throws for missing required secrets', async () => {
    const provider = createMockProvider({});

    const schema = {
      dbPassword: { path: 'DB_PASSWORD' },
    } as const satisfies SecretSchema;

    expect(resolveSecrets(provider, schema)).rejects.toThrow(
      'Missing required secrets: "dbPassword" (path: DB_PASSWORD)',
    );
  });

  test('throws listing all missing required secrets', async () => {
    const provider = createMockProvider({});

    const schema = {
      a: { path: 'A' },
      b: { path: 'B' },
      c: { path: 'C', required: false },
    } as const satisfies SecretSchema;

    expect(resolveSecrets(provider, schema)).rejects.toThrow('"a" (path: A)');
  });

  test('result object is frozen', async () => {
    const provider = createMockProvider({ KEY: 'val' });
    const schema = { key: { path: 'KEY', required: false } } as const satisfies SecretSchema;

    const result = await resolveSecrets(provider, schema);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('calls initialize on provider', async () => {
    let initCalled = false;
    const provider: SecretRepository = {
      name: 'test',
      async initialize() {
        initCalled = true;
      },
      async get() {
        return null;
      },
      async getMany() {
        return new Map();
      },
    };

    const schema = { x: { path: 'X', required: false } } as const satisfies SecretSchema;
    await resolveSecrets(provider, schema);
    expect(initCalled).toBe(true);
  });

  test('works with provider that has no initialize', async () => {
    const provider: SecretRepository = {
      name: 'bare',
      async get(key) {
        return key === 'K' ? 'v' : null;
      },
      async getMany(keys) {
        const m = new Map<string, string>();
        if (keys.includes('K')) m.set('K', 'v');
        return m;
      },
    };

    const schema = { k: { path: 'K', required: false } } as const satisfies SecretSchema;
    const result = await resolveSecrets(provider, schema);
    expect(result.k).toBe('v');
  });

  test('resolveSecretRepoFromInput accepts a FrameworkSecretsLiteral plain object', async () => {
    const provider = await resolveSecretRepoFromInput({
      JWT_SECRET: 'literal-jwt',
      REDIS_HOST: 'localhost',
    });
    expect(provider.name).toBe('literal');
    expect(await provider.get('JWT_SECRET')).toBe('literal-jwt');
    expect(await provider.get('REDIS_HOST')).toBe('localhost');
    expect(await provider.get('MISSING_KEY')).toBeNull();
  });

  test('resolveSecretRepoFromInput FrameworkSecretsLiteral getMany returns only present keys', async () => {
    const provider = await resolveSecretRepoFromInput({ JWT_SECRET: 'jwt-val' });
    const result = await provider.getMany(['JWT_SECRET', 'ABSENT']);
    expect(result.get('JWT_SECRET')).toBe('jwt-val');
    expect(result.has('ABSENT')).toBe(false);
  });

  test('resolveSecretRepoFromInput uses the configured factory map', async () => {
    process.env.SLINGSHOT_TEST_SECRET = 'factory-secret';
    try {
      const provider = await resolveSecretRepoFromInput({
        provider: 'env',
        prefix: 'SLINGSHOT_TEST_',
      });
      expect(provider.name).toBe('env');
      expect(await provider.get('SECRET')).toBe('factory-secret');
    } finally {
      delete process.env.SLINGSHOT_TEST_SECRET;
    }
  });

  test('resolveSecretBundle resolves framework and app schema together', async () => {
    const provider = createMockProvider({
      JWT_SECRET: 'jwt-from-provider',
      REDIS_HOST: 'localhost:6379',
      APP_PRIVATE_KEY: 'app-private-key',
    });

    const bundle = await resolveSecretBundle({
      provider,
      schema: {
        appPrivateKey: { path: 'APP_PRIVATE_KEY' },
      },
    } as const);

    expect(bundle.framework.jwtSecret).toBe('jwt-from-provider');
    expect(bundle.framework.redisHost).toBe('localhost:6379');
    expect((bundle.app as any)?.appPrivateKey).toBe('app-private-key');
    expect(bundle.merged.jwtSecret).toBe('jwt-from-provider');
    expect((bundle.merged as any).appPrivateKey).toBe('app-private-key');
    expect(Object.isFrozen(bundle.framework)).toBe(true);
    expect(Object.isFrozen(bundle.app)).toBe(true);
    expect(Object.isFrozen(bundle.merged)).toBe(true);
  });
});
