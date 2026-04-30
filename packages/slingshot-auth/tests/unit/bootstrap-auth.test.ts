import { afterEach, describe, expect, test } from 'bun:test';
import { bootstrapAuth } from '../../src/bootstrap';
import type { AuthPluginConfig } from '../../src/types/config';
import { makeEventBus, makeEvents } from '../helpers/runtime';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

function runtimeInfra() {
  return {
    signing: { secret: 'test-signing-secret-32-chars-ok!' },
    dataEncryptionKeys: [],
    password: Bun.password,
  };
}

describe('bootstrapAuth standalone defaults', () => {
  test('uses memory auth store when no database is configured', async () => {
    const bus = makeEventBus();
    const result = await bootstrapAuth(
      {} as AuthPluginConfig,
      bus,
      makeEvents(() => bus),
      undefined,
      runtimeInfra(),
    );

    expect(result.stores.authStore).toBe('memory');
    expect(result.stores.sessions).toBe('memory');

    for (const teardown of result.teardownFns) {
      await teardown();
    }
  });
});

describe('bootstrapAuth OIDC production safety', () => {
  test('requires an explicit OIDC signing key in production', async () => {
    process.env.NODE_ENV = 'production';
    const bus = makeEventBus();

    await expect(
      bootstrapAuth(
        {
          auth: {
            oidc: {
              issuer: 'https://issuer.example.com',
            },
          },
        } as AuthPluginConfig,
        bus,
        makeEvents(() => bus),
        undefined,
        runtimeInfra(),
      ),
    ).rejects.toThrow('auth.oidc.signingKey is required in production');
  });
});
